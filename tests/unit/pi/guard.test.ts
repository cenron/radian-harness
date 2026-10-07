import assert from "node:assert/strict";
import { test } from "node:test";
import { guardToolCall } from "../../../src/pi/guard.ts";

test("the guard blocks bash, write, and edit with a reason", () => {
  for (const tool of ["bash", "write", "edit"]) {
    const decision = guardToolCall(tool);
    assert.equal(decision?.block, true);
    assert.match(decision?.reason ?? "", /worker|radian_/);
  }
});

test("the guard lets read tools and Radian tools through", () => {
  for (const tool of ["read", "ls", "grep", "find", "radian_dispatch", "radian_git"]) {
    assert.equal(guardToolCall(tool), undefined);
  }
});
