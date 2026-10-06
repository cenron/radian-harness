import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { CapabilityRegistry } from "../../../src/isolation/capabilities.ts";
import { awaitBinding, launchAttempt, preflight, stopAttempt } from "../../../src/runtimes/session.ts";
import { psProbe } from "../../../src/util/process-identity.ts";
import { removeDir } from "../helpers/fixture.ts";
import { authorityFor, layout } from "../helpers/layout.ts";
import { deps, fakeCodex, native, request, source, verifyAll } from "../helpers/session-fixture.ts";

test("preflight blocks before any credential read when capabilities, supervision, or pairing fail", async () => {
  const l = layout();
  try {
    const calls: string[][] = [];
    const reads = { count: 0 };
    const r = request(l);
    const blocked = await launchAttempt(deps(l, fakeCodex(l, "bind-and-wait"), calls), { ...r, credentialSource: source(reads) });
    assert.equal(blocked.ok ? "ok" : blocked.blocker.code, "CAPABILITY_UNVERIFIED");
    await verifyAll(new CapabilityRegistry(l.state), "developer");
    const unhealthy = await launchAttempt(deps(l, fakeCodex(l, "bind-and-wait"), calls, false), { ...r, credentialSource: source(reads) });
    assert.equal(unhealthy.ok ? "ok" : unhealthy.blocker.code, "SUPERVISION_UNHEALTHY");
    const disguised = await preflight(deps(l, fakeCodex(l, "bind-and-wait"), calls), { ...r, profile: { ...r.profile, model: "claude-test-model-1" } });
    assert.equal(disguised.ok ? "ok" : disguised.blocker.code, "ANTHROPIC_REQUIRES_CLAUDE_CODE");
    assert.equal(reads.count, 0, "no credential was read");
    assert.equal(calls.length, 0, "no pane was created");
  } finally {
    removeDir(l.root);
  }
});

test("contained fake runtime: owned pane, registration before binding, semantic binding, verified stop", { skip: native ? false : "requires macOS sandbox-exec" }, async () => {
  const l = layout();
  try {
    const calls: string[][] = [];
    const reads = { count: 0 };
    await verifyAll(new CapabilityRegistry(l.state), "developer");
    const d = deps(l, fakeCodex(l, "bind-and-wait"), calls);
    const launched = await launchAttempt(d, { ...request(l), credentialSource: source(reads) });
    assert.ok(launched.ok, launched.ok ? "" : launched.blocker.message);
    if (!launched.ok) return;
    assert.equal(reads.count, 1);
    assert.deepEqual(calls[0]?.slice(0, 5), ["pane", "split", "--pane", "fx:p0", "--direction"]);
    assert.ok(calls[0]?.includes("--no-focus"));
    const binding = await awaitBinding(d, launched.value, Date.now() + 20_000);
    assert.ok(binding.ok, binding.ok ? "" : binding.blocker.message);
    if (!binding.ok) return;
    assert.equal(psProbe(binding.value.runtimeProcess.pid).state, "running");
    const stopped = await stopAttempt(d, launched.value, authorityFor(l));
    assert.equal(stopped.termination.postcondition, "verified");
    assert.equal(psProbe(binding.value.runtimeProcess.pid).state, "absent");
    assert.ok(stopped.paneClosed);
    assert.ok(!existsSync(launched.value.projection.dir), "credential projection destroyed");
    assert.deepEqual(calls.at(-1)?.slice(0, 2), ["pane", "close"]);
  } finally {
    removeDir(l.root);
  }
});

test("a runtime that exits before reporting a session is never bound", { skip: native ? false : "requires macOS sandbox-exec" }, async () => {
  const l = layout();
  try {
    const calls: string[][] = [];
    await verifyAll(new CapabilityRegistry(l.state), "developer");
    const d = deps(l, fakeCodex(l, "exit-early"), calls);
    const launched = await launchAttempt(d, { ...request(l), credentialSource: source({ count: 0 }) });
    assert.ok(launched.ok);
    if (!launched.ok) return;
    const binding = await awaitBinding(d, launched.value, Date.now() + 15_000);
    assert.equal(binding.ok ? "ok" : binding.blocker.code, "BINDING_UNCONFIRMED");
    const stopped = await stopAttempt(d, launched.value, authorityFor(l));
    assert.equal(stopped.termination.postcondition, "verified");
  } finally {
    removeDir(l.root);
  }
});
