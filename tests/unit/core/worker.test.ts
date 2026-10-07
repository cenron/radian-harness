import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertProjectName,
  countsTowardLimit,
  hasOpenPane,
  nextWorkerName,
  paneLabel,
  workerBranch,
  type WorkerState,
} from "../../../src/core/worker.ts";

test("nextWorkerName numbers workers per project and role", () => {
  assert.equal(nextWorkerName("demo", "developer", []), "demo-developer-1");
  assert.equal(
    nextWorkerName("demo", "developer", ["demo-developer-1", "demo-developer-3", "demo-tester-7"]),
    "demo-developer-4",
  );
});

test("workerBranch lives under radian/", () => {
  assert.equal(workerBranch("demo-developer-1"), "radian/demo-developer-1");
});

test("paneLabel combines role and a shortened title", () => {
  assert.equal(paneLabel("developer", "  Add login  "), "developer Add login");
  assert.equal(paneLabel("scout", "x".repeat(80)).length, "scout ".length + 40);
});

test("assertProjectName accepts simple names only", () => {
  for (const name of ["demo", "my-app", "app2", "a_b"])
    assert.doesNotThrow(() => assertProjectName(name));
  for (const name of ["", "-x", "a b", "../x", "A/b", ".radian"]) {
    assert.throws(() => assertProjectName(name), /Project names/);
  }
});

test("only running workers count toward the limit", () => {
  const running: WorkerState[] = ["starting", "working", "idle", "question", "blocked"];
  const finished: WorkerState[] = ["done", "failed", "exited", "stopped"];
  for (const state of running) assert.equal(countsTowardLimit({ state }), true, state);
  for (const state of finished) assert.equal(countsTowardLimit({ state }), false, state);
});

test("a worker has an open pane until it exits or is stopped", () => {
  assert.equal(hasOpenPane({ state: "done", pane: "w1:p2" }), true);
  assert.equal(hasOpenPane({ state: "exited", pane: "w1:p2" }), false);
  assert.equal(hasOpenPane({ state: "stopped", pane: "w1:p2" }), false);
  assert.equal(hasOpenPane({ state: "starting" }), false);
});
