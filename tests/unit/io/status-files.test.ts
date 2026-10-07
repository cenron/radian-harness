import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../../helpers/git-fixtures.ts";
import {
  readReport,
  readStatusEntries,
  workerFiles,
  writeBrief,
} from "../../../src/io/status-files.ts";

test("workerFiles names the brief, status, and report files", () => {
  assert.deepEqual(workerFiles("/w"), {
    brief: "/w/brief.md",
    status: "/w/status",
    report: "/w/report.md",
  });
});

test("writeBrief creates the worker directory and an empty status file", () => {
  const files = workerFiles(path.join(makeTempDir(), "workers", "w1"));
  writeBrief(files, "# Task\n");
  assert.equal(readFileSync(files.brief, "utf8"), "# Task\n");
  assert.deepEqual(readStatusEntries(files.status), []);
});

test("readStatusEntries parses appended lines and tolerates a missing file", () => {
  const files = workerFiles(path.join(makeTempDir(), "w"));
  assert.deepEqual(readStatusEntries(files.status), []);
  writeBrief(files, "x");
  appendFileSync(files.status, "working: start\ndone: finished\n");
  assert.deepEqual(readStatusEntries(files.status), [
    { kind: "working", text: "start" },
    { kind: "done", text: "finished" },
  ]);
});

test("readReport returns undefined until the worker writes one", () => {
  const files = workerFiles(path.join(makeTempDir(), "w"));
  assert.equal(readReport(files.report), undefined);
  writeBrief(files, "x");
  appendFileSync(files.report, "Looks good.\n");
  assert.equal(readReport(files.report), "Looks good.\n");
});
