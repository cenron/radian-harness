// `/radian capabilities verify`: checks run only after an interactive start,
// results are shown, and only passed items are recorded, only when the user
// chooses Record (Cancel is the initial selection). Evidence is bound to the
// macOS major version and policy template, and runtime items also to the
// Claude Code version, so the launch gate opens for exactly those versions.
// The verification run is injected: no Claude, Keychain, or pane is used.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CapabilityRegistry, requiredCapabilities, type CapabilityId } from "../../../src/isolation/capabilities.ts";
import { PROFILE_TEMPLATE_VERSION } from "../../../src/isolation/profile.ts";
import { registerRadian } from "../../../src/ui/controller.ts";
import { openProjectSession } from "../../../src/ui/session.ts";
import type { VerificationRun } from "../../../src/verification/run.ts";
import { removeDir } from "../helpers/fixture.ts";
import { type FakeCtxState, FakeHost, context, fakeRuntime, managedWorld } from "../helpers/pi-host.ts";

const ALL = requiredCapabilities("claude-code", "developer");
const FAILING: CapabilityId = "runtime.claude-code.cancellation";

async function verifyWorld(failing: CapabilityId[] = [FAILING]) {
  const w = await managedWorld();
  const host = new FakeHost();
  let runs = 0;
  const run: VerificationRun = { runtime: "claude-code", runtimeVersion: "2.1.285", osVersion: "27.0.1", login: { authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "pro" }, results: ALL.map((capability) => ({ capability, passed: !failing.includes(capability), details: ["synthetic"] })) };
  const controller = registerRadian(host, { loadRuntime: async () => fakeRuntime, openSession: openProjectSession, startRun: w.startRun, verifyCapabilities: async () => (runs++, run) });
  const state: FakeCtxState = { confirms: [], confirmAnswer: true, notes: [] };
  const tui = context(w.projectDir, "tui", state);
  await host.emit("session_start", {}, tui);
  await host.emit("input", { text: "/radian capabilities verify", source: "interactive" }, tui);
  const registry = () => new CapabilityRegistry(controller.session()!.project.state);
  return { w, controller, state, tui, registry, runs: () => runs, cleanup: () => removeDir(w.root) };
}

const ctx = (runtimeVersion = "2.1.285") => ({ osVersion: "27.0.1", runtime: "claude-code" as const, runtimeVersion, policyTemplate: PROFILE_TEMPLATE_VERSION });

test("capability verify: interactive only; Cancel first; nothing runs or records without the user's choices", async () => {
  const g = await verifyWorld();
  try {
    assert.match(await g.controller.command("capabilities verify", context(g.w.projectDir, "print", g.state)), /NONINTERACTIVE_APPROVAL_REQUIRED/);
    await g.controller.command("status", g.tui);
    assert.equal(g.runs(), 0);
    // Dismissed start: nothing runs.
    assert.match(await g.controller.command("capabilities verify", g.tui), /not started/);
    assert.equal(g.runs(), 0);
    assert.equal(g.state.selects![0]!.options[0], "Cancel");
    // Run, then cancel the results: nothing recorded.
    g.state.selectAnswer = (_t, options) => (options.includes("Run verification") ? "Run verification" : "Cancel");
    assert.match(await g.controller.command("capabilities verify", g.tui), /Not recorded/);
    assert.equal(g.runs(), 1);
    const results = g.state.selects!.at(-1)!;
    assert.equal(results.options[0], "Cancel", "Enter on the results does not record");
    assert.match(results.title, /FAIL runtime\.claude-code\.cancellation/);
    assert.match(results.title, /usage page/, "the billing confirmation is stated");
    assert.equal(g.registry().require(ALL, ctx()).ok, false);
  } finally {
    g.cleanup();
  }
});

test("capability verify: records exactly the passed items, version-bound; the gate opens only when all required items pass", async () => {
  const g = await verifyWorld();
  try {
    g.state.selectAnswer = (_t, options) => options.find((o) => o === "Run verification" || o.startsWith("Record"));
    const out = await g.controller.command("capabilities verify", g.tui);
    assert.match(out, new RegExp(`Recorded ${ALL.length - 1} verified item`), out);
    const r = g.registry();
    assert.equal(r.status(FAILING, ctx()).state, "unverified", "a failed item is not recorded");
    assert.equal(r.status("runtime.claude-code.contained-launch", ctx()).state, "verified");
    assert.equal(r.status("runtime.claude-code.contained-launch", ctx("2.2.0")).state, "version-mismatch", "runtime items are bound to the Claude Code version");
    assert.equal(r.status("containment.sandbox-exec.filesystem", ctx("2.2.0")).state, "verified", "machine items hold across runtime versions");
    assert.equal(r.status("containment.dependency-access-audit", ctx("2.2.0")).state, "version-mismatch", "the dependency audit is per runtime version");
    assert.equal(r.latest("containment.sandbox-exec.filesystem")!.recordedBy !== undefined, true);
    assert.equal(r.require(ALL, ctx()).ok, false, "one required item still failed: dispatch stays blocked");
  } finally {
    g.cleanup();
  }
  const all = await verifyWorld([]);
  try {
    all.state.selectAnswer = (_t, options) => options.find((o) => o === "Run verification" || o.startsWith("Record"));
    await all.controller.command("capabilities verify", all.tui);
    assert.equal(all.registry().require(ALL, ctx()).ok, true, "every required item verified: the gate opens for these versions");
    assert.equal(all.registry().require(ALL, ctx("2.2.0")).ok, false, "and closes again for another Claude Code version");
  } finally {
    all.cleanup();
  }
});
