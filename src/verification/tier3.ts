// Tier 3 capability checks: tiny real Claude Code tasks under the production
// profile, argv, environment, and credential projection, plus an owned Herdr
// pane split from the caller's own pane. Uses a little subscription plan
// usage. Billing can be checked only partly from this machine (subscription
// login, no API-key source, first-party provider); the user confirms plan
// usage when recording.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { assertNoProhibitedEnv } from "../isolation/credentials.ts";
import { systemProcessOps, descendants } from "../isolation/processes.ts";
import { terminateOwned } from "../isolation/terminate.ts";
import { createClaudeAdapter } from "../runtimes/claude.ts";
import type { RuntimeEvent } from "../runtimes/contract.ts";
import { HerdrTransport, herdrEnvironment, locateHerdr, systemHerdrRunner } from "../runtimes/herdr.ts";
import { psProbe } from "../util/process-identity.ts";
import { type CheckResult, cleanup } from "./harness.ts";
import { type ClaudeFixture, claudeFixture, runContained, statusFields } from "./tier2.ts";

export const TIER3_MODEL = "claude-haiku-4-5-20251001";
export const TIER3_EFFORT = "low";
const commandOf = (pid: number): string => (spawnSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 }).stdout ?? "").trim();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const mark = (ok: boolean) => (ok ? "ok  " : "FAIL");

interface TaskRun {
  events: RuntimeEvent[];
  exitCode: number | null;
  pid: number | undefined;
}

/** Start the production argv under the worker profile; resolves when it exits or `stopWhen` decides to stop it. */
function startTask(f: ClaudeFixture, timeoutMs: number, onSpawn?: (pid: number) => Promise<void>): Promise<TaskRun & { observer: Promise<void> }> {
  const adapter = createClaudeAdapter();
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-f", f.profileFile, "--", ...f.argv], { cwd: f.cwd, env: f.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const events: RuntimeEvent[] = [];
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) events.push(...adapter.parseEvent(line));
      }
    });
    child.stderr.resume();
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // gone
      }
    }, timeoutMs);
    // The observer (for example a stop in progress) is awaited by the caller, not raced against exit.
    const observer = onSpawn && child.pid ? onSpawn(child.pid) : Promise.resolve();
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ events, exitCode: code, pid: child.pid, observer });
    });
  });
}

const BRIEF_WRITE = "# Verification task\nCreate the file `src/hello.txt` containing exactly the single word `verified`. Do nothing else. Do not write the result file.\n";
const BRIEF_REVIEW = "# Verification task\nTry to create the file `src/review.txt` containing `x`. If your tools do not allow it, say so in one sentence and stop. Do not attempt any workaround.\n";
const BRIEF_SLEEP = "# Verification task\nRun exactly this shell command with your Bash tool and wait for it: `sleep 120`. Do nothing else.\n";

async function withFixture(options: Parameters<typeof claudeFixture>[0], run: (f: ClaudeFixture) => Promise<CheckResult[]>, capabilities: CheckResult["capability"][]): Promise<CheckResult[]> {
  const fixture = await claudeFixture({ model: TIER3_MODEL, effort: TIER3_EFFORT, ...options });
  if (!fixture.ok) return capabilities.map((capability) => ({ capability, passed: false, details: [`FAIL ${fixture.reason}`] }));
  try {
    return await run(fixture.value);
  } finally {
    rmSync(path.join(fixture.value.l.root, "projection"), { recursive: true, force: true });
    cleanup(fixture.value.l);
  }
}

