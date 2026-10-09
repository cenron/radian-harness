import { execFile } from "node:child_process";
import { RadianError } from "../core/errors.ts";
import type { Runtime } from "../core/constants.ts";

export interface HerdrResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Runs one herdr command. Injected so tests can stand in for Herdr. */
export type HerdrRunner = (args: readonly string[]) => Promise<HerdrResult>;

export interface PaneInfo {
  /** Herdr's view of the agent in the pane: idle, working, blocked, done, or unknown. */
  agentStatus: string;
}

// Claude Code and Codex can take a while to show their prompt on first start.
const AGENT_START_TIMEOUT_MS = 120_000;
const AGENT_NOT_READY = "agent_not_ready";

export function createHerdrRunner(executable = "herdr"): HerdrRunner {
  return (args) =>
    new Promise((resolve) => {
      execFile(executable, args, { encoding: "utf8" }, (error, stdout, stderr) => {
        const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ stdout, stderr: stderr || (error?.message ?? ""), exitCode });
      });
    });
}

export async function splitPane(
  run: HerdrRunner,
  input: { from: string; direction: "right" | "down"; cwd: string; blankedEnv: readonly string[] },
): Promise<string> {
  const envFlags = input.blankedEnv.flatMap((key) => ["--env", `${key}=`]);
  const args = [
    "pane",
    "split",
    input.from,
    "--direction",
    input.direction,
    "--cwd",
    input.cwd,
    "--no-focus",
  ];
  return parseCreatedPane(await runChecked(run, [...args, ...envFlags]));
}

export async function renamePane(run: HerdrRunner, pane: string, label: string): Promise<void> {
  await runChecked(run, ["pane", "rename", pane, label]);
}

/**
 * Herdr returns once the agent is ready for input. "waiting" means the agent stopped at a
 * startup prompt, such as Claude Code asking to trust the new worktree; the user answers it.
 */
export async function startAgent(
  run: HerdrRunner,
  input: { name: string; kind: Runtime; pane: string; args: readonly string[] },
): Promise<"ready" | "waiting"> {
  const result = await run([
    "agent",
    "start",
    input.name,
    "--kind",
    input.kind,
    "--pane",
    input.pane,
    "--timeout",
    String(AGENT_START_TIMEOUT_MS),
    "--",
    ...input.args,
  ]);
  if (result.exitCode === 0) return "ready";
  if (`${result.stdout}${result.stderr}`.includes(AGENT_NOT_READY)) return "waiting";
  throw new RadianError("herdr_failed", `herdr agent start failed: ${failureDetail(result)}`);
}

/** Targets the pane: Herdr can drop an agent's name when the agent restarts after a prompt. */
export async function promptAgent(run: HerdrRunner, pane: string, text: string): Promise<void> {
  await runChecked(run, ["agent", "prompt", pane, text]);
}

export async function readPaneText(run: HerdrRunner, pane: string): Promise<string> {
  return runChecked(run, ["pane", "read", pane, "--source", "visible"]);
}

/** Undefined when the pane no longer exists. */
export async function getPane(run: HerdrRunner, pane: string): Promise<PaneInfo | undefined> {
  const result = await run(["pane", "get", pane]);
  if (result.exitCode !== 0) return undefined;
  const data = parseJson(result.stdout) as { result?: { pane?: { agent_status?: string } } };
  return { agentStatus: data?.result?.pane?.agent_status ?? "unknown" };
}

export async function closePane(run: HerdrRunner, pane: string): Promise<void> {
  await runChecked(run, ["pane", "close", pane]);
}

export function parseCreatedPane(stdout: string): string {
  const data = parseJson(stdout) as { result?: { pane?: { pane_id?: unknown } } } | undefined;
  const paneId = data?.result?.pane?.pane_id;
  if (typeof paneId !== "string" || paneId.length === 0) {
    throw new RadianError("herdr_output", `Herdr did not report the new pane id: ${stdout.trim()}`);
  }
  return paneId;
}

async function runChecked(run: HerdrRunner, args: readonly string[]): Promise<string> {
  const result = await run(args);
  if (result.exitCode !== 0) {
    throw new RadianError(
      "herdr_failed",
      `herdr ${args[0]} ${args[1]} failed: ${failureDetail(result)}`,
    );
  }
  return result.stdout;
}

function failureDetail(result: HerdrResult): string {
  return result.stderr.trim() || result.stdout.trim();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return undefined;
  }
}
