import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { success, type Outcome } from "../../../src/contracts/blockers.ts";
import type { Role } from "../../../src/contracts/identity.ts";
import { loadAndResolve, resolveConfig } from "../../../src/config/resolve.ts";
import type { ConfigSnapshot } from "../../../src/config/resolve.ts";
import type { SettledOutcome, WorkerDriver, WorkerHandle, WorkerLaunchRequest } from "../../../src/coordinator/driver.ts";
import { MetricsRecorder, readMetrics, summarize } from "../../../src/coordinator/metrics.ts";
import { ModeState } from "../../../src/coordinator/mode.ts";
import { Coordinator, type AssignmentPlan } from "../../../src/coordinator/orchestrator.ts";
import { Retrospectives } from "../../../src/coordinator/retrospective.ts";
import { openRepository } from "../../../src/git/repository.ts";
import { gitText } from "../../../src/git/exec.ts";
import { WorktreeManager } from "../../../src/git/worktrees.ts";
import { HumanChannel } from "../../../src/state/approvals.ts";
import { CapacityLedger } from "../../../src/state/capacity.ts";
import { CoordinatorLease } from "../../../src/state/lease.ts";
import { RunStore } from "../../../src/state/run-store.ts";
import { systemClock } from "../../../src/util/clock.ts";
import { makeRepo, removeDir, tempDir } from "../helpers/fixture.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKERS = path.resolve(HERE, "../../../workers");
const human = () => HumanChannel.fromUserInput("user-command", "fixture-user", "/radian approve");

type Behaviour = {
  bind?: "ok" | "fail";
  settle?: "success" | "quota" | "timeout";
  termination?: "verified" | "unknown";
  edit?: Record<string, string>;
  outcome?: "completed" | "blocked";
  question?: string;
  checks?: Array<{ id: string; outcome: "passed" | "failed" }>;
  findings?: Array<{ severity: "blocker" | "minor"; summary: string }>;
  staleGeneration?: boolean;
};

class FakeDriver implements WorkerDriver {
  queue: Partial<Record<Role, Behaviour[]>> = {};
  launches: WorkerLaunchRequest[] = [];
  private current = new Map<string, { request: WorkerLaunchRequest; behaviour: Behaviour }>();

  script(role: Role, ...behaviours: Behaviour[]): void {
    this.queue[role] = [...(this.queue[role] ?? []), ...behaviours];
  }

  async launch(request: WorkerLaunchRequest): Promise<Outcome<WorkerHandle>> {
    this.launches.push(request);
    const behaviour = this.queue[request.identity.role]?.shift() ?? {};
    this.current.set(request.identity.attempt, { request, behaviour });
    return success({ identity: request.identity, authority: request.authority, resultFile: path.join(request.authority.outputDir, "result.json"), internal: request.identity.attempt });
  }

  async awaitBinding(handle: WorkerHandle): Promise<Outcome<true>> {
    const { behaviour } = this.current.get(handle.internal as string)!;
    return behaviour.bind === "fail" ? { ok: false, blocker: { code: "BINDING_UNCONFIRMED", message: "synthetic crash before binding" } } : success(true);
  }

