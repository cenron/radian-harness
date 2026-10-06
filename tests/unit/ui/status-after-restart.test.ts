// After Pi restarts, the project's active run exists on disk but is not
// reopened until something needs it. Status (the coordinator's only view of
// open worker questions) must still show the run, its tasks, assignments,
// and the full text of open decisions — it said "No active run yet", so the
// coordinator could not see what the workers had asked.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { CoordinatorLease } from "../../../src/state/lease.ts";
import { RunStore } from "../../../src/state/run-store.ts";
import { atomicWriteJson } from "../../../src/state/fsutil.ts";
import { statusText } from "../../../src/ui/controller.ts";
import { removeDir, tempDir } from "../helpers/fixture.ts";

test("status reads the active run from disk when it is not open in this process", async () => {
  const state = tempDir();
  try {
    const lease = await CoordinatorLease.acquire(state, "prj_fixture1", { ttlMs: 60_000 });
    assert.ok(lease.ok);
    if (!lease.ok) return;
    const store = await RunStore.create(state, lease.value, { workspace: "ws_fixture1", project: "prj_fixture1", configHash: "sha256:" + "a".repeat(64), harness: { version: "0.0.0-test", revision: "f".repeat(40), locallyModified: false } });
    assert.ok(store.ok);
    if (!store.ok) return;
    atomicWriteJson(path.join(state, "active-run.json"), { run: store.value.state.run.id });
    await store.value.addTask("ASCII RPG prototype", 3, "task_fixture1");
    await lease.value.release();
    const session = { mode: { mode: "build" }, binding: { project: "prj_fixture1" }, target: { ref: "refs/heads/main" }, calm: { enabled: false }, project: { state }, run: undefined } as never;
    const text = statusText(session);
    assert.doesNotMatch(text, /No active run/);
    assert.match(text, new RegExp(`Run ${store.value.state.run.id}`));
    assert.match(text, /task task_fixture1 "ASCII RPG prototype"/);
  } finally {
    removeDir(state);
  }
});
