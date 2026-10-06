import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readMetrics, summarize } from "../../../src/coordinator/metrics.ts";
import { Retrospectives } from "../../../src/coordinator/retrospective.ts";
import { gitText } from "../../../src/git/exec.ts";
import { HumanChannel } from "../../../src/state/approvals.ts";
import { removeDir } from "../helpers/fixture.ts";
import { type Behaviour, candidateRound, checkAndReview, human, plan, world } from "../helpers/coordinator-world.ts";

test("happy path: developer → tester → exact candidate → contained check → fresh review → human-approved integration", async () => {
  const w = await world();
  try {
    const candidate = await candidateRound(w, { kind: "target" });
    await checkAndReview(w, candidate, { findings: [{ severity: "minor", summary: "naming nit" }] });
    const summary = await w.coordinator.integrationSummary(w.taskId, ["unit"]);
    assert.ok(summary.ok && summary.value.ready, JSON.stringify(summary));
    const before = await w.coordinator.integrate(human(), w.taskId, ["unit"], { path: "docs/plan.md" });
    assert.equal(before.ok ? "ok" : before.blocker.code, "APPROVAL_MISSING", "no integration without the human decision");
    if (!summary.ok) return;
    await w.store.recordApproval(human(), { kind: "integration", task: w.taskId, artifact: { path: "docs/plan.md", hash: w.artifacts.plan }, candidate: summary.value.candidate, target: summary.value.target, decision: "approved" });
    const integrated = await w.coordinator.integrate(human(), w.taskId, ["unit"], { path: "docs/plan.md" });
    assert.ok(integrated.ok, integrated.ok ? "" : integrated.blocker.message);
    assert.equal(await gitText(w.repo.ctx, ["rev-parse", "refs/heads/main"]), candidate.commit);
    assert.equal(w.store.state.tasks[w.taskId]?.phase, "integrated");
    assert.equal((await w.capacity.list()).length, 0, "all reservations released after verified termination");
    assert.ok(w.driver.launches.every((l) => l.profile.runtime === "codex" && l.profile.model === "gpt-test-1"));
    assert.equal(new Set(w.driver.launches.map((l) => l.identity.attempt)).size, w.driver.launches.length, "every assignment had a fresh attempt");
    const reviewerLaunch = w.driver.launches.find((l) => l.identity.role === "reviewer")!;
    assert.deepEqual(reviewerLaunch.authority.writeRoots, [], "reviewer is report-only");
    const summaries = summarize(readMetrics(w.metrics.file));
    assert.equal(summaries[0]?.version, "0.0.0-test");
    assert.equal(summaries[0]?.tasksIntegrated, 1);
    assert.equal(summaries[0]?.firstRoundAcceptance, 1);
    assert.ok((summaries[0]?.usage.unknownCount ?? 0) > 0, "unknown usage is counted as unknown");
  } finally {
    removeDir(w.root);
  }
});

test("Plan mode and stale approvals block modifying dispatch; scouts may investigate in Plan", async () => {
  const w = await world();
  try {
    w.mode.set("plan");
    const blocked = await w.coordinator.runAssignment(plan(w, "developer"));
    assert.equal(blocked.state === "blocked" ? blocked.blocker.code : blocked.state, "MODE_PLAN");
    w.driver.script("scout", {});
    const scout = await w.coordinator.runAssignment(plan(w, "scout", { newCandidateRound: false }));
    assert.equal(scout.state, "completed");
    const integrate = await w.coordinator.integrate(human(), w.taskId, [], { path: "docs/plan.md" });
    assert.equal(integrate.ok ? "ok" : integrate.blocker.code, "MODE_PLAN");
    w.mode.set("build");
    w.fixture.write("docs/spec.md", "# Spec\nChanged behavior.\n");
    const changed = w.coordinator.deps.artifactHash("docs/spec.md")!;
    await w.store.invalidateChangedApprovals({ "docs/spec.md": changed });
    const stale = await w.coordinator.runAssignment(plan(w, "developer", { artifacts: { ...w.artifacts, spec: changed } }));
    assert.equal(stale.state === "blocked" ? stale.blocker.code : stale.state, "APPROVAL_STALE");
    const forged = Object.create(HumanChannel.prototype) as HumanChannel;
    const forgedIntegrate = await w.coordinator.integrate(forged, w.taskId, [], { path: "docs/plan.md" });
    assert.equal(forgedIntegrate.ok ? "ok" : forgedIntegrate.blocker.code, "APPROVAL_NOT_HUMAN");
  } finally {
    removeDir(w.root);
  }
});

