// R04 — approval revalidation at launch, recovery, and resume. Product
// approvals (spec/brief/plan) are re-derived from coordinator-owned artifact
// paths and the latest human decisions immediately before every actual attempt
// launch: initial, after capacity waits, inside the launch window, automatic and
// human-authorized recovery, question/pause resume, and quota retry. Refusals
// release reservations and leave a recoverable assignment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { success } from "../../../src/contracts/blockers.ts";
import { CapabilityRegistry } from "../../../src/isolation/capabilities.ts";
import type { HerdrRunner } from "../../../src/runtimes/herdr.ts";
import { launchAttempt } from "../../../src/runtimes/session.ts";
import { removeDir } from "../helpers/fixture.ts";
import { layout } from "../helpers/layout.ts";
import { deps, fakeCodex, request, source, verifyAll } from "../helpers/session-fixture.ts";
import { type World, human, plan, world } from "../helpers/coordinator-world.ts";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

const code = (outcome: { state: string; blocker?: { code: string } }) => (outcome.state === "blocked" ? outcome.blocker!.code : outcome.state);

async function reject(w: World, kind: "spec" | "plan") {
  const file = kind === "spec" ? "docs/spec.md" : "docs/plan.md";
  const recorded = await w.store.recordApproval(human(), { kind, task: w.taskId, artifact: { path: file, hash: w.artifacts[kind] }, decision: "rejected" });
  assert.ok(recorded.ok);
}

async function expectClean(w: World, assignment: string) {
  assert.equal((await w.capacity.list()).length, 0, "no reservation is leaked by a refusal");
  const a = w.store.state.assignments[assignment]!;
  const last = a.attempts.at(-1);
  if (last) assert.ok(last.status === "ended" && last.termination === "verified", "no attempt is left launching");
}

test("R04: approvals revoked or artifacts changed after prepare block the launch", async () => {
  for (const change of ["plan rejected (unchanged content)", "spec rejected", "spec edited", "plan deleted", "approval invalidated"] as const) {
    const w = await world();
    try {
      const p = plan(w, "developer");
      const prepared = await w.coordinator.prepare(p);
      assert.ok(prepared.ok);
      if (!prepared.ok) continue;
      if (change === "plan rejected (unchanged content)") await reject(w, "plan");
      if (change === "spec rejected") await reject(w, "spec");
      if (change === "spec edited") w.fixture.write("docs/spec.md", "# Spec\nSilently changed behavior.\n");
      if (change === "plan deleted") rmSync(path.join(w.repo.root, "docs", "plan.md"));
      if (change === "approval invalidated") {
        const id = Object.values(w.store.state.approvals).find((a) => a.kind === "plan")!.id;
        w.fixture.write("docs/plan.md", "# Plan\nChanged.\n");
        await w.store.invalidateChangedApprovals({ "docs/plan.md": w.coordinator.deps.artifactHash("docs/plan.md")! });
        assert.ok(w.store.state.approvals[id]!.invalidated);
        w.fixture.write("docs/plan.md", "# Plan\nSynthetic plan.\n");
      }
      w.driver.script("developer", { edit: { "src/a.ts": "launched anyway\n" } });
      const outcome = await w.coordinator.runAttempt(prepared.value.assignment, p, prepared.value);
      assert.match(code(outcome), /^APPROVAL_(MISSING|STALE)$/, `${change}: ${JSON.stringify(outcome)}`);
      assert.equal(w.driver.launches.length, 0, `${change}: no worker launched`);
      await expectClean(w, prepared.value.assignment);
    } finally {
      removeDir(w.root);
    }
  }
});

test("R04: revocation during the capacity wait or inside the launch window prevents the launch", async () => {
  const w = await world();
  try {
    // Capacity wait: the reservation is held open by a barrier while the user rejects the plan.
    const p = plan(w, "developer");
    const prepared = await w.coordinator.prepare(p);
    assert.ok(prepared.ok);
    if (!prepared.ok) return;
    const barrier = gate();
    const capacity = w.coordinator.deps.capacity;
    const reserve = capacity.reserve.bind(capacity);
    capacity.reserve = async (...args: Parameters<typeof reserve>) => {
      await barrier.opened;
      return reserve(...args);
    };
    const running = w.coordinator.runAttempt(prepared.value.assignment, p, prepared.value);
    await new Promise((r) => setTimeout(r, 20));
    await reject(w, "plan");
    barrier.open();
    assert.match(code(await running), /^APPROVAL_/);
    assert.equal(w.driver.launches.length, 0);
    capacity.reserve = reserve;
    await expectClean(w, prepared.value.assignment);

    // Launch window: the driver is mid-preflight (awaiting) when approval is revoked.
    await w.store.recordApproval(human(), { kind: "plan", task: w.taskId, artifact: { path: "docs/plan.md", hash: w.artifacts.plan }, decision: "approved" });
    const p2 = plan(w, "developer");
    const prepared2 = await w.coordinator.prepare(p2);
    assert.ok(prepared2.ok);
    if (!prepared2.ok) return;
    const preflight = gate();
    w.driver.script("developer", { launchGate: preflight.opened, edit: { "src/a.ts": "launched anyway\n" } });
    const running2 = w.coordinator.runAttempt(prepared2.value.assignment, p2, prepared2.value);
    await new Promise((r) => setTimeout(r, 20));
    await reject(w, "spec");
    preflight.open();
    assert.match(code(await running2), /^APPROVAL_/);
    assert.equal(w.driver.started.length, 0, "the launch authorization was rechecked at the last boundary; nothing started");
    await expectClean(w, prepared2.value.assignment);
    assert.equal(w.store.state.assignments[prepared2.value.assignment]!.automaticRecoveriesUsed, 0, "a refused launch does not consume recovery");
  } finally {
    removeDir(w.root);
  }
});