/** Binding and billing evidence from one real developer task. */
export function checkBindingAndBilling(): Promise<CheckResult[]> {
  return withFixture({ role: "developer", brief: BRIEF_WRITE }, async (f) => {
    const run = await startTask(f, 180_000);
    const started = run.events.find((e): e is Extract<RuntimeEvent, { kind: "session-started" }> => e.kind === "session-started");
    const accepted = run.events.some((e) => e.kind === "prompt-accepted");
    const settled = run.events.find((e): e is Extract<RuntimeEvent, { kind: "settled" }> => e.kind === "settled");
    const sessionOk = started?.sessionId === f.sessionId;
    const modelOk = started?.model === f.model;
    const authOk = started?.authSource === "none";
    const success = settled?.outcome === "success";
    const file = path.join(f.l.worktree, "src", "hello.txt");
    const wrote = existsSync(file) && readFileSync(file, "utf8").trim() === "verified";
    const status = runContained(f, [f.argv0, "auth", "status", "--json"]);
    const login = statusFields(status.stdout ?? "");
    const subscription = login.authMethod === "claude.ai" && login.apiProvider === "firstParty";
    const envOk = assertNoProhibitedEnv(f.env).ok;
    const error = settled?.error ? ` (${settled.error.class}: ${settled.error.summary.slice(0, 120)})` : run.exitCode !== 0 ? ` (exit ${run.exitCode})` : "";
    return [
      {
        capability: "runtime.claude-code.assignment-binding",
        passed: sessionOk && modelOk && accepted && success && wrote,
        details: [
          `${mark(sessionOk)} Claude Code reported the session id Radian assigned`,
          `${mark(modelOk)} it reported the requested model (${started?.model ?? "none"})`,
          `${mark(accepted)} the prompt was accepted`,
          `${mark(success)} the task settled successfully${error}`,
          `${mark(wrote)} the requested file was written inside the worktree`,
        ],
      },
      {
        capability: "billing.claude-code.subscription-path",
        passed: authOk && subscription && envOk && success,
        details: [
          `${mark(authOk)} Claude Code reported no API-key source (${started?.authSource ?? "unknown"})`,
          `${mark(subscription)} login is claude.ai first-party (subscription ${login.subscriptionType ?? "unknown"})`,
          `${mark(envOk)} no API-key, endpoint, or proxy variables in the worker environment`,
          "note: plan usage itself is confirmed by you on your Claude usage page when recording",
        ],
      },
    ];
  }, ["runtime.claude-code.assignment-binding", "billing.claude-code.subscription-path"]);
}

/** A reviewer cannot write, even when asked to. */
export function checkToolRestrictions(): Promise<CheckResult[]> {
  return withFixture({ role: "reviewer", brief: BRIEF_REVIEW }, async (f) => {
    const toolsOk = ["Edit", "Write", "Bash"].every((t) => !f.tools.includes(t)) && f.argv.includes("--restricted");
    const run = await startTask(f, 180_000);
    const settled = run.events.some((e) => e.kind === "settled");
    const writeTools = run.events.filter((e) => e.kind === "tool" && ["Edit", "Write", "Bash", "NotebookEdit"].includes(e.name) && e.phase === "end" && !e.isError);
    const absent = !existsSync(path.join(f.l.worktree, "src", "review.txt"));
    return [
      {
        capability: "runtime.claude-code.tool-restrictions",
        passed: toolsOk && settled && writeTools.length === 0 && absent,
        details: [
          `${mark(toolsOk)} reviewer launch exposes only ${f.tools.join(", ")} and runs restricted`,
          `${mark(settled)} the reviewer task ran to completion`,
          `${mark(writeTools.length === 0)} no write or shell tool succeeded`,
          `${mark(absent)} the file the reviewer was asked to create does not exist`,
        ],
      },
    ];
  }, ["runtime.claude-code.tool-restrictions"]);
}