  async awaitSettled(handle: WorkerHandle): Promise<SettledOutcome> {
    const { request, behaviour } = this.current.get(handle.internal as string)!;
    if (behaviour.settle === "timeout") return { kind: "timeout" };
    if (behaviour.settle === "quota") return { kind: "settled", outcome: "error", error: { class: "quota", summary: "synthetic usage limit" } };
    for (const [file, content] of Object.entries(behaviour.edit ?? {})) {
      const target = path.join(request.authority.worktree, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const candidate = request.brief.brief.base.candidate;
    const identity = behaviour.staleGeneration ? { ...request.identity, generation: request.identity.generation + 5 } : request.identity;
    const result = {
      schema: "radian.result/1",
      identity,
      briefHash: request.brief.hash,
      outcome: behaviour.outcome ?? "completed",
      summary: "synthetic worker result",
      deliverables: [],
      checks: (behaviour.checks ?? []).map((c) => ({ id: c.id, outcome: c.outcome, candidate, exitCode: c.outcome === "passed" ? 0 : 1 })),
      findings: behaviour.findings ?? [],
      unmetCriteria: [],
      risks: [],
      decisionRequests: behaviour.question ? [{ question: behaviour.question }] : [],
      handoff: { dirty: Object.keys(behaviour.edit ?? {}).length > 0, incomplete: [], runningServices: [], ownedResources: [] },
      usage: { status: "unknown" },
      modelAttestation: "unverified",
    };
    writeFileSync(path.join(request.authority.outputDir, "result.json"), JSON.stringify(result));
    return { kind: "settled", outcome: "success" };
  }

  async stop(handle: WorkerHandle): Promise<{ termination: "verified" | "unknown" }> {
    return { termination: this.current.get(handle.internal as string)!.behaviour.termination ?? "verified" };
  }
}

async function world() {
  const root = tempDir();
  const projectDir = path.join(root, "project");
  mkdirSync(projectDir);
  const fixture = await makeRepo(projectDir);
  fixture.write("src/a.ts", "export const a = 1;\n");
  fixture.write("tests/a.test.ts", "// test\n");
  fixture.write("docs/spec.md", "# Spec\nSynthetic behavior.\n");
  fixture.write("docs/plan.md", "# Plan\nSynthetic plan.\n");
  const base = await fixture.commitAll("base");
  const repo = await openRepository(projectDir);
  if (!repo.ok) throw new Error("repo");
  const stateDir = path.join(root, "project-state");
  const workspaceState = path.join(root, "workspace-state");
  for (const d of [stateDir, workspaceState]) mkdirSync(d, { recursive: true });
  const shipped = loadAndResolve({});
  if (!shipped.ok) throw new Error("config");
  const snapshot = resolveConfig([
    { layer: "shipped", label: "shipped", harness: shipped.value.harness, dispatch: shipped.value.dispatch },
    { layer: "project", label: "project", dispatch: { default: "codex", profiles: { codex: { model: "gpt-test-1" } } } },
  ]);
  if (!snapshot.ok) throw new Error(snapshot.blocker.message);
  const lease = await CoordinatorLease.acquire(stateDir, "prj_fixture1", { ttlMs: 3_600_000 });
  if (!lease.ok) throw new Error("lease");
  const store = await RunStore.create(stateDir, lease.value, { workspace: "ws_fixture1", project: "prj_fixture1", configHash: snapshot.value.hash, harness: { version: "0.0.0-test", revision: "f".repeat(40), locallyModified: false } });
  if (!store.ok) throw new Error("store");
  const driver = new FakeDriver();
  const mode = new ModeState(stateDir);
  const metrics = new MetricsRecorder(stateDir, { provenance: store.value.state.run.harness, configHash: snapshot.value.hash, run: store.value.state.run.id });
  const capacity = new CapacityLedger(workspaceState);
  const coordinator = new Coordinator({
    store: store.value,
    repo: repo.value,
    worktrees: new WorktreeManager(repo.value, stateDir, path.join(root, "worktrees")),
    capacity,
    capacityCeiling: 3,
    driver,
    mode,
    metrics,
    config: snapshot.value as ConfigSnapshot,
    target: { ref: "refs/heads/main" },
    commitIdentity: { name: "Radian Fixture", email: "radian@example.com" },
    paths: { stateDir, exchangeRoot: path.join(root, "exchange"), scratchRoot: path.join(root, "scratch") },
    workspace: "ws_fixture1",
    project: "prj_fixture1",
    clock: systemClock,
    artifactHash: (relative) => {
      try {
        return Coordinator.artifactDigest(readFileSync(path.join(projectDir, relative), "utf8"));
      } catch {
        return undefined;
      }
    },
    roleGuide: (role) => readFileSync(path.join(WORKERS, `${role}.md`), "utf8"),
    credentialSourceFor: () => ({ runtime: "codex", provider: "openai", describe: "unused by fake driver", read: async () => ({ ok: false, blocker: { code: "CREDENTIAL_UNAVAILABLE", message: "fake" } }) }),
    supervisionHealthy: () => success(true as const),
    startupMs: 10_000,
  });
  const taskId = "task_fixture-1";
  await store.value.addTask("Synthetic task", 3, taskId);
  const spec = coordinator.deps.artifactHash("docs/spec.md")!;
  const plan = coordinator.deps.artifactHash("docs/plan.md")!;
  await store.value.recordApproval(human(), { kind: "spec", task: taskId, artifact: { path: "docs/spec.md", hash: spec }, decision: "approved" });
  await store.value.recordApproval(human(), { kind: "plan", task: taskId, artifact: { path: "docs/plan.md", hash: plan }, decision: "approved" });
  mode.set("build");
  return { root, fixture, repo: repo.value, base, store: store.value, driver, mode, metrics, capacity, coordinator, taskId, artifacts: { spec, plan } };
}

type World = Awaited<ReturnType<typeof world>>;

function plan(w: World, role: Role, overrides: Partial<AssignmentPlan> = {}): AssignmentPlan {
  const modifying = role === "developer" || role === "tester";
  return {
    task: w.taskId,
    role,
    purpose: "assignment",
    objective: `Synthetic ${role} objective`,
    acceptanceCriteria: ["synthetic criterion"],
    writeRoots: role === "developer" ? ["src"] : role === "tester" ? ["tests"] : [],
    operations: modifying ? ["read", "edit", "shell", "run-checks", "deliver-changes", "write-report"] : role === "reviewer" ? ["read", "git-inspect", "write-report"] : ["read", "write-report"],
    selection: {},
    newCandidateRound: role === "developer",
    base: { kind: "target" },
    artifacts: w.artifacts,
    ...overrides,
  };
}

async function candidateRound(w: World, devBase: { kind: "target" } | { kind: "commit"; commit: string }, newRound = true) {
  w.driver.script("developer", { edit: { "src/a.ts": `export const a = ${Math.random()};\n` } });
  const dev = await w.coordinator.runAssignment(plan(w, "developer", { base: devBase, newCandidateRound: newRound }));
  assert.equal(dev.state, "completed", JSON.stringify(dev));
  w.driver.script("tester", { edit: { "tests/a.test.ts": "// acceptance\n" } });
  const tester = await w.coordinator.runAssignment(plan(w, "tester", { base: devBase }));
  assert.equal(tester.state, "completed", JSON.stringify(tester));
  if (dev.state !== "completed" || tester.state !== "completed") throw new Error("round");
  const mergeBase = devBase.kind === "target" ? w.base : devBase.commit;
  const candidate = await w.coordinator.assemble(w.taskId, [dev.delivery!, tester.delivery!], mergeBase);
  assert.ok(candidate.ok, candidate.ok ? "" : candidate.blocker.message);
  if (!candidate.ok) throw new Error("candidate");
  return candidate.value;
}

async function checkAndReview(w: World, candidate: { commit: string }, review: Behaviour) {
  w.driver.script("tester", { checks: [{ id: "unit", outcome: "passed" }] });
  const check = await w.coordinator.runAssignment(plan(w, "tester", { purpose: "candidate-check", base: { kind: "commit", commit: candidate.commit }, writeRoots: [""], requiredChecks: [{ id: "unit", description: "unit tests", argv: ["npm", "test"] }] }));
  assert.equal(check.state, "completed");
  if (check.state === "completed") w.coordinator.recordCheckEvidence(w.taskId, check.result);
  w.driver.script("reviewer", review);
  const reviewOutcome = await w.coordinator.runAssignment(plan(w, "reviewer", { base: { kind: "commit", commit: candidate.commit } }));
  assert.equal(reviewOutcome.state, "completed");
  if (reviewOutcome.state === "completed") w.coordinator.recordReview(w.taskId, candidate.commit, reviewOutcome.result);
}

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
