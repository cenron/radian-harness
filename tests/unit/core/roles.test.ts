import assert from "node:assert/strict";
import { test } from "node:test";
import { RadianError } from "../../../src/core/errors.ts";
import {
  assertRoleAllowedInMode,
  canEditCode,
  parseMode,
  parseRole,
} from "../../../src/core/roles.ts";

test("parseRole accepts the four roles and rejects others", () => {
  for (const role of ["developer", "tester", "reviewer", "scout"])
    assert.equal(parseRole(role), role);
  assert.throws(() => parseRole("manager"), RadianError);
});

test("parseMode accepts plan and build", () => {
  assert.equal(parseMode("plan"), "plan");
  assert.equal(parseMode("build"), "build");
  assert.throws(() => parseMode("ship"), /plan or build/);
});

test("only a scout may be dispatched in Plan mode", () => {
  assert.doesNotThrow(() => assertRoleAllowedInMode("scout", "plan"));
  for (const role of ["developer", "tester", "reviewer"] as const) {
    assert.throws(() => assertRoleAllowedInMode(role, "plan"), /Build mode/);
    assert.doesNotThrow(() => assertRoleAllowedInMode(role, "build"));
  }
});

test("developers and testers edit code; reviewers and scouts do not", () => {
  assert.equal(canEditCode("developer"), true);
  assert.equal(canEditCode("tester"), true);
  assert.equal(canEditCode("reviewer"), false);
  assert.equal(canEditCode("scout"), false);
});
