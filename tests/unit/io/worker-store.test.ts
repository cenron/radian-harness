import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { WorkerRecord } from "../../../src/core/worker.ts";
import { makeTempDir } from "../../helpers/git-fixtures.ts";
import {
  findWorker,
  listWorkers,
  removeWorker,
  replaceWorker,
  saveWorker,
} from "../../../src/io/worker-store.ts";

function record(name: string, overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    name,
    project: "demo",
    role: "developer",
    title: "t",
    profile: "developer",
    runtime: "claude",
    model: "claude-sonnet-5-5",
    effort: "medium",
    branch: `radian/${name}`,
    baseBranch: "main",
    worktree: `/wt/${name}`,
    state: "starting",
    statusLinesSeen: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("an empty store lists no workers", () => {
  assert.deepEqual(listWorkers(path.join(makeTempDir(), "workers.json")), []);
});

test("saveWorker inserts and then replaces by name", () => {
  const file = path.join(makeTempDir(), "workers.json");
  saveWorker(file, record("a"));
  saveWorker(file, record("b"));
  saveWorker(file, record("a", { state: "done" }));
  assert.deepEqual(
    listWorkers(file).map((worker) => [worker.name, worker.state]),
    [
      ["a", "done"],
      ["b", "starting"],
    ],
  );
});

test("findWorker throws a helpful error for an unknown worker", () => {
  const file = path.join(makeTempDir(), "workers.json");
  saveWorker(file, record("a"));
  assert.equal(findWorker(file, "a").name, "a");
  assert.throws(() => findWorker(file, "zz"), /No worker named "zz"/);
});

test("removeWorker deletes the record", () => {
  const file = path.join(makeTempDir(), "workers.json");
  saveWorker(file, record("a"));
  removeWorker(file, "a");
  assert.deepEqual(listWorkers(file), []);
});

test("replaceWorker updates an existing record and never inserts one", () => {
  const file = path.join(makeTempDir(), "workers.json");
  assert.equal(replaceWorker(file, record("a")), false);
  assert.deepEqual(listWorkers(file), []);
  saveWorker(file, record("a"));
  assert.equal(replaceWorker(file, record("a", { state: "done" })), true);
  assert.equal(listWorkers(file)[0]?.state, "done");
});
