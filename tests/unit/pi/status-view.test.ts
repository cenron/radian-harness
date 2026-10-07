import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkerRecord } from "../../../src/core/worker.ts";
import {
  dashboardReport,
  projectReport,
  projectStatusLine,
  workerWidgetLines,
  workersReport,
} from "../../../src/pi/status-view.ts";

const project = { name: "demo", path: "/ws/demo", target: "main" };
const worker = {
  name: "demo-developer-1",
  role: "developer",
  title: "Add login",
  state: "question",
  agentStatus: "idle",
  runtime: "claude",
  model: "claude-sonnet-5-5",
  worktree: "/wt/demo-developer-1",
  lastStatus: "question: which db?",
} as WorkerRecord;

test("projectReport shows the project, mode, and workers", () => {
  const report = projectReport({ project, mode: "build", workers: [worker], maxWorkers: 3 });
  assert.match(report, /Project demo at \/ws\/demo \(target main\)/);
  assert.match(report, /Mode: BUILD/);
  assert.match(
    report,
    /demo-developer-1 \[question \(agent idle\)\] developer: Add login · claude claude-sonnet-5-5 · worktree \/wt\/demo-developer-1 — question: which db\?/,
  );
});

test("dashboard and empty reports guide the user", () => {
  assert.match(dashboardReport([]), /\/new-project/);
  assert.match(dashboardReport([project]), /- demo: \/ws\/demo[\s\S]*\/projects <name>/);
  assert.equal(workersReport([]), "No workers.");
});

test("the workers report shows where each worker's files are", () => {
  const report = workersReport([{ ...worker, worktree: "/ws/.radian/projects/demo/worktrees/w" }]);
  assert.match(report, / · worktree \/ws\/\.radian\/projects\/demo\/worktrees\/w/);
});

test("the footer says how many workers are open and how many slots they use", () => {
  const withState = (state: WorkerRecord["state"]) => ({ ...worker, state }) as WorkerRecord;
  const line = (workers: WorkerRecord[]) =>
    projectStatusLine({ project, mode: "build", workers, maxWorkers: 3 });
  assert.equal(line([]), "Radian · demo · BUILD · no workers · 0/3 slots in use");
  assert.equal(
    line([withState("working")]),
    "Radian · demo · BUILD · 1 worker: 1 working · 1/3 slots in use",
  );
  assert.equal(
    line([withState("done"), withState("done")]),
    "Radian · demo · BUILD · 2 workers: 2 done · 0/3 slots in use",
  );
  assert.equal(
    line([withState("done"), withState("question"), withState("working")]),
    "Radian · demo · BUILD · 3 workers: 1 working, 1 asking, 1 done · 2/3 slots in use",
  );
});

test("the worker list under Pi is short: no project prefix, paths, or model, and a trimmed summary", () => {
  const plain = (_color: string, text: string) => text;
  const lines = workerWidgetLines(
    [
      {
        ...worker,
        name: "ascii-rpg-prototype-developer-1",
        project: "ascii-rpg-prototype",
        state: "done",
        title: "Complete playable prototype",
        lastStatus:
          "done: WASD movement; screenshots at /opt/ws/.radian/projects/x/worktrees/y/docs/screenshots/a.png, tests pass and everything else in this long summary is fine",
      },
      {
        ...worker,
        name: "ascii-rpg-prototype-tester-1",
        project: "ascii-rpg-prototype",
        role: "tester",
        state: "question",
        title: "Validate",
        lastStatus: "question: which Godot version?",
      },
    ] as WorkerRecord[],
    plain,
  );
  assert.deepEqual(lines, [
    "✓ developer-1  done    Complete playable prototype — WASD movement; screenshots at …/screenshots/a.png, tests pass and everything els…",
    "? tester-1     asking  Validate — which Godot version?",
  ]);
  assert.ok(lines.every((line) => !line.includes("worktree") && !line.includes("claude-sonnet")));
});

test("each worker's state is colored: working accent, asking warning, done success, failed error", () => {
  const tag = (color: string, text: string) => `<${color}>${text}`;
  const line = (state: WorkerRecord["state"]) =>
    workerWidgetLines([{ ...worker, project: "demo", state } as WorkerRecord], tag)[0] ?? "";
  assert.match(line("working"), /^<accent>● developer-1/);
  assert.match(line("question"), /^<warning>\? developer-1/);
  assert.match(line("blocked"), /^<warning>! developer-1/);
  assert.match(line("done"), /^<success>✓ developer-1/);
  assert.match(line("failed"), /^<error>✗ developer-1/);
  assert.match(line("stopped"), /^<muted>■ developer-1/);
});

test("each worker stays on one line: the summary shrinks to the pane width, or is left out", () => {
  const plain = (_color: string, text: string) => text;
  const long = {
    ...worker,
    project: "demo",
    state: "done",
    lastStatus: `done: ${"x".repeat(200)}`,
  };
  const [fitted] = workerWidgetLines([long as WorkerRecord], plain, 60);
  assert.equal(fitted?.length, 60);
  assert.ok(fitted?.endsWith("…"));
  const [narrow] = workerWidgetLines([long as WorkerRecord], plain, 30);
  assert.equal(narrow, "✓ developer-1  done  Add login");
});