test("bounded repairs: three candidate rounds, then exhaustion requires a human decision", async () => {
  const w = await world();
  try {
    let base: { kind: "target" } | { kind: "commit"; commit: string } = { kind: "target" };
    for (let round = 1; round <= 3; round += 1) {
      const candidate = await candidateRound(w, base);
      await checkAndReview(w, candidate, { findings: [{ severity: "blocker", summary: `defect ${round}` }] });
      const summary = await w.coordinator.integrationSummary(w.taskId, ["unit"]);
      assert.ok(summary.ok && !summary.value.ready);
      base = { kind: "commit", commit: candidate.commit };
    }
    assert.equal(w.store.state.tasks[w.taskId]?.roundsUsed, 3);
    w.driver.script("developer", { edit: { "src/a.ts": "fourth\n" } });
    const fourth = await w.coordinator.runAssignment(plan(w, "developer", { base }));
    assert.equal(fourth.state === "blocked" ? fourth.blocker.code : fourth.state, "ROUNDS_EXHAUSTED");
    assert.equal(w.store.state.tasks[w.taskId]?.phase, "blocked");
    assert.equal(summarize(readMetrics(w.metrics.file))[0]?.roundsExhausted, 1);
    // A repair candidate is a single commit on the unchanged target base.
    const lastCandidate = w.store.state.tasks[w.taskId]!.candidates.at(-1)!.candidate;
    assert.equal(lastCandidate.base, w.base);
  } finally {
    removeDir(w.root);
  }
});

test("questions pause and resume in a fresh attempt without consuming recovery", async () => {
  const w = await world();
  try {
    w.driver.script("developer", { outcome: "blocked", question: "Which error format?" });
    const p = plan(w, "developer");
    const prepared = await w.coordinator.prepare(p);
    assert.ok(prepared.ok);
    if (!prepared.ok) return;
    const asked = await w.coordinator.runAttempt(prepared.value.assignment, p, prepared.value);
    assert.equal(asked.state === "blocked" ? asked.blocker.code : asked.state, "QUESTION_OPEN");
    const decisionId = asked.state === "blocked" ? asked.decisionId! : "";
    const early = await w.coordinator.resume(prepared.value.assignment, p, prepared.value, decisionId);
    assert.equal(early.state === "blocked" ? early.blocker.code : early.state, "QUESTION_OPEN");
    assert.ok((await w.store.resolveDecision(human(), decisionId, "Use structured errors.")).ok);
    w.driver.script("developer", { edit: { "src/a.ts": "export const a = 2;\n" } });
    const resumed = await w.coordinator.resume(prepared.value.assignment, p, prepared.value, decisionId);
    assert.equal(resumed.state, "completed");
    const a = w.store.state.assignments[prepared.value.assignment]!;
    assert.equal(a.attempts.length, 2);
    assert.equal(a.automaticRecoveriesUsed, 0);
  } finally {
    removeDir(w.root);
  }
});

test("quota exhaustion preserves work; one scoped human-approved retry with the same profile", async () => {
  const w = await world();
  try {
    w.driver.script("developer", { settle: "quota" });
    const p = plan(w, "developer");
    const prepared = await w.coordinator.prepare(p);
    assert.ok(prepared.ok);
    if (!prepared.ok) return;
    const first = await w.coordinator.runAttempt(prepared.value.assignment, p, prepared.value);
    assert.equal(first.state === "blocked" ? first.blocker.code : first.state, "QUOTA_EXHAUSTED");
    const decisionId = first.state === "blocked" ? first.decisionId! : "";
    const tooEarly = await w.coordinator.retryAfterQuota(human(), prepared.value.assignment, p, prepared.value, { decisionId, notBeforeMs: Date.now() + 3_600_000 });
    assert.equal(tooEarly.state === "blocked" ? tooEarly.blocker.code : tooEarly.state, "QUOTA_EXHAUSTED");
    const otherProfile = await w.coordinator.retryAfterQuota(human(), prepared.value.assignment, p, { ...prepared.value, profile: { ...prepared.value.profile, effort: "high" } }, { decisionId, notBeforeMs: 0 });
    assert.equal(otherProfile.state === "blocked" ? otherProfile.blocker.code : otherProfile.state, "PROFILE_NOT_IN_CANDIDATES");
    w.driver.script("developer", { edit: { "src/a.ts": "export const a = 3;\n" } });
    const retried = await w.coordinator.retryAfterQuota(human(), prepared.value.assignment, p, prepared.value, { decisionId, notBeforeMs: 0 });
    assert.equal(retried.state, "completed", JSON.stringify(retried));
    assert.equal(summarize(readMetrics(w.metrics.file))[0]?.quotaBlocks["codex/gpt-test-1/medium"], 1);
  } finally {
    removeDir(w.root);
  }
});

test("infrastructure crash: one automatic fresh recovery, then a human decision", async () => {
  const w = await world();
  try {
    w.driver.script("developer", { bind: "fail" }, { edit: { "src/a.ts": "recovered\n" } });
    const recovered = await w.coordinator.runAssignment(plan(w, "developer"));
    assert.equal(recovered.state, "completed");
    w.driver.script("developer", { bind: "fail" }, { bind: "fail" });
    const exhausted = await w.coordinator.runAssignment(plan(w, "developer"));
    assert.equal(exhausted.state === "blocked" ? exhausted.blocker.code : exhausted.state, "RECOVERY_EXHAUSTED");
  } finally {
    removeDir(w.root);
  }
});

