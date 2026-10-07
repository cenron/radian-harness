import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../../helpers/git-fixtures.ts";
import { readJsonFile, writeJsonFile } from "../../../src/io/json-file.ts";

test("readJsonFile returns the fallback for a missing file", () => {
  assert.deepEqual(readJsonFile(path.join(makeTempDir(), "none.json"), { a: 1 }), { a: 1 });
});

test("writeJsonFile creates directories and round-trips", () => {
  const file = path.join(makeTempDir(), "nested", "x.json");
  writeJsonFile(file, { b: [1, 2] });
  assert.equal(readFileSync(file, "utf8"), '{\n  "b": [\n    1,\n    2\n  ]\n}\n');
  assert.deepEqual(readJsonFile(file, {}), { b: [1, 2] });
});

test("readJsonFile throws on invalid JSON", () => {
  const file = path.join(makeTempDir(), "bad.json");
  writeFileSync(file, "{nope");
  assert.throws(() => readJsonFile(file, {}), /not valid JSON/);
});