/** Radian's stop terminates a real Claude Code process and the command it is running. */
export function checkCancellation(): Promise<CheckResult[]> {
  return withFixture({ role: "developer", brief: BRIEF_SLEEP }, async (f) => {
    let observed = false;
    let outcome: Awaited<ReturnType<typeof terminateOwned>> | undefined;
    let tree: number[] = [];
    const run = await startTask(f, 240_000, async (pid) => {
      const deadline = Date.now() + 150_000;
      while (Date.now() < deadline) {
        const rows = systemProcessOps.table() ?? [];
        const below = descendants(rows, [pid]);
        if (below.some((r) => /(^|\/)sleep 120$/.test(commandOf(r.pid)))) {
          observed = true;
          tree = [pid, ...below.map((r) => r.pid)];
          break;
        }
        await sleep(250);
      }
      const state = psProbe(pid);
      if (state.state !== "running") return;
      outcome = await terminateOwned(systemProcessOps, { registered: [{ pid, start: state.start }], ownedRoots: [f.l.worktree, f.l.scratch], unresolvedIntents: 0, protectedPids: [process.pid], graceMs: 2_000 });
    });
    await run.observer;
    await sleep(500);
    const survivors = tree.filter((pid) => psProbe(pid).state === "running");
    for (const pid of survivors) process.kill(pid, "SIGKILL");
    return [
      {
        capability: "runtime.claude-code.cancellation",
        passed: observed && outcome?.postcondition === "verified" && survivors.length === 0,
        details: [
          `${mark(observed)} Claude Code started the long-running command (${tree.length} owned processes)`,
          `${mark(outcome?.postcondition === "verified")} Radian's stop reported verified termination (${outcome?.postcondition ?? "not run"})`,
          `${mark(survivors.length === 0)} no Claude Code or descendant process survived`,
          `note: the task exited with ${run.exitCode === null ? "a signal" : `code ${run.exitCode}`}`,
        ],
      },
    ];
  }, ["runtime.claude-code.cancellation"]);
}

/** An owned pane split from the caller's own pane: created without focus, used, closed; nothing else touched. */
export async function checkHerdrPanes(): Promise<CheckResult[]> {
  const capability = "transport.herdr.owned-panes" as const;
  const herdr = locateHerdr();
  const parent = process.env.HERDR_PANE_ID;
  if (!herdr || !parent || process.env.HERDR_ENV !== "1") return [{ capability, passed: false, details: ["FAIL run this from inside a Herdr pane (HERDR_ENV=1)"] }];
  const env = herdrEnvironment();
  const runner = systemHerdrRunner(herdr, env);
  const listPanes = async () => {
    const out = await runner(["pane", "list"], 15_000);
    try {
      return ((JSON.parse(out.stdout) as { result: { panes: Array<{ pane_id: string }> } }).result.panes ?? []).map((p) => p.pane_id).sort();
    } catch {
      return undefined;
    }
  };
  const fixture = await claudeFixture({ brief: "unused" });
  if (!fixture.ok) return [{ capability, passed: false, details: [`FAIL ${fixture.reason}`] }];
  const f = fixture.value;
  try {
    const before = await listPanes();
    const transport = new HerdrTransport({ runner, stateDir: f.l.state });
    const pane = await transport.createPane({ assignment: "asg_verify", attempt: "att_verify", parentPane: parent, cwd: f.l.worktree });
    if (!pane.ok) return [{ capability, passed: false, details: [`FAIL pane creation: ${pane.blocker.message}`] }];
    const sent = await transport.runInPane(pane.value.paneId, ["/usr/bin/true"]);
    await sleep(500);
    const during = await listPanes();
    const closed = await transport.closePane(pane.value.paneId, "verified");
    await sleep(300);
    const after = await listPanes();
    const othersKept = before !== undefined && after !== undefined && JSON.stringify(before) === JSON.stringify(after);
    const added = during !== undefined && before !== undefined && during.length === before.length + 1 && during.includes(pane.value.paneId);
    return [
      {
        capability,
        passed: added && sent.ok && closed.ok && othersKept,
        details: [
          `${mark(added)} an owned pane was created next to this pane without taking focus`,
          `${mark(sent.ok)} a command was delivered to the owned pane (${sent.ok ? sent.value : "refused"})`,
          `${mark(closed.ok)} the owned pane was closed`,
          `${mark(othersKept)} every other pane is unchanged`,
        ],
      },
    ];
  } finally {
    rmSync(path.join(f.l.root, "projection"), { recursive: true, force: true });
    cleanup(f.l);
  }
}

export async function runTier3(): Promise<CheckResult[]> {
  return [...(await checkHerdrPanes()), ...(await checkBindingAndBilling()), ...(await checkToolRestrictions()), ...(await checkCancellation())];
}
