import assert from "node:assert/strict";
import { test } from "node:test";
import { RadianError } from "../../../../src/core/errors.ts";
import { errorMessage } from "../../../../src/core/utils/errors.ts";

test("errorMessage reads Error and non-Error values", () => {
  assert.equal(errorMessage(new RadianError("invalid", "Bad input.")), "Bad input.");
  assert.equal(errorMessage(new Error("plain")), "plain");
  assert.equal(errorMessage("text"), "text");
});
