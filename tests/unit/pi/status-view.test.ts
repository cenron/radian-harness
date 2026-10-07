import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkerRecord } from "../../../src/core/worker.ts";
import {
  dashboardReport,
  projectReport,
  projectStatusLine,
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
