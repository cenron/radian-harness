// Approvals advance the task phase. A live run showed "spec_draft" after the
// spec and plan were approved, and the coordinator concluded the approvals
// had been lost. Phases are derived from the event log, so existing runs are
// corrected when reloaded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../../../src/state/run-store.ts";
import { CoordinatorLease } from "../../../src/state/lease.ts";
import { HumanChannel } from "../../../src/state/approvals.ts";
import { removeDir, tempDir } from "../helpers/fixture.ts";

const human = () => HumanChannel.fromUserInput("user-command", "fixture-user", "/radian approve");
const hash = (c: string) => "sha256:" + c.repeat(64);

test("approving the spec moves the task to planning, approving the plan to building; rejections do not", async () => {
  const state = tempDir();
  try {
    const lease = await CoordinatorLease.acquire(state, "prj_fixture1", { ttlMs: 60_000 });
    assert.ok(lease.ok);
    if (!lease.ok) return;
    const store = await RunStore.create(state, lease.value, { workspace: "ws_fixture1", project: "prj_fixture1", configHash: hash("a"), harness: { version: "0.0.0-test", revision: "f".repeat(40), locallyModified: false } });
    assert.ok(store.ok);
    if (!store.ok) return;
    const s = store.value;
    await s.addTask("Prototype", 3, "task_fixture1");
    const phase = () => s.state.tasks["task_fixture1"]!.phase;
    assert.equal(phase(), "spec_draft");
    await s.recordApproval(human(), { kind: "spec", task: "task_fixture1", artifact: { path: "spec.md", hash: hash("b") }, decision: "rejected" });
    assert.equal(phase(), "spec_draft", "a rejection does not advance");
    await s.recordApproval(human(), { kind: "spec", task: "task_fixture1", artifact: { path: "spec.md", hash: hash("b") }, decision: "approved" });
    assert.equal(phase(), "planning");
    await s.recordApproval(human(), { kind: "plan", task: "task_fixture1", artifact: { path: "plan.md", hash: hash("c") }, decision: "approved" });
    assert.equal(phase(), "building");
    await s.recordApproval(human(), { kind: "spec", task: "task_fixture1", artifact: { path: "spec.md", hash: hash("d") }, decision: "approved" });
    assert.equal(phase(), "building", "a later spec revision never moves the task backwards");
    await lease.value.release();
  } finally {
    removeDir(state);
  }
});
