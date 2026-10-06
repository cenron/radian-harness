// W06 / F02 follow-up (independent review) — integration must be backed by the
// required checks of the task's *current* human-approved plan revision, not by
// whatever check list the caller passes or definitions recorded under an
// earlier revision. Real coordinator, run store, Git, and evidence files; fake
// worker driver (no check command or candidate code is executed).

import { test } from "node:test";
import assert from "node:assert/strict";
import { removeDir } from "../helpers/fixture.ts";
import { type World, candidateRound, checkAndReview, human, plan, world } from "../helpers/coordinator-world.ts";

async function approvePlan(w: World, text: string, decision: "approved" | "rejected" = "approved") {
  w.fixture.write("docs/plan.md", text);
  const hash = w.coordinator.deps.artifactHash("docs/plan.md")!;
  const recorded = await w.store.recordApproval(human(), { kind: "plan", task: w.taskId, artifact: { path: "docs/plan.md", hash }, decision });
  assert.ok(recorded.ok);
  return hash;
}

async function approveIntegration(w: World, planHash: string) {
  const summary = await w.coordinator.integrationSummary(w.taskId, []);
  assert.ok(summary.ok, JSON.stringify(summary));
  if (!summary.ok) throw new Error("summary");
  await w.store.recordApproval(human(), { kind: "integration", task: w.taskId, artifact: { path: "docs/plan.md", hash: planHash }, candidate: summary.value.candidate, target: summary.value.target, decision: "approved" });
}

const code = (o: { ok: boolean; blocker?: { code: string } }) => (o.ok ? "ok" : o.blocker!.code);

test("F02 follow-up: a revised plan that adds a check makes the candidate not ready until that check passes", async () => {
  const w = await world();
  try {
    const candidate = await candidateRound(w, { kind: "target" });
    await checkAndReview(w, candidate, {});
    const before = await w.coordinator.integrationSummary(w.taskId, w.coordinator.evidence(w.taskId).requiredChecks ?? []);
    assert.ok(before.ok && before.value.ready, `baseline ready under the original plan: ${JSON.stringify(before)}`);
    const revised = await approvePlan(w, '# Plan\nRevised.\n\n```radian-checks\nunit: ["npm", "test"]\nlint: ["npm", "run", "lint"]\n```\n');
    const after = await w.coordinator.integrationSummary(w.taskId, w.coordinator.evidence(w.taskId).requiredChecks ?? []);
    assert.ok(after.ok);
    if (!after.ok) return;
    assert.equal(after.value.ready, false, `a check added by the approved revision is required: ${JSON.stringify(after.value.gaps)}`);
    assert.ok(after.value.gaps.some((g) => /lint/.test(g)), JSON.stringify(after.value.gaps));
    await approveIntegration(w, revised);
    const integrated = await w.coordinator.integrate(human(), w.taskId, ["unit"], { path: "docs/plan.md" });
    assert.notEqual(code(integrated), "ok", "integration refuses evidence defined by a superseded plan revision");
  } finally {
    removeDir(w.root);
  }
});

test("F02 follow-up: a revised plan that changes a check's command does not accept outcomes of the old command", async () => {
  const w = await world();
  try {
    const candidate = await candidateRound(w, { kind: "target" });
    await checkAndReview(w, candidate, {});
    const revised = await approvePlan(w, '# Plan\nRevised.\n\n```radian-checks\nunit: ["npm", "run", "test:ci"]\n```\n');
    const after = await w.coordinator.integrationSummary(w.taskId, ["unit"]);
    assert.ok(after.ok && !after.value.ready, `the old command's pass does not satisfy the revised definition: ${JSON.stringify(after)}`);
    await approveIntegration(w, revised);
    assert.notEqual(code(await w.coordinator.integrate(human(), w.taskId, ["unit"], { path: "docs/plan.md" })), "ok");
  } finally {
    removeDir(w.root);
  }
});

test("F02 follow-up: the caller's check list cannot shrink the approved plan's required checks", async () => {
  const w = await world();
  try {
    const candidate = await candidateRound(w, { kind: "target" });
    // Review only: no candidate check ran.
    w.driver.script("reviewer", {});
    const review = await w.coordinator.runAssignment(plan(w, "reviewer", { base: { kind: "commit", commit: candidate.commit } }));
    assert.equal(review.state, "completed");
    if (review.state === "completed") w.coordinator.recordReview(w.taskId, candidate.commit, review.result);
    const summary = await w.coordinator.integrationSummary(w.taskId, []);
    assert.ok(summary.ok && !summary.value.ready, `an empty caller list does not make an unchecked candidate ready: ${JSON.stringify(summary)}`);
    await approveIntegration(w, w.artifacts.plan);
    assert.notEqual(code(await w.coordinator.integrate(human(), w.taskId, [], { path: "docs/plan.md" })), "ok", "integrate with an empty list is refused");
  } finally {
    removeDir(w.root);
  }
});

test("F02 follow-up: a later plan rejection blocks integration; an older approved revision cannot define checks", async () => {
  const w = await world();
  try {
    const original = w.artifacts.plan;
    const candidate = await candidateRound(w, { kind: "target" });
    await checkAndReview(w, candidate, {});
    await approveIntegration(w, original);
    await approvePlan(w, '# Plan\nSynthetic plan.\n\n```radian-checks\nunit: ["npm", "test"]\n```\n', "rejected");
    const summary = await w.coordinator.integrationSummary(w.taskId, ["unit"]);
    assert.ok(summary.ok && !summary.value.ready, `a rejected plan leaves nothing to integrate against: ${JSON.stringify(summary)}`);
    assert.notEqual(code(await w.coordinator.integrate(human(), w.taskId, ["unit"], { path: "docs/plan.md" })), "ok");
    // A newer approved revision supersedes the original for check definitions.
    await approvePlan(w, '# Plan\nNewer.\n\n```radian-checks\nunit: ["npm", "test"]\n```\n');
    w.driver.script("tester", { checks: [{ id: "unit", outcome: "passed" }] });
    const old = await w.coordinator.runAssignment(plan(w, "tester", { purpose: "candidate-check", base: { kind: "commit", commit: candidate.commit }, writeRoots: [], requiredChecks: [{ id: "unit", description: "u", argv: ["npm", "test"] }], artifacts: { ...w.artifacts, plan: original } }));
    assert.notEqual(old.state, "completed", "the superseded revision cannot define or run checks");
  } finally {
    removeDir(w.root);
  }
});
