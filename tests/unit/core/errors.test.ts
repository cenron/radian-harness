import assert from "node:assert/strict";
import { test } from "node:test";
import { RadianError } from "../../../src/core/errors.ts";

test("RadianError carries a code and a message", () => {
  const error = new RadianError("not_found", "Project demo was not found.");
  assert.equal(error.code, "not_found");
  assert.equal(error.message, "Project demo was not found.");
  assert.equal(error.name, "RadianError");
  assert.ok(error instanceof Error);
});
