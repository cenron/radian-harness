// The machine-level capability checks themselves: on macOS with sandbox-exec
// they must pass, including every "allowed" sub-check (so a broken sandbox
// run that denies everything cannot pass as containment). The Claude Code
// dependency audit and Tiers 2–3 need the real runtime and login and are run
// only by the user (`npm run verify:capabilities`, `/radian capabilities verify`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { nativeAvailable } from "../../../src/verification/harness.ts";
import { checkDescendantTermination, checkFilesystem, checkIndependentWatcher, checkNetwork, checkSignals, checkWatcherLoss } from "../../../src/verification/tier1.ts";

const skip = nativeAvailable() ? false : "requires macOS sandbox-exec";

for (const check of [checkFilesystem, checkSignals, checkNetwork, checkDescendantTermination, checkIndependentWatcher, checkWatcherLoss]) {
  test(`tier 1 check passes on this machine: ${check.name}`, { skip }, async () => {
    const result = await check();
    assert.ok(result.passed, `${result.capability}\n${result.details.join("\n")}`);
    assert.ok(result.details.every((d) => !d.startsWith("FAIL")));
  });
}
