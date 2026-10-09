import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolGuard } from "../../../../src/core/utils/tool-guard.ts";

test("a tool guard blocks only the listed tools, each with its own reason", () => {
  const guard = createToolGuard({ bash: "no shell", write: "no edits" });
  assert.deepEqual(guard("bash"), { block: true, reason: "no shell" });
  assert.deepEqual(guard("write"), { block: true, reason: "no edits" });
  assert.equal(guard("read"), undefined);
});
