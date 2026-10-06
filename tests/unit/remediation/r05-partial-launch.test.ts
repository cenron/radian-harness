// R05 — partial-launch reconciliation and retained ownership. Once a launch
// command may have reached an owned pane, the attempt is owned work: it is
// stopped, its delayed launcher is revoked, and a termination postcondition is
// established before capacity, worktree ownership, or watcher coverage is
// released. Exercised with the production RuntimeWorkerDriver and session over
// a fake Herdr runner (no existing panes), synthetic credentials, and, where
// noted, the real launcher under sandbox-exec.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { RuntimeWorkerDriver } from "../../../src/coordinator/driver.ts";
import { CapabilityRegistry } from "../../../src/isolation/capabilities.ts";
import { SupervisionRegistry } from "../../../src/isolation/registry.ts";
import type { HerdrRunner } from "../../../src/runtimes/herdr.ts";
import { launchAttempt, stopAttempt } from "../../../src/runtimes/session.ts";
import { removeDir } from "../helpers/fixture.ts";
import { layout } from "../helpers/layout.ts";
import { type World, human, plan, world } from "../helpers/coordinator-world.ts";
import { deps, fakeCodex, native, request, source, verifyAll } from "../helpers/session-fixture.ts";

type RunBehaviour = "refuse" | "timeout" | "intent-then-refuse" | "delayed-launcher";

/** A fake Herdr runner: pane creation succeeds; the run step follows the scripted behaviour. */
function runner(calls: string[][], behaviour: () => RunBehaviour, stateDir: () => string): HerdrRunner {
  let n = 0;
  return async (args) => {
    calls.push([...args]);
    if (args[1] === "split") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: `fx:r${++n}` } } }), stderr: "", timedOut: false };
    if (args[1] === "run") {
      const mode = behaviour();
      if (mode === "timeout") return { code: null, stdout: "", stderr: "", timedOut: true };
      if (mode === "intent-then-refuse") {
        // The launcher began (recorded its intent) and then lost contact: an interrupted registration.
        const command = args[3]!;
        const spec = /'([^']*spec\.json)'/.exec(command)?.[1] ?? "";
        const attempt = path.basename(path.dirname(spec));
        const assignment = readdirSync(path.join(stateDir(), "supervision")).find((d) => d.startsWith("asg_"))!;
        await new SupervisionRegistry(stateDir(), assignment).append({ kind: "intent", attempt, label: "runtime" });
      }
      if (mode === "delayed-launcher") {
        // Herdr reports an error, but the pane's shell runs the launcher later anyway.
        setTimeout(() => {
          const child = spawn("/bin/sh", ["-c", args[3]!], { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
          child.unref();
        }, 1_500);
      }
      return { code: 1, stdout: "", stderr: "synthetic transport error", timedOut: false };
    }
    return { code: 0, stdout: "{}", stderr: "", timedOut: false };
  };
}

/** A coordinator world whose driver is the production RuntimeWorkerDriver over a fake transport. */
async function productionWorld(behaviour: RunBehaviour) {
  const w = await world();
  const l = layout();
  const calls: string[][] = [];
  let mode = behaviour;
  await verifyAll(new CapabilityRegistry(w.stateDir), "developer");
  const sessionDeps = { ...deps(l, fakeCodex(l, "exit-early"), calls, true, runner(calls, () => mode, () => w.stateDir)), stateDir: w.stateDir, capabilities: new CapabilityRegistry(w.stateDir), projectionRoot: path.join(l.root, "projections") };
  w.coordinator.deps.driver = new RuntimeWorkerDriver(sessionDeps);
  const reads = { count: 0 };
  w.coordinator.deps.credentialSourceFor = () => source(reads);
  return { w, l, calls, reads, setMode: (m: RunBehaviour) => (mode = m), cleanup: () => (removeDir(w.root), removeDir(l.root)) };
}

function registryOf(w: World) {
  const assignment = Object.keys(w.store.state.assignments)[0]!;
  return { assignment, registry: new SupervisionRegistry(w.stateDir, assignment) };
}