test("R04: revocation before automatic recovery, resume, or quota retry blocks the new attempt", async () => {
  // Automatic recovery after a verified infrastructure failure.
  {
    const w = await world();
    try {
      w.driver.script("developer", { bind: "fail", onStop: () => reject(w, "plan") }, { edit: { "src/a.ts": "recovered under a rejected plan\n" } });
      const outcome = await w.coordinator.runAssignment(plan(w, "developer"));
      assert.notEqual(outcome.state, "completed", JSON.stringify(outcome));
      assert.equal(w.driver.started.length, 1, "the recovery attempt did not start");
    } finally {
      removeDir(w.root);
    }
  }
  // Question → answered → plan rejected → resume.
  {
    const w = await world();
    try {
      w.driver.script("developer", { outcome: "blocked", question: "Which format?" });
      const p = plan(w, "developer");
      const prepared = await w.coordinator.prepare(p);
      assert.ok(prepared.ok);
      if (!prepared.ok) return;
      const asked = await w.coordinator.runAttempt(prepared.value.assignment, p, prepared.value);
      const decisionId = asked.state === "blocked" ? asked.decisionId! : "";
      assert.ok((await w.store.resolveDecision(human(), decisionId, "Structured.")).ok);
      await reject(w, "plan");
      w.driver.script("developer", { edit: { "src/a.ts": "resumed under a rejected plan\n" } });
      const resumed = await w.coordinator.resume(prepared.value.assignment, p, prepared.value, decisionId);
      assert.match(code(resumed), /^APPROVAL_/);
      assert.equal(w.driver.started.length, 1);
      await expectClean(w, prepared.value.assignment);
    } finally {
      removeDir(w.root);
    }
  }
  // Quota → spec edited → human-authorized retry.
  {
    const w = await world();
    try {
      w.driver.script("developer", { settle: "quota" });
      const p = plan(w, "developer");
      const prepared = await w.coordinator.prepare(p);
      assert.ok(prepared.ok);
      if (!prepared.ok) return;
      const first = await w.coordinator.runAttempt(prepared.value.assignment, p, prepared.value);
      const decisionId = first.state === "blocked" ? first.decisionId! : "";
      w.fixture.write("docs/spec.md", "# Spec\nEdited while waiting for quota.\n");
      w.driver.script("developer", { edit: { "src/a.ts": "retried under a changed spec\n" } });
      const retried = await w.coordinator.retryAfterQuota(human(), prepared.value.assignment, p, prepared.value, { decisionId, notBeforeMs: 0 });
      assert.match(code(retried), /^APPROVAL_/);
      assert.equal(w.driver.started.length, 1);
      // The retry authorization is not consumed by a refused launch: restoring the approved content lets it proceed.
      w.fixture.write("docs/spec.md", "# Spec\nSynthetic behavior.\n");
      const again = await w.coordinator.runAttempt(prepared.value.assignment, p, prepared.value, { humanDecisionId: decisionId });
      assert.equal(again.state, "completed", JSON.stringify(again));
    } finally {
      removeDir(w.root);
    }
  }
});

test("R04: unchanged approvals still launch, recover, and resume normally", async () => {
  const w = await world();
  try {
    w.driver.script("developer", { bind: "fail" }, { edit: { "src/a.ts": "recovered\n" } });
    const recovered = await w.coordinator.runAssignment(plan(w, "developer"));
    assert.equal(recovered.state, "completed", JSON.stringify(recovered));
    assert.equal(w.driver.started.length, 2);
    assert.equal((await w.capacity.list()).length, 0);
  } finally {
    removeDir(w.root);
  }
});

test("R04: the production session rechecks the launch authorization before credentials, before the pane, and before delivery", { skip: process.platform === "darwin" ? false : "dependency resolution requires macOS" }, async () => {
  const l = layout();
  try {
    await verifyAll(new CapabilityRegistry(l.state), "developer");
    const calls: string[][] = [];
    let revokeAt: "none" | "credentials" | "split" = "credentials";
    let revoked = false;
    const runner: HerdrRunner = async (args) => {
      calls.push([...args]);
      if (args[1] === "split") {
        if (revokeAt === "split") revoked = true; // the user rejects while pane creation is awaited
        return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: `fx:p${calls.length}` } } }), stderr: "", timedOut: false };
      }
      return { code: 0, stdout: "{}", stderr: "", timedOut: false };
    };
    const d = deps(l, fakeCodex(l, "bind-and-wait"), calls, true, runner);
    const authorize = () => (revoked ? { ok: false as const, blocker: { code: "APPROVAL_MISSING" as const, message: "plan was rejected by the user" } } : success(true as const));

    // Revoked before anything: no credential read, no pane.
    revoked = true;
    const reads = { count: 0 };
    const early = await launchAttempt(d, { ...request(l), credentialSource: source(reads), authorize });
    assert.equal(early.ok ? "ok" : early.blocker.code, "APPROVAL_MISSING");
    assert.equal(reads.count, 0, "no credential was projected");
    assert.equal(calls.length, 0, "no pane was created");

    // Revoked while the pane is being created: the launcher command is never delivered.
    revoked = false;
    revokeAt = "split";
    const late = await launchAttempt(d, { ...request(l), credentialSource: source(reads), authorize });
    assert.equal(late.ok ? "ok" : late.blocker.code, "APPROVAL_MISSING");
    assert.ok(!calls.some((c) => c[1] === "run"), "nothing was typed into the pane");
    assert.ok(calls.some((c) => c[1] === "close"), "the idle owned pane was closed");
    assert.deepEqual(readdirSync(path.join(l.root, "projections")).filter((x) => !x.startsWith(".")), [], "the credential projection was destroyed");
  } finally {
    removeDir(l.root);
  }
});
