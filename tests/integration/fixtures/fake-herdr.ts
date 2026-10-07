// Stands in for the `herdr` CLI in native tests. State lives in $FAKE_HERDR_STATE. When an
// agent is prompted with its brief, it plays the worker: writes a file in its worktree and
// appends `done:` to its status file, as a real Claude Code, Codex, or Pi session would.
// Like a real worker it does not commit; Radian does.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface FakeState {
  calls: string[][];
  panes: Record<string, { cwd: string; agent?: string }>;
  nextPane: number;
}

const stateFile = process.env.FAKE_HERDR_STATE ?? "";
const state = readState();
const args = process.argv.slice(2);
state.calls.push(args);
const output = handle(args);
writeFileSync(stateFile, JSON.stringify(state));
if (output === undefined) {
  process.stderr.write(`fake herdr: no such target ${args.join(" ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(typeof output === "string" ? output : JSON.stringify(output));
}

function handle([group, command, target = ""]: string[]): unknown {
  if (group === "pane" && command === "split") {
    const pane = `w9:p${++state.nextPane}`;
    state.panes[pane] = { cwd: valueAfter("--cwd") };
    return { result: { pane: { pane_id: pane } } };
  }
  if (group === "pane" && command === "get") {
    return state.panes[target]
      ? { result: { pane: { pane_id: target, agent_status: "idle" } } }
      : undefined;
  }
  if (group === "pane" && command === "read") {
    // What Claude Code shows once its input is live, so Radian types the task in.
    return state.panes[target] ? "❯ \n  ⏵⏵ don't ask on (shift+tab to cycle)" : undefined;
  }
  if (group === "pane" && command === "close") {
    if (!state.panes[target]) return undefined;
    delete state.panes[target];
    return { result: {} };
  }
  if (group === "agent" && command === "start") {
    const pane = state.panes[valueAfter("--pane")];
    if (!pane) return undefined;
    pane.agent = target;
    return { result: {} };
  }
  if (group === "agent" && command === "prompt") {
    const pane = state.panes[target];
    if (!pane) return undefined;
    playWorker(args[3] ?? "");
    return { result: {} };
  }
  return { result: {} };
}

function playWorker(prompt: string): void {
  const briefPath = /Read and do the task in (\S+)$/.exec(prompt)?.[1];
  if (!briefPath) return;
  const brief = readFileSync(briefPath, "utf8");
  const worktree = /Stay inside your worktree: (\S+)/.exec(brief)?.[1] ?? "";
  const statusFile = />> (\S+)/.exec(brief)?.[1] ?? "";
  writeFileSync(path.join(worktree, "work.txt"), "done by the fake worker\n");
  appendFileSync(statusFile, "working: writing work.txt\ndone: wrote work.txt\n");
}

function valueAfter(flag: string): string {
  return args[args.indexOf(flag) + 1] ?? "";
}

function readState(): FakeState {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8")) as FakeState;
  } catch (_error) {
    return { calls: [], panes: {}, nextPane: 0 };
  }
}
