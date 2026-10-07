import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkerRecord } from "../../../src/core/worker.ts";
import { describeChange } from "../../../src/pi/watcher.ts";

const worker = {
  name: "demo-developer-1",
  role: "developer",
  title: "Add login",
  state: "working",
} as WorkerRecord;

test("questions and results tell Pi what to do next", () => {
  const message = describeChange({
    worker,
    entries: [
      { kind: "question", text: "which db?" },
      { kind: "done", text: "added login" },
    ],
    hasExited: false,
  });
  assert.match(
    message ?? "",
    /demo-developer-1 \(developer: Add login\) question: which db\?\n→ Answer with radian_send/,
  );
  assert.match(message ?? "", /done: added login\n→ Summarize .*radian_merge/);
});

test("progress lines and notes alone do not wake Pi", () => {
  const entries = [
    { kind: "working" as const, text: "reading" },
    { kind: "note" as const, text: "hm" },
  ];
  assert.equal(describeChange({ worker, entries, hasExited: false }), undefined);
});

test("a pane that closes before done is reported", () => {
  const exited = { ...worker, state: "exited" as const };
  assert.match(
    describeChange({ worker: exited, entries: [], hasExited: true }) ?? "",
    /pane closed before it reported done/,
  );
});
