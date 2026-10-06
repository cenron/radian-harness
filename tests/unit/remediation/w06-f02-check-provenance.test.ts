// W06 / F02 (R03) — required check argument vectors and their approval
// provenance survive candidate repair, coordinator restart, and project-context
// restore; the same check id cannot run a substituted command under unchanged
// approvals, and initial definitions must come from the human-approved plan.
// Real coordinator, run store, Git, and evidence files; fake worker driver (no
// check command or candidate code is executed).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Coordinator } from "../../../src/coordinator/orchestrator.ts";
import { removeDir } from "../helpers/fixture.ts";
import { type World, candidateRound, human, plan, world } from "../helpers/coordinator-world.ts";

const NPM_TEST = { id: "unit", description: "unit tests", argv: ["npm", "test"] };
const SUBSTITUTED = { id: "unit", description: "unit tests", argv: ["/usr/bin/true"] };

async function check(w: World, candidate: string, checks: Array<{ id: string; description: string; argv: string[] }>) {
  w.driver.script("tester", { checks: checks.map((c) => ({ id: c.id, outcome: "passed" as const })) });
  return w.coordinator.runAssignment(plan(w, "tester", { purpose: "candidate-check", base: { kind: "commit", commit: candidate }, writeRoots: [], requiredChecks: checks }));
}

const outcomeCode = (o: { state: string; blocker?: { code: string } }) => (o.state === "blocked" ? o.blocker!.code : o.state);
const launchedArgv = (w: World) => w.driver.launches.flatMap((l) => (l.checks?.runs ?? []).map((r) => r.argv.join(" ")));

test("F02: after repair, the same check id cannot run a substituted command under unchanged approvals", async () => {
  const w = await world();
  try {
    const first = await candidateRound(w, { kind: "target" });
    assert.equal((await check(w, first.commit, [NPM_TEST])).state, "completed");
    const repair = await candidateRound(w, { kind: "commit", commit: first.commit });
    const substituted = await check(w, repair.commit, [SUBSTITUTED]);
    assert.notEqual(substituted.state, "completed", `a substituted command was accepted: ${JSON.stringify(substituted)}`);
    assert.match(outcomeCode(substituted), /CANDIDATE_MISMATCH|APPROVAL/);
    assert.ok(!launchedArgv(w).includes("/usr/bin/true"), "the substituted vector was never sent to a launcher");
    assert.deepEqual(w.coordinator.evidence(w.taskId).requiredCheckArgv?.unit, ["npm", "test"], "the approved definition survives assembly");
    // The approved command still runs on the repaired candidate.
    assert.equal((await check(w, repair.commit, [NPM_TEST])).state, "completed");
  } finally {
    removeDir(w.root);
  }
});

test("F02: definitions survive a coordinator restart (context restore) with unchanged approvals", async () => {
  const w = await world();
  try {
    const first = await candidateRound(w, { kind: "target" });
    assert.equal((await check(w, first.commit, [NPM_TEST])).state, "completed");
    const repair = await candidateRound(w, { kind: "commit", commit: first.commit });
    // A fresh coordinator over the same durable state (restart / project re-selection).
    w.coordinator = new Coordinator(w.coordinator.deps);
    const substituted = await check(w, repair.commit, [SUBSTITUTED]);
    assert.notEqual(substituted.state, "completed", `restart forgot the approved definition: ${JSON.stringify(substituted)}`);
    assert.ok(!launchedArgv(w).includes("/usr/bin/true"));
  } finally {
    removeDir(w.root);
  }
});

test("F02: initial check definitions need approval provenance from the human-approved plan", async () => {
  const w = await world();
  try {
    const first = await candidateRound(w, { kind: "target" });
    // The approved plan declares `unit: npm test`; a first-seen different vector is not approval.
    const unapprovedVector = await check(w, first.commit, [SUBSTITUTED]);
    assert.notEqual(unapprovedVector.state, "completed", `an unapproved first definition was accepted: ${JSON.stringify(unapprovedVector)}`);
    const undeclared = await check(w, first.commit, [NPM_TEST, { id: "lint", description: "lint", argv: ["npm", "run", "lint"] }]);
    assert.notEqual(undeclared.state, "completed", "a check the approved plan does not declare is refused");
    assert.ok(!launchedArgv(w).some((a) => a === "/usr/bin/true" || a === "npm run lint"));
  } finally {
    removeDir(w.root);
  }
});

test("F02: an approved plan revision may change a definition; old outcomes are not reused", async () => {
  const w = await world();
  try {
    const first = await candidateRound(w, { kind: "target" });
    assert.equal((await check(w, first.commit, [NPM_TEST])).state, "completed");
    const repair = await candidateRound(w, { kind: "commit", commit: first.commit });
    const revised = '# Plan\nSynthetic plan, revised.\n\n```radian-checks\nunit: ["npm", "run", "test:ci"]\n```\n';
    w.fixture.write("docs/plan.md", revised);
    const hash = w.coordinator.deps.artifactHash("docs/plan.md")!;
    await w.store.recordApproval(human(), { kind: "plan", task: w.taskId, artifact: { path: "docs/plan.md", hash }, decision: "approved" });
    w.artifacts.plan = hash;
    const ci = { id: "unit", description: "unit tests (ci)", argv: ["npm", "run", "test:ci"] };
    const outcome = await check(w, repair.commit, [ci]);
    assert.equal(outcome.state, "completed", JSON.stringify(outcome));
    const evidence = w.coordinator.evidence(w.taskId);
    assert.deepEqual(evidence.requiredCheckArgv?.unit, ["npm", "run", "test:ci"]);
    assert.ok(evidence.checks.every((c) => c.candidate === repair.commit), "only the repaired candidate's outcomes count");
  } finally {
    removeDir(w.root);
  }
});
