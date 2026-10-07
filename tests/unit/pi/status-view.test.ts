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
  assert.match(dashboardReport([]), /\/projects create <name>/);
  assert.match(dashboardReport([project]), /- demo: \/ws\/demo[\s\S]*\/projects select <name>/);
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

test("the worker list under Pi is short: no project prefix, paths, or model; summaries indented below", () => {
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
          "done: WASD movement; screenshots at /opt/ws/.radian/projects/x/worktrees/y/docs/screenshots/a.png, tests pass",
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
    "✓ developer-1  done    Complete playable prototype",
    "    WASD movement; screenshots at …/screenshots/a.png, tests pass",
    "? tester-1     asking  Validate",
    "    which Godot version?",
  ]);
  assert.ok(lines.every((line) => !line.includes("worktree") && !line.includes("claude-sonnet")));
});

test("each worker's state is colored, and its summary is muted", () => {
  const tag = (color: string, text: string) => `<${color}>${text}`;
  const lines = (state: WorkerRecord["state"]) =>
    workerWidgetLines([{ ...worker, project: "demo", state } as WorkerRecord], tag);
  assert.match(lines("working")[0] ?? "", /^<accent>● developer-1/);
  assert.match(lines("question")[0] ?? "", /^<warning>\? developer-1/);
  assert.match(lines("blocked")[0] ?? "", /^<warning>! developer-1/);
  assert.match(lines("done")[0] ?? "", /^<success>✓ developer-1/);
  assert.match(lines("failed")[0] ?? "", /^<error>✗ developer-1/);
  assert.match(lines("stopped")[0] ?? "", /^<muted>■ developer-1/);
  assert.equal(lines("done")[1], "    <muted>which db?");
});

test("a long summary wraps to the pane width and is cut only after two lines", () => {
  const plain = (_color: string, text: string) => text;
  const words = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
  const long = { ...worker, project: "demo", state: "done", lastStatus: `done: ${words}` };
  const lines = workerWidgetLines([long as WorkerRecord], plain, 40);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "✓ developer-1  done  Add login");
  assert.ok(lines.slice(1).every((line) => line.startsWith("    ") && line.length <= 40));
  assert.ok(lines[2]?.endsWith("…"));
  assert.match(lines[1] ?? "", /^ {4}word0 word1 word2 /);
});
