import { execFile } from "node:child_process";
import { RadianError } from "../core/errors.ts";
import type { Runtime } from "../core/profiles.ts";

export interface HerdrResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Runs one herdr command. Injected so tests can stand in for Herdr. */
export type HerdrRunner = (args: readonly string[]) => Promise<HerdrResult>;

export interface AgentInfo {
  status: string;
  pane: string;
}

// Claude Code and Codex can take a while to show their prompt on first start.
const AGENT_START_TIMEOUT_MS = 120_000;

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
  input: { from: string; cwd: string; blankedEnv: readonly string[] },
): Promise<string> {
  const envFlags = input.blankedEnv.flatMap((key) => ["--env", `${key}=`]);
  const args = [
    "pane",
    "split",
    input.from,
    "--direction",
    "right",
    "--cwd",
    input.cwd,
    "--no-focus",
  ];
  return parseCreatedPane(await runChecked(run, [...args, ...envFlags]));
}

export async function renamePane(run: HerdrRunner, pane: string, label: string): Promise<void> {
  await runChecked(run, ["pane", "rename", pane, label]);
}

/** Herdr returns once the agent is ready for input. */
export async function startAgent(
  run: HerdrRunner,
  input: { name: string; kind: Runtime; pane: string; args: readonly string[] },
): Promise<void> {
  const timeout = String(AGENT_START_TIMEOUT_MS);
  await runChecked(run, [
    "agent",
    "start",
    input.name,
    "--kind",
    input.kind,
    "--pane",
    input.pane,
    "--timeout",
    timeout,
    "--",
    ...input.args,
  ]);
}

export async function promptAgent(run: HerdrRunner, name: string, text: string): Promise<void> {
  await runChecked(run, ["agent", "prompt", name, text]);
}

/** Undefined when Herdr no longer knows the agent, which means its pane is gone. */
export async function getAgent(run: HerdrRunner, name: string): Promise<AgentInfo | undefined> {
  const result = await run(["agent", "get", name]);
  if (result.exitCode !== 0) return undefined;
  const data = parseJson(result.stdout) as {
    result?: { agent?: { agent_status?: string; pane_id?: string } };
  };
  const agent = data?.result?.agent;
  return { status: agent?.agent_status ?? "unknown", pane: agent?.pane_id ?? "" };
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
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new RadianError("herdr_failed", `herdr ${args[0]} ${args[1]} failed: ${detail}`);
  }
  return result.stdout;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return undefined;
  }
}
