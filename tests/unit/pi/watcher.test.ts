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
    isClosed: false,
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
  assert.equal(describeChange({ worker, entries, hasExited: false, isClosed: false }), undefined);
});

test("a pane that closes before done is reported", () => {
  const exited = { ...worker, state: "exited" as const };
  assert.match(
    describeChange({ worker: exited, entries: [], hasExited: true, isClosed: false }) ?? "",
    /pane closed before it reported done/,
  );
});

test("a closed scout's report goes to Pi instead of a merge offer", () => {
  const scout = {
    ...worker,
    name: "demo-scout-1",
    role: "scout",
    title: "Look",
    state: "done",
  } as WorkerRecord;
  const message = describeChange({
    worker: scout,
    entries: [{ kind: "done", text: "listed the files" }],
    hasExited: false,
    isClosed: true,
    report: "Two files.",
  });
  assert.match(message ?? "", /demo-scout-1 \(scout: Look\) done: listed the files/);
  assert.match(message ?? "", /pane, worktree, and branch were closed/);
  assert.match(message ?? "", /Report:\nTwo files\./);
  assert.doesNotMatch(message ?? "", /radian_merge/);
});

test("a reader closed after a restart, with no new lines, is still named", () => {
  const scout = {
    ...worker,
    name: "demo-scout-1",
    role: "scout",
    title: "Look",
    state: "done",
  } as WorkerRecord;
  const message = describeChange({
    worker: scout,
    entries: [],
    hasExited: false,
    isClosed: true,
    report: "",
  });
  assert.match(
    message ?? "",
    /^demo-scout-1 \(scout: Look\): pane, worktree, and branch were closed/,
  );
  assert.match(message ?? "", /\(no report written\)/);
});
