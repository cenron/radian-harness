import assert from "node:assert/strict";
import { test } from "node:test";
import { listSome } from "../../../../src/core/utils/text.ts";

test("listSome joins short lists and counts what it leaves out", () => {
  assert.equal(listSome([], 3), "");
  assert.equal(listSome(["a", "b"], 3), "a, b");
  assert.equal(listSome(["a", "b", "c"], 3), "a, b, c");
  assert.equal(listSome(["a", "b", "c", "d", "e"], 3), "a, b, c, and 2 more");
});
