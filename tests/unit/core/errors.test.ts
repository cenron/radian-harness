import assert from "node:assert/strict";
import { test } from "node:test";
import { RadianError, errorMessage } from "../../../src/core/errors.ts";

test("RadianError carries a code and a message", () => {
  const error = new RadianError("not_found", "Project demo was not found.");
  assert.equal(error.code, "not_found");
  assert.equal(error.message, "Project demo was not found.");
  assert.equal(error.name, "RadianError");
  assert.ok(error instanceof Error);
});

test("errorMessage reads Error and non-Error values", () => {
  assert.equal(errorMessage(new RadianError("invalid", "Bad input.")), "Bad input.");
  assert.equal(errorMessage(new Error("plain")), "plain");
  assert.equal(errorMessage("text"), "text");
});