test("unknown termination keeps the slot and blocks replacement", async () => {
  const w = await world();
  try {
    w.driver.script("developer", { bind: "fail", termination: "unknown" });
    const outcome = await w.coordinator.runAssignment(plan(w, "developer"));
    assert.equal(outcome.state, "blocked");
    assert.equal((await w.capacity.list()).length, 1, "reservation retained while termination is unknown");
    const assignment = outcome.state === "blocked" ? outcome.assignment! : "";
    const replace = await w.store.startAttempt(assignment);
    assert.ok(!replace.ok);
  } finally {
    removeDir(w.root);
  }
});

test("target drift after assembly refuses integration; stale results are rejected", async () => {
  const w = await world();
  try {
    const candidate = await candidateRound(w, { kind: "target" });
    await checkAndReview(w, candidate, {});
    w.fixture.write("README.md", "user moved the target\n");
    await w.fixture.commitAll("user change");
    const summary = await w.coordinator.integrationSummary(w.taskId, ["unit"]);
    assert.ok(summary.ok && summary.value.gaps.includes("target moved since assembly"));
    // A stale result is never accepted; the single automatic recovery also returns a stale result.
    w.driver.script("developer", { staleGeneration: true, edit: { "src/a.ts": "x\n" } }, { staleGeneration: true });
    const stale = await w.coordinator.runAssignment(plan(w, "developer", { newCandidateRound: true }));
    assert.equal(stale.state === "blocked" ? stale.blocker.code : stale.state, "RECOVERY_EXHAUSTED");
    assert.ok(summarize(readMetrics(w.metrics.file))[0]!.staleResults >= 1);
  } finally {
    removeDir(w.root);
  }
});

test("retrospectives are private proposals: no guardrail weakening, human decision only, never auto-applied", async () => {
  const w = await world();
  try {
    const candidate = await candidateRound(w, { kind: "target" });
    assert.ok(candidate.commit);
    const retros = new Retrospectives(path.join(w.root, "project-state"));
    const weakening = retros.create(readMetrics(w.metrics.file), { problem: "Too many approval prompts", change: "Remove the plan approval gate", expectedBenefit: "speed", regressionRisk: "high", evaluation: "n/a", rollback: "n/a" });
    assert.equal(weakening.ok ? "ok" : weakening.blocker.code, "AUTHORITY_INVALID");
    const ok = retros.create(readMetrics(w.metrics.file), { problem: "Briefs omit check commands", change: "Add a brief template section listing check commands", expectedBenefit: "fewer clarification questions", regressionRisk: "low", evaluation: "compare clarification counts", rollback: "revert the template" });
    assert.ok(ok.ok && ok.value.autoApply === false && ok.value.status === "proposed");
    if (!ok.ok) return;
    const forged = Object.create(HumanChannel.prototype) as HumanChannel;
    assert.equal(retros.decide(forged, ok.value.id, "approved-for-separate-task", "x").ok, false);
    const decided = retros.decide(human(), ok.value.id, "approved-for-separate-task", "schedule a harness task");
    assert.ok(decided.ok && decided.value.status === "approved-for-separate-task");
    assert.ok(ok.value.observations.some((o) => o.includes("small sample")));
  } finally {
    removeDir(w.root);
  }
});

test("resume reconciliation: unknown attempts keep slots; verified ones are reclaimed; nothing relaunches", async () => {
  const w = await world();
  try {
    const p = plan(w, "developer");
    const prepared = await w.coordinator.prepare(p);
    assert.ok(prepared.ok);
    if (!prepared.ok) return;
    const assignment = prepared.value.assignment;
    // Simulate a crash mid-attempt: reservation and attempt exist, no live handle.
    const reservation = await w.capacity.reserve(3, { project: "prj_fixture1", run: w.store.state.run.id, assignment, role: "developer" });
    assert.ok(reservation.ok);
    assert.ok((await w.store.startAttempt(assignment)).ok);
    const launchesBefore = w.driver.launches.length;
    const unknown = await w.coordinator.reconcileOnResume(() => "unknown");
    assert.equal(unknown.attempts.unknown.length, 1);
    assert.equal(unknown.reclaimed.length, 0);
    assert.equal((await w.capacity.list()).length, 1);
    const replace = await w.store.startAttempt(assignment);
    assert.equal(replace.ok ? "ok" : replace.blocker.code, "TERMINATION_UNVERIFIED");
    const verified = await w.coordinator.reconcileOnResume(() => "terminated");
    assert.equal(verified.reclaimed.length, 1);
    assert.deepEqual(verified.worktreeIssues, []);
    assert.equal(w.driver.launches.length, launchesBefore, "reconciliation never relaunches");
  } finally {
    removeDir(w.root);
  }
});
