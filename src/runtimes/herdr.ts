// Owned Herdr transport. Radian creates fresh panes by splitting an explicit
// parent pane with --no-focus, records the returned pane IDs, and only ever runs
// commands in or closes panes it recorded. It never derives IDs from layout or
// acts on the UI-focused pane. A command whose delivery is uncertain (timeout)
// is never resent; binding evidence decides what happened. Pane state is
// display/diagnostic data — idle is not authentication, binding, completion, or
// termination evidence.

import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { type Clock, iso, systemClock } from "../util/clock.ts";
import { resolveExecutable, run } from "../util/proc.ts";
import { atomicWriteJson, readJsonIfExists, withLock } from "../state/fsutil.ts";

export interface HerdrCall {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type HerdrRunner = (args: readonly string[], timeoutMs: number) => Promise<HerdrCall>;

export function systemHerdrRunner(herdrPath: string, env: Record<string, string>): HerdrRunner {
  return async (args, timeoutMs) => {
    const result = await run(herdrPath, args, { env, timeoutMs });
    return { code: result.code, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8"), timedOut: result.timedOut };
  };
}

/** Herdr connection environment inherited from the coordinator's own pane. */
export function herdrEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" };
  if (source.HOME) env.HOME = source.HOME;
  for (const [key, value] of Object.entries(source)) if (key.startsWith("HERDR_") && value !== undefined) env[key] = value;
  return env;
}

export function locateHerdr(): string | undefined {
  return resolveExecutable("herdr", process.env.PATH);
}

export interface OwnedPane {
  paneId: string;
  assignment: string;
  attempt: string;
  parent: string;
  createdAt: string;
  state: "open" | "closed" | "unknown";
}

interface PaneLedger {
  schema: "radian.panes/1";
  panes: OwnedPane[];
}

const PANE_ID = /^[A-Za-z0-9:_.-]{1,128}$/;

/** POSIX single-quote each argument; refuse control characters outright. */
export function shellCommand(argv: readonly string[]): Outcome<string> {
  const parts: string[] = [];
  for (const arg of argv) {
    if (/[\0-\x1f\x7f]/.test(arg)) return refuse("PATH_INVALID", "pane command arguments must not contain control characters");
    parts.push(`'${arg.replace(/'/g, `'"'"'`)}'`);
  }
  return success(parts.join(" "));
}

export function parseCreatedPane(stdout: string): string | undefined {
  try {
    const data = JSON.parse(stdout) as { result?: { pane?: { pane_id?: unknown } } };
    const id = data.result?.pane?.pane_id;
    return typeof id === "string" && PANE_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

export class HerdrTransport {
  private readonly runner: HerdrRunner;
  private readonly ledgerFile: string;
  private readonly clock: Clock;
  private readonly timeoutMs: number;

  constructor(options: { runner: HerdrRunner; stateDir: string; clock?: Clock; timeoutMs?: number }) {
    this.runner = options.runner;
    this.ledgerFile = path.join(options.stateDir, "panes.json");
    this.clock = options.clock ?? systemClock;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private locked<T>(fn: (ledger: PaneLedger) => T): Promise<T> {
    return withLock(this.ledgerFile + ".lock", "pane ledger", () => {
      const read = readJsonIfExists(this.ledgerFile);
      const ledger: PaneLedger = read.state === "ok" ? (read.value as PaneLedger) : { schema: "radian.panes/1", panes: [] };
      return fn(ledger);
    });
  }

  async owned(paneId: string): Promise<OwnedPane | undefined> {
    return this.locked((ledger) => ledger.panes.find((p) => p.paneId === paneId && p.state !== "closed"));
  }

  /** Create a fresh pane next to an explicit parent, without taking focus. */
  async createPane(input: { assignment: string; attempt: string; parentPane: string; cwd: string }): Promise<Outcome<OwnedPane>> {
    if (!PANE_ID.test(input.parentPane)) return refuse("TRANSPORT_FAILURE", "parent pane id is invalid");
    const call = await this.runner(["pane", "split", "--pane", input.parentPane, "--direction", "right", "--cwd", input.cwd, "--no-focus"], this.timeoutMs);
    if (call.timedOut) return refuse("TRANSPORT_FAILURE", "pane creation timed out; any created pane is unowned and left untouched", "Inspect Herdr manually; Radian does not guess pane identities.");
    if (call.code !== 0) return refuse("TRANSPORT_FAILURE", "Herdr refused pane creation");
    const paneId = parseCreatedPane(call.stdout);
    if (!paneId) return refuse("TRANSPORT_FAILURE", "Herdr did not return a pane id");
    const pane: OwnedPane = { paneId, assignment: input.assignment, attempt: input.attempt, parent: input.parentPane, createdAt: iso(this.clock.now()), state: "open" };
    await this.locked((ledger) => {
      ledger.panes.push(pane);
      atomicWriteJson(this.ledgerFile, ledger);
    });
    return success(pane);
  }

  /**
   * Type the launcher command into an owned pane. "uncertain" means the command
   * may or may not have been delivered; callers must not resend it.
   */
  async runInPane(paneId: string, argv: readonly string[]): Promise<Outcome<"sent" | "uncertain">> {
    const pane = await this.owned(paneId);
    if (!pane) return refuse("OWNERSHIP_AMBIGUOUS", "pane is not owned by Radian");
    const command = shellCommand(argv);
    if (!command.ok) return command;
    const call = await this.runner(["pane", "run", paneId, command.value], this.timeoutMs);
    if (call.timedOut) return success("uncertain");
    if (call.code !== 0) return refuse("TRANSPORT_FAILURE", "Herdr refused to run the launcher in the owned pane");
    return success("sent");
  }

  /** Close an owned pane only after its execution was verifiably terminated. */
  async closePane(paneId: string, termination: "verified" | "unknown"): Promise<Outcome<true>> {
    if (termination !== "verified") return refuse("TERMINATION_UNVERIFIED", "a pane is closed only after verified termination; it stays open for inspection");
    const pane = await this.owned(paneId);
    if (!pane) return refuse("OWNERSHIP_AMBIGUOUS", "pane is not owned by Radian");
    const call = await this.runner(["pane", "close", paneId], this.timeoutMs);
    const closed = call.code === 0 && !call.timedOut;
    await this.locked((ledger) => {
      const entry = ledger.panes.find((p) => p.paneId === paneId);
      if (entry) entry.state = closed ? "closed" : "unknown";
      atomicWriteJson(this.ledgerFile, ledger);
    });
    return closed ? success(true) : refuse("TRANSPORT_FAILURE", "pane close was not confirmed");
  }
}