const projections = (l: { root: string }) => (existsSync(path.join(l.root, "projections")) ? readdirSync(path.join(l.root, "projections")).filter((x) => !x.startsWith(".")) : []);

test("R05: the session reports a delivery failure after pane creation as an owned, possibly-started launch", { skip: process.platform === "darwin" ? false : "dependency resolution requires macOS" }, async () => {
  const l = layout();
  try {
    await verifyAll(new CapabilityRegistry(l.state), "developer");
    const calls: string[][] = [];
    const d = deps(l, fakeCodex(l, "exit-early"), calls, true, runner(calls, () => "refuse", () => l.state));
    const out = await launchAttempt(d, { ...request(l), credentialSource: source({ count: 0 }) });
    assert.equal(out.ok, false);
    assert.equal((out as { started?: string }).started, "uncertain", "a command that may have been typed is not a verified non-start");
    const partial = (out as { attempt?: { paneId: string; projection: { dir: string } } }).attempt;
    assert.ok(partial?.paneId, "the owned pane and projection are carried for cleanup");
    // Cleanup revokes the delayed launch, then establishes the postcondition; it is idempotent.
    const stopped = await stopAttempt(d, partial as never, request(l).authority);
    assert.equal(stopped.termination.postcondition, "verified");
    const again = await stopAttempt(d, partial as never, request(l).authority);
    assert.equal(again.termination.postcondition, "verified");
    assert.ok(!existsSync(partial!.projection.dir));
  } finally {
    removeDir(l.root);
  }
});

test("R05: refused delivery and an error-response delivery are stopped and reconciled before capacity is released", { skip: process.platform === "darwin" ? false : "dependency resolution requires macOS" }, async () => {
  const pw = await productionWorld("refuse");
  try {
    const outcome = await pw.w.coordinator.runAssignment(plan(pw.w, "developer"));
    assert.equal(outcome.state, "blocked", JSON.stringify(outcome));
    const { assignment, registry } = registryOf(pw.w);
    const a = pw.w.store.state.assignments[assignment]!;
    assert.equal(a.attempts.length, 2, "verified cleanup allows the one bounded automatic recovery");
    for (const attempt of a.attempts) {
      assert.equal(attempt.endReason, "infrastructure", "a possibly-started launch is an executed attempt, not a pre-launch refusal");
      assert.ok(registry.entries().some((e) => e.kind === "revoked" && e.attempt === attempt.id), "the delayed launch was revoked");
      assert.ok(registry.entries().some((e) => e.kind === "terminated" && e.attempt === attempt.id && e.postcondition === "verified"), "termination was established before release");
    }
    assert.equal((await pw.w.capacity.list()).length, 0, "released only after verified termination");
    assert.deepEqual(projections(pw.l), [], "credential projections destroyed during cleanup");
    assert.ok(pw.calls.filter((c) => c[1] === "close").length >= 2, "owned panes closed after verified termination");
  } finally {
    pw.cleanup();
  }
});

test("R05: an interrupted registration keeps capacity and worktree ownership and blocks replacement", { skip: process.platform === "darwin" ? false : "dependency resolution requires macOS" }, async () => {
  const pw = await productionWorld("intent-then-refuse");
  try {
    const outcome = await pw.w.coordinator.runAssignment(plan(pw.w, "developer"));
    assert.notEqual(outcome.state, "completed");
    const { assignment } = registryOf(pw.w);
    const a = pw.w.store.state.assignments[assignment]!;
    assert.equal(a.attempts.length, 1, "no replacement while termination is unknown");
    assert.equal(a.attempts[0]!.termination, "unknown");
    assert.equal((await pw.w.capacity.list()).length, 1, "the slot stays reserved");
    // Even after the user answers the opened decision, the unknown termination blocks replacement.
    if (outcome.state === "blocked" && outcome.decisionId) assert.ok((await pw.w.store.resolveDecision(human(), outcome.decisionId, "retry")).ok);
    const replace = await pw.w.store.startAttempt(assignment);
    assert.equal(replace.ok ? "ok" : replace.blocker.code, "TERMINATION_UNVERIFIED");
    assert.ok(!pw.calls.some((c) => c[1] === "close"), "the pane stays open for inspection");
    // Repeated cleanup is idempotent and still cannot claim verification.
    const cancelled = await pw.w.coordinator.cancel(assignment);
    assert.equal(cancelled.ok && cancelled.value.termination, "unknown", "a repeated stop is retried and reported honestly");
    assert.equal((await pw.w.capacity.list()).length, 1);
  } finally {
    pw.cleanup();
  }
});

