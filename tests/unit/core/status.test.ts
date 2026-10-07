import assert from "node:assert/strict";
import { test } from "node:test";
import { latestStatus, parseStatusLines } from "../../../src/core/status.ts";

test("parseStatusLines reads kind: text lines", () => {
  assert.deepEqual(parseStatusLines("working: reading the code\ndone: added login\n"), [
    { kind: "working", text: "reading the code" },
    { kind: "done", text: "added login" },
  ]);
});

test("parseStatusLines tolerates case, bullets, dashes, and blank lines", () => {
  assert.deepEqual(parseStatusLines("\n- DONE - shipped\n  Question:   which db?  \n\n"), [
    { kind: "done", text: "shipped" },
    { kind: "question", text: "which db?" },
  ]);
});

test("parseStatusLines keeps unrecognised lines as notes", () => {
  assert.deepEqual(parseStatusLines("finished /abs/path/file.ts\nblocked:"), [
    { kind: "note", text: "finished /abs/path/file.ts" },
    { kind: "blocked", text: "" },
  ]);
});

test("latestStatus returns the last non-note entry", () => {
  const entries = parseStatusLines("working: a\ndone: b\nthanks!");
  assert.deepEqual(latestStatus(entries), { kind: "done", text: "b" });
  assert.equal(latestStatus(parseStatusLines("hello")), undefined);
});
