import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkerRecord } from "../../../src/core/worker.ts";
import { dashboardReport, projectReport, workersReport } from "../../../src/pi/status-view.ts";

const project = { name: "demo", path: "/ws/demo", target: "main" };
const worker = {
  name: "demo-developer-1",
  role: "developer",
  title: "Add login",
  state: "question",
  agentStatus: "idle",
  runtime: "claude",
  model: "claude-sonnet-5-5",
  lastStatus: "question: which db?",
} as WorkerRecord;

test("projectReport shows the project, mode, and workers", () => {
  const report = projectReport({ project, mode: "build", workers: [worker], maxWorkers: 3 });
  assert.match(report, /Project demo at \/ws\/demo \(target main\)/);
  assert.match(report, /Mode: BUILD/);
  assert.match(
    report,
    /demo-developer-1 \[question \(agent idle\)\] developer: Add login · claude claude-sonnet-5-5 — question: which db\?/,
  );
});

test("dashboard and empty reports guide the user", () => {
  assert.match(dashboardReport([]), /\/new-project/);
  assert.match(dashboardReport([project]), /- demo: \/ws\/demo[\s\S]*\/projects <name>/);
  assert.equal(workersReport([]), "No workers.");
});