test("R05: a delayed launcher that starts after cleanup is refused and never starts the runtime", { skip: native ? false : "requires macOS sandbox-exec" }, async () => {
  const pw = await productionWorld("delayed-launcher");
  try {
    const outcome = await pw.w.coordinator.runAssignment(plan(pw.w, "developer"));
    assert.notEqual(outcome.state, "completed");
    // Give the delayed launchers time to start and finish.
    await new Promise((r) => setTimeout(r, 6_000));
    const { assignment, registry } = registryOf(pw.w);
    const a = pw.w.store.state.assignments[assignment]!;
    for (const attempt of a.attempts) {
      const entries = registry.entries().filter((e) => e.attempt === attempt.id);
      assert.ok(!entries.some((e) => e.kind === "process" || e.kind === "exited"), `attempt ${attempt.id}: the runtime never started after revocation`);
      assert.ok(!entries.some((e) => e.kind === "intent"), "the launcher refused before recording any intent");
    }
  } finally {
    pw.cleanup();
  }
});

test("R05: orchestration distinguishes refused, uncertain-verified, and uncertain-unknown launches", async () => {
  const w = await world();
  try {
    // Refused before anything started: released cleanly, no recovery consumed, nothing to stop.
    w.driver.script("developer", { launchResult: "refused" });
    const refused = await w.coordinator.runAssignment(plan(w, "developer"));
    assert.equal(refused.state === "blocked" ? refused.blocker.code : refused.state, "CAPABILITY_UNVERIFIED");
    const r = w.store.state.assignments[refused.assignment!]!;
    assert.equal(r.attempts[0]!.endReason, "not-started");
    assert.equal(r.automaticRecoveriesUsed, 0);
    assert.equal(w.driver.stops.length, 0);
    assert.equal((await w.capacity.list()).length, 0);

    // Possibly started, then verified stopped: stopped before release, then one bounded recovery.
    w.driver.script("developer", { launchResult: "uncertain" }, { edit: { "src/a.ts": "recovered\n" } });
    const recovered = await w.coordinator.runAssignment(plan(w, "developer"));
    assert.equal(recovered.state, "completed", JSON.stringify(recovered));
    assert.equal(w.driver.stops.length, 2, "the uncertain launch was stopped, then the recovery's normal stop");
    assert.equal((await w.capacity.list()).length, 0);

    // Possibly started, termination unknown: ownership retained, no replacement, repeated stop retried.
    w.driver.script("developer", { launchResult: "uncertain", termination: "unknown" });
    const unknown = await w.coordinator.runAssignment(plan(w, "developer"));
    assert.notEqual(unknown.state, "completed");
    const u = w.store.state.assignments[unknown.assignment!]!;
    assert.equal(u.attempts.length, 1);
    assert.equal((await w.capacity.list()).length, 1, "the slot stays reserved");
    const stopsBefore = w.driver.stops.length;
    const cancelled = await w.coordinator.cancel(unknown.assignment!);
    assert.equal(cancelled.ok && cancelled.value.termination, "unknown");
    assert.equal(w.driver.stops.length, stopsBefore + 1, "cancel retried the stop on the retained handle");
    assert.equal((await w.capacity.list()).length, 1);
  } finally {
    removeDir(w.root);
  }
});
