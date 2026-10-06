// Engineering orchestration: spec/plan approvals → developer and independent
// tester deliveries → exact candidate → contained candidate checks → fresh
// review → human-approved exact fast-forward integration, with bounded
// repairs, durable questions and quota blockers, one automatic infrastructure
// recovery, and conservative cleanup.
//
// The orchestrator composes services that each enforce their own invariants
// (run store, capacity ledger, worktrees, delivery, integration, runtime
// session). Every modifying step additionally requires Build mode, healthy
// supervision, current approvals, capacity, exclusive checkout ownership, and
// verified runtime capabilities (inside the driver). Nothing here approves work
// or interprets worker text as consent.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { type AuthorityRequest, type Operation, resolveAuthority } from "../contracts/authority.ts";
import { sealBrief, type SealedBrief } from "../contracts/brief.ts";
import { newId, type AssignmentIdentity, type Role } from "../contracts/identity.ts";
import type { CandidateRef, CheckEvidence } from "../contracts/records.ts";
import type { WorkerResult } from "../contracts/result.ts";
import { type ResolvedProfile, recheckResolvedProfile } from "../config/provider-policy.ts";
import { type SelectionRequest, selectProfile } from "../config/dispatch.ts";
import type { ConfigSnapshot } from "../config/resolve.ts";
import { assembleCandidate } from "../git/candidate.ts";
import { type CommitIdentity, type Delivery, deliverFromWorktree } from "../git/delivery.ts";
import { integrateCandidate } from "../git/integration.ts";
import { type ProtectedTarget, type Repository, resolveCommit } from "../git/repository.ts";
import type { WorktreeManager, WorktreePurpose } from "../git/worktrees.ts";
import type { CredentialSource } from "../isolation/credentials.ts";
import { HumanChannel, requireApproval } from "../state/approvals.ts";
import type { CapacityLedger } from "../state/capacity.ts";
import { atomicWriteJson, readJsonIfExists } from "../state/fsutil.ts";
import { collectResult } from "../state/inbox.ts";
import { type AttemptEvidence, type ReconcileReport, reconcileRun } from "../state/reconcile.ts";
import { SupervisionRegistry } from "../isolation/registry.ts";
import { type IdentityProbe, liveness, psProbe } from "../util/process-identity.ts";
import type { RunStore } from "../state/run-store.ts";
import type { Clock } from "../util/clock.ts";
import { hashJson } from "../util/canonical.ts";
import type { WorkerDriver, WorkerHandle } from "./driver.ts";
import type { MetricsRecorder } from "./metrics.ts";
import { type ModeState, requireModeFor } from "./mode.ts";

export interface CoordinatorDeps {
  store: RunStore;
  repo: Repository;
  worktrees: WorktreeManager;
  capacity: CapacityLedger;
  /** Workspace-wide ceiling from the workspace-resolved configuration. */
  capacityCeiling: number;
  driver: WorkerDriver;
  mode: ModeState;
  metrics: MetricsRecorder;
  config: ConfigSnapshot;
  target: ProtectedTarget;
  commitIdentity: CommitIdentity;
  paths: { stateDir: string; exchangeRoot: string; scratchRoot: string };
  workspace: string;
  project: string;
  clock: Clock;
  /** Current content hash of an approved artifact (repository-relative path), computed from disk. */
  artifactHash: (relativePath: string) => string | undefined;
  roleGuide: (role: Role) => string;
  credentialSourceFor: (profile: ResolvedProfile) => CredentialSource;
  supervisionHealthy: () => Outcome<true>;
  /** Startup deadline for binding and margin for credential validity. */
  startupMs: number;
}

export interface ApprovedArtifacts {
  spec?: string;
  brief?: string;
  plan: string;
}

export interface AssignmentPlan {
  task: string;
  role: Role;
  purpose: WorktreePurpose;
  objective: string;
  nonGoals?: string[];
  acceptanceCriteria?: string[];
  deliverables?: string[];
  requiredChecks?: Array<{ id: string; description: string; argv: string[] }>;
  /** Repository-relative write roots ("" = whole tree); empty for report-only roles. */
  writeRoots: string[];
  operations: Operation[];
  ports?: number[];
  dependencyChangesApproved?: boolean;
  selection: Omit<SelectionRequest, "role">;
  newCandidateRound: boolean;
  /** Commit the worktree starts from: target head, or the candidate being repaired/checked/reviewed. */
  base: { kind: "target" } | { kind: "commit"; commit: string };
  artifacts: ApprovedArtifacts;
  context?: Array<{ label: string; text?: string }>;
}

export type AssignmentOutcome =
  | { state: "completed"; assignment: string; result: WorkerResult; delivery?: Delivery; worktree: string }
  | { state: "blocked"; assignment?: string; blocker: { code: string; message: string; nextAction?: string }; decisionId?: string }
  | { state: "failed"; assignment: string; reason: string; termination: "verified" | "unknown" };

interface TaskEvidence {
  candidate?: CandidateRef & { round: number };
  checks: CheckEvidence[];
  review?: { candidate: string; blockingFindings: number; outcome: WorkerResult["outcome"]; findings: number };
  risks: string[];
}

export class Coordinator {
  readonly deps: CoordinatorDeps;
  private readonly handles = new Map<string, { handle: WorkerHandle; reservation: string; worktree: string; plan: AssignmentPlan; profile: ResolvedProfile; brief: SealedBrief }>();

  constructor(deps: CoordinatorDeps) {
    this.deps = deps;
  }

  private evidenceFile(task: string): string {
    return path.join(this.deps.store.runDir, "evidence", `${task}.json`);
  }

  evidence(task: string): TaskEvidence {
    const read = readJsonIfExists(this.evidenceFile(task));
    return read.state === "ok" ? (read.value as TaskEvidence) : { checks: [], risks: [] };
  }

  private saveEvidence(task: string, evidence: TaskEvidence): void {
    atomicWriteJson(this.evidenceFile(task), evidence);
  }

  private identityFor(assignment: string, attempt: string, generation: number, task: string, role: Role): AssignmentIdentity {
    return { workspace: this.deps.workspace, project: this.deps.project, run: this.deps.store.state.run.id, task, assignment, attempt, generation, role };
  }

  /** Validate a plan, allocate an owned worktree, resolve authority, seal the brief, and record the assignment. */
  async prepare(plan: AssignmentPlan): Promise<Outcome<{ assignment: string; profile: ResolvedProfile; brief: SealedBrief; worktree: string; reservation?: string }>> {
    const d = this.deps;
    const modeCheck = requireModeFor(d.mode.mode, plan.purpose === "candidate-check" ? { kind: "candidate-check" } : { kind: "dispatch", role: plan.role });
    if (!modeCheck.ok) return modeCheck;
    const healthy = d.supervisionHealthy();
    if (!healthy.ok) return healthy;
    const selection = selectProfile(d.config.dispatch, { role: plan.role, ...plan.selection });
    if (!selection.ok) {
      d.metrics.record("preflight-blocked", { task: plan.task, role: plan.role, outcome: selection.blocker.code });
      return selection;
    }
    const profile = selection.value.profile;

    const head = await resolveCommit(d.repo, d.target.ref);
    if (!head.ok) return head;
    const base = plan.base.kind === "target" ? head.value : plan.base.commit;
    const assignment = newId("asg");
    const exchange = path.join(d.paths.exchangeRoot, assignment);
    const scratch = path.join(d.paths.scratchRoot, assignment);
    mkdirSync(exchange, { recursive: true, mode: 0o700 });
    mkdirSync(scratch, { recursive: true, mode: 0o700 });

    const worktree = await d.worktrees.allocate({ purpose: plan.purpose, task: plan.task, assignment, role: plan.role, base });
    if (!worktree.ok) return worktree;
    const request: AuthorityRequest = {
      role: plan.role,
      worktree: worktree.value.path,
      readRoots: [d.repo.commonDir],
      writeRoots: plan.writeRoots.map((root) => path.join(worktree.value.path, root)),
      outputDir: exchange,
      scratchDir: scratch,
      operations: plan.operations,
    };
    if (plan.ports) request.ports = plan.ports;
    if (plan.dependencyChangesApproved) request.dependencyChangesApproved = true;
    // Git metadata is readable for inspection but never writable; coordinator state is neither.
    const authority = resolveAuthority(request, { projectRoot: d.repo.root, protectedPaths: [d.repo.commonDir, d.paths.stateDir], privatePaths: [d.paths.stateDir] });
    if (!authority.ok) return authority;

    const task = d.store.state.tasks[plan.task];
    if (!task) return refuse("INVALID_TRANSITION", "unknown task");
    const round = plan.newCandidateRound ? task.roundsUsed + 1 : Math.max(task.roundsUsed, 1);
    const harness = d.config.harness;
    const approvals: Array<{ kind: "spec" | "brief" | "plan"; approvalId: string; artifact: { path: string; hash: string } }> = [];
    for (const kind of ["spec", "brief", "plan"] as const) {
      const hash = plan.artifacts[kind];
      if (hash === undefined) continue;
      const approved = requireApproval(d.store.state, { task: plan.task, kind }, { artifactHash: hash });
      if (approved.ok) approvals.push({ kind, approvalId: approved.value.id, artifact: approved.value.artifact });
      else if (plan.role === "developer" || plan.role === "tester") return approved;
    }
    if (approvals.length === 0) return refuse("APPROVAL_MISSING", "assignments require at least one current approved artifact");

    const placeholderIdentity = this.identityFor(assignment, "att_pending-000", 1, plan.task, plan.role);
    const sealed = sealBrief({
      schema: "radian.brief/1",
      identity: placeholderIdentity,
      round: { current: Math.min(round, harness.assignment.candidateRounds), max: harness.assignment.candidateRounds },
      objective: plan.objective,
      nonGoals: plan.nonGoals ?? [],
      acceptanceCriteria: plan.acceptanceCriteria ?? [],
      approvals,
      base: { commit: base, checkout: worktree.value.id, ...(plan.base.kind === "commit" ? { candidate: plan.base.commit } : {}) },
      authority: authority.value,
      profile: { name: profile.name, runtime: profile.runtime, provider: profile.provider, model: profile.model, effort: profile.effort, selection: selection.value.source, ...(selection.value.ruleId ? { ruleId: selection.value.ruleId } : {}) },
      deliverables: plan.deliverables ?? [],
      requiredChecks: plan.requiredChecks ?? [],
      budget: { executionMsRemaining: harness.assignment.executionLimitMinutes * 60_000, automaticRecoveriesRemaining: harness.assignment.automaticRecoveries },
      context: plan.context ?? [],
      decisionRoute: "coordinator",
      configSnapshot: d.config.hash,
    });
    if (!sealed.ok) return sealed;

    const created = await d.store.createAssignment(
      {
        task: plan.task,
        role: plan.role,
        profile: { name: profile.name, runtime: profile.runtime, provider: profile.provider, model: profile.model, effort: profile.effort },
        briefHash: sealed.value.hash,
        limitMs: harness.assignment.executionLimitMinutes * 60_000,
        maxAutomaticRecoveries: harness.assignment.automaticRecoveries,
        artifacts: plan.artifacts,
        newCandidateRound: plan.newCandidateRound,
      },
      assignment,
    );
    if (!created.ok) {
      if (created.blocker.code === "ROUNDS_EXHAUSTED") {
        d.metrics.record("rounds-exhausted", { task: plan.task, role: plan.role });
        await d.store.setPhase(plan.task, "blocked");
      }
      return created;
    }
    if (plan.newCandidateRound) d.metrics.record("round-started", { task: plan.task, round });
    return success({ assignment, profile, brief: sealed.value, worktree: worktree.value.path });
  }

  /**
   * Run one attempt of a prepared assignment end to end. Capacity is reserved
   * before launch; the reservation and worktree ownership are released only
   * after verified termination.
   */
  async runAttempt(assignment: string, plan: AssignmentPlan, prepared: { profile: ResolvedProfile; brief: SealedBrief; worktree: string }, attemptOptions: { humanDecisionId?: string; resumeDecisionId?: string } = {}): Promise<AssignmentOutcome> {
    const d = this.deps;
    const modeCheck = requireModeFor(d.mode.mode, plan.purpose === "candidate-check" ? { kind: "candidate-check" } : { kind: "dispatch", role: plan.role });
    if (!modeCheck.ok) return { state: "blocked", assignment, blocker: modeCheck.blocker };
    const healthy = d.supervisionHealthy();
    if (!healthy.ok) return { state: "blocked", assignment, blocker: healthy.blocker };
    const pairing = recheckResolvedProfile(prepared.profile);
    if (!pairing.ok) return { state: "blocked", assignment, blocker: pairing.blocker };

    const reservation = await d.capacity.reserve(d.capacityCeiling, { project: d.project, run: d.store.state.run.id, assignment, role: plan.role });
    if (!reservation.ok) return { state: "blocked", assignment, blocker: reservation.blocker };

    const started = await d.store.startAttempt(assignment, attemptOptions);
    if (!started.ok) return { state: "blocked", assignment, blocker: started.blocker };
    const a = started.value.assignments[assignment]!;
    const attempt = a.attempts.at(-1)!;
    const identity = this.identityFor(assignment, attempt.id, attempt.generation, a.task, a.role);
    const worktreeRecord = (await d.worktrees.list()).find((w) => w.assignment === assignment && w.state === "active");
    if (!worktreeRecord) return { state: "blocked", assignment, blocker: { code: "OWNERSHIP_AMBIGUOUS", message: "assignment worktree is missing" } };
    const claimed = await d.worktrees.claim(worktreeRecord.id, attempt.id, attempt.generation);
    if (!claimed.ok) return { state: "blocked", assignment, blocker: claimed.blocker };
    if (attempt.automatic) d.metrics.record("recovery", { task: a.task, assignment, role: a.role, outcome: "automatic" });

    // The brief identity carries the real attempt/generation; reseal against it.
    const brief = sealBrief({ ...prepared.brief.brief, identity, budget: { ...prepared.brief.brief.budget, executionMsRemaining: d.store.remainingMs(assignment), automaticRecoveriesRemaining: Math.max(0, a.maxAutomaticRecoveries - a.automaticRecoveriesUsed) } });
    if (!brief.ok) return { state: "blocked", assignment, blocker: brief.blocker };
    const fixed = await d.store.recordAttemptBrief(assignment, attempt.id, brief.value.hash);
    if (!fixed.ok) return { state: "blocked", assignment, blocker: fixed.blocker };
    const briefText = renderBrief(brief.value, d.roleGuide(a.role));
    d.metrics.record("assignment-started", { task: a.task, assignment, role: a.role, runtime: prepared.profile.runtime, model: prepared.profile.model, effort: prepared.profile.effort, round: a.round });

    const launched = await d.driver.launch({
      identity,
      profile: prepared.profile,
      authority: brief.value.brief.authority,
      brief: brief.value,
      briefText,
      systemPrompt: d.roleGuide(a.role),
      credentialSource: d.credentialSourceFor(prepared.profile),
      minValidityMs: d.store.remainingMs(assignment) + d.startupMs,
    });
    if (!launched.ok) {
      // Nothing was started when launch is refused before pane creation; the attempt ends verified.
      await d.store.endAttempt(assignment, attempt.id, "infrastructure", "verified");
      await d.worktrees.markRetired(worktreeRecord.id, attempt.id);
      await d.capacity.release(reservation.value.id, "terminated");
      d.metrics.record("preflight-blocked", { task: a.task, assignment, role: a.role, outcome: launched.blocker.code });
      return { state: "blocked", assignment, blocker: launched.blocker };
    }
    const handle = launched.value;
    this.handles.set(assignment, { handle, reservation: reservation.value.id, worktree: worktreeRecord.id, plan, profile: prepared.profile, brief: brief.value });
    await d.capacity.setState(reservation.value.id, "active");

    const bound = await d.driver.awaitBinding(handle, Date.now() + d.startupMs);
    if (!bound.ok) return this.finishFailure(assignment, "infrastructure", bound.blocker.message);
    const binding = await d.store.bindAttempt(identity);
    if (!binding.ok) return this.finishFailure(assignment, "infrastructure", binding.blocker.message);
    d.metrics.record("assignment-bound", { task: a.task, assignment, role: a.role });

    const settled = await d.driver.awaitSettled(handle, Date.now() + d.store.remainingMs(assignment));
    if (settled.kind === "timeout") return this.finishFailure(assignment, "timeout", "execution budget exhausted");
    if (settled.kind === "settled" && settled.outcome === "error" && settled.error?.class === "quota") {
      return this.finishQuota(assignment, settled.error.summary, settled.error.resetAtMs);
    }
    if (settled.kind === "settled" && settled.outcome === "error" && (settled.error?.class === "infrastructure" || settled.error?.class === "unknown")) {
      // Results written before the failure are still collected below if present.
    }
    return this.finishSettled(assignment, settled.kind === "settled" ? settled.usage : undefined);
  }

  /** Prepare and run in one step. */
  async runAssignment(plan: AssignmentPlan): Promise<AssignmentOutcome> {
    const prepared = await this.prepare(plan);
    if (!prepared.ok) return { state: "blocked", blocker: prepared.blocker };
    let outcome = await this.runAttempt(prepared.value.assignment, plan, prepared.value);
    // One automatic infrastructure recovery, in a fresh attempt, when termination was verified.
    if (outcome.state === "failed" && outcome.termination === "verified" && this.deps.store.state.assignments[outcome.assignment]?.automaticRecoveriesUsed === 0) {
      const a = this.deps.store.state.assignments[outcome.assignment]!;
      if (a.maxAutomaticRecoveries > 0 && this.deps.store.remainingMs(a.id) > 0) {
        outcome = await this.runAttempt(prepared.value.assignment, plan, prepared.value);
      }
    }
    if (outcome.state === "failed") {
      const opened = await this.deps.store.block(outcome.assignment, "other", `Attempt failed (${outcome.reason}); decide whether to authorize another attempt, change the plan, or cancel.`);
      const decision = opened.ok ? Object.values(opened.value.decisions).filter((x) => x.assignment === outcome.assignment && x.status === "open").at(-1)?.id : undefined;
      return { state: "blocked", assignment: outcome.assignment, blocker: { code: "RECOVERY_EXHAUSTED", message: `attempt failed: ${outcome.reason}`, nextAction: "Human decision required." }, ...(decision ? { decisionId: decision } : {}) };
    }
    return outcome;
  }

  private async release(assignment: string, termination: "verified" | "unknown"): Promise<void> {
    const entry = this.handles.get(assignment);
    if (!entry) return;
    if (termination === "verified") {
      await this.deps.worktrees.markRetired(entry.worktree, entry.handle.identity.attempt);
      await this.deps.capacity.release(entry.reservation, "terminated");
    }
    // Unknown termination keeps the reservation and worktree ownership: replacement stays blocked.
    this.handles.delete(assignment);
  }

  private async finishFailure(assignment: string, reason: "infrastructure" | "timeout", detail: string): Promise<AssignmentOutcome> {
    const entry = this.handles.get(assignment)!;
    const stopped = await this.deps.driver.stop(entry.handle);
    await this.deps.store.endAttempt(assignment, entry.handle.identity.attempt, reason, stopped.termination);
    const a = this.deps.store.state.assignments[assignment]!;
    this.deps.metrics.record("assignment-ended", { task: a.task, assignment, role: a.role, outcome: reason, durationMs: a.budget.consumedMs, blockedMs: a.budget.blockedMs });
    await this.release(assignment, stopped.termination);
    return { state: "failed", assignment, reason: `${reason}: ${detail}`, termination: stopped.termination };
  }

  private async finishQuota(assignment: string, summary: string, resetAtMs: number | undefined): Promise<AssignmentOutcome> {
    const entry = this.handles.get(assignment)!;
    const stopped = await this.deps.driver.stop(entry.handle);
    await this.deps.store.endAttempt(assignment, entry.handle.identity.attempt, "quota", stopped.termination);
    const reset = resetAtMs === undefined ? "unknown" : new Date(resetAtMs).toISOString();
    const blocked = await this.deps.store.block(assignment, "quota", `Quota exhausted (${summary}); reliable reset: ${reset}. Options: wait and approve one retry with the same profile, explicitly choose a different profile, or cancel.`);
    const a = this.deps.store.state.assignments[assignment]!;
    this.deps.metrics.record("quota-blocked", { task: a.task, assignment, role: a.role, runtime: a.profile.runtime, model: a.profile.model, effort: a.profile.effort });
    await this.release(assignment, stopped.termination);
    const decision = blocked.ok ? Object.values(blocked.value.decisions).filter((x) => x.assignment === assignment && x.kind === "quota" && x.status === "open").at(-1)?.id : undefined;
    return { state: "blocked", assignment, blocker: { code: "QUOTA_EXHAUSTED", message: "quota exhausted; work preserved", nextAction: "Human decision required; no automatic retry or fallback." }, ...(decision ? { decisionId: decision } : {}) };
  }

  private async finishSettled(assignment: string, usage: { inputTokens?: number; outputTokens?: number; source: string } | undefined): Promise<AssignmentOutcome> {
    const d = this.deps;
    const entry = this.handles.get(assignment)!;
    const stopped = await d.driver.stop(entry.handle);
    const collected = await collectResult(d.store, entry.handle.authority.outputDir, { identity: entry.handle.identity, briefHash: entry.brief.hash });
    await d.store.endAttempt(assignment, entry.handle.identity.attempt, collected.ok ? "completed" : "unknown", stopped.termination);
    const a = d.store.state.assignments[assignment]!;
    d.metrics.record("assignment-ended", { task: a.task, assignment, role: a.role, outcome: collected.ok ? collected.value.result.outcome : "no-valid-result", durationMs: a.budget.consumedMs, blockedMs: a.budget.blockedMs });
    if (!collected.ok) {
      if (collected.blocker.code === "STALE_GENERATION") d.metrics.record("stale-result", { task: a.task, assignment });
      await this.release(assignment, stopped.termination);
      return { state: "failed", assignment, reason: `no valid result: ${collected.blocker.message}`, termination: stopped.termination };
    }
    const result = collected.value.result;
    d.metrics.record("result-recorded", { task: a.task, assignment, role: a.role, outcome: result.outcome, usage: usage ? { status: "reported", ...usage } : result.usage.status === "reported" ? { status: "reported", inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, source: result.usage.source } : { status: "unknown" } });

    if (result.outcome === "blocked" && result.decisionRequests.length > 0) {
      await this.release(assignment, stopped.termination);
      const blocked = await d.store.block(assignment, "question", result.decisionRequests.map((q) => q.question).join("\n"));
      d.metrics.record("question-opened", { task: a.task, assignment, role: a.role });
      const decision = blocked.ok ? Object.values(blocked.value.decisions).filter((x) => x.assignment === assignment && x.status === "open").at(-1)?.id : undefined;
      return { state: "blocked", assignment, blocker: { code: "QUESTION_OPEN", message: "worker asked for a decision; affected work paused and preserved" }, ...(decision ? { decisionId: decision } : {}) };
    }

    let delivery: Delivery | undefined;
    if ((a.role === "developer" || a.role === "tester") && entry.plan.purpose === "assignment" && result.outcome === "completed") {
      if (stopped.termination !== "verified") {
        await this.release(assignment, stopped.termination);
        return { state: "failed", assignment, reason: "termination unverified; changes are not delivered while a writer may be alive", termination: stopped.termination };
      }
      const delivered = await deliverFromWorktree({
        repo: d.repo,
        worktreePath: entry.handle.authority.worktree,
        expectedBase: entry.brief.brief.base.commit,
        scope: { writeRoots: entry.plan.writeRoots },
        assignment,
        attempt: entry.handle.identity.attempt,
        message: `radian: ${a.role} delivery for ${a.task}`,
        identity: d.commitIdentity,
        scratchDir: entry.handle.authority.scratchDir,
      });
      if (!delivered.ok) {
        await this.release(assignment, stopped.termination);
        return { state: "blocked", assignment, blocker: delivered.blocker };
      }
      delivery = delivered.value;
      await d.worktrees.recordDelivery(entry.worktree, delivery.commit);
    }
    await this.release(assignment, stopped.termination);
    if (stopped.termination === "verified") await d.store.retire(assignment);
    const out: AssignmentOutcome = { state: "completed", assignment, result, worktree: entry.handle.authority.worktree };
    if (delivery) out.delivery = delivery;
    return out;
  }

  /** Resume a question/pause-blocked assignment in a fresh attempt after the human resolved the decision. */
  async resume(assignment: string, plan: AssignmentPlan, prepared: { profile: ResolvedProfile; brief: SealedBrief; worktree: string }, decisionId: string): Promise<AssignmentOutcome> {
    return this.runAttempt(assignment, plan, prepared, { resumeDecisionId: decisionId });
  }

  /**
   * Scoped quota retry: requires the human's recorded authorization, a reached
   * reset time, healthy supervision, and the unchanged profile. It consumes the
   * assignment's recovery allowance (human-authorized); no background retry.
   */
  async retryAfterQuota(channel: HumanChannel, assignment: string, plan: AssignmentPlan, prepared: { profile: ResolvedProfile; brief: SealedBrief; worktree: string }, options: { decisionId: string; notBeforeMs: number }): Promise<AssignmentOutcome> {
    const d = this.deps;
    if (!HumanChannel.isGenuine(channel)) return { state: "blocked", assignment, blocker: { code: "APPROVAL_NOT_HUMAN", message: "quota retry requires explicit user authorization" } };
    if (d.clock.now() < options.notBeforeMs) return { state: "blocked", assignment, blocker: { code: "QUOTA_EXHAUSTED", message: "reported reset time has not been reached" } };
    const a = d.store.state.assignments[assignment];
    if (!a) return { state: "blocked", assignment, blocker: { code: "INVALID_TRANSITION", message: "unknown assignment" } };
    const same = a.profile.runtime === prepared.profile.runtime && a.profile.model === prepared.profile.model && a.profile.effort === prepared.profile.effort && a.profile.provider === prepared.profile.provider;
    if (!same) return { state: "blocked", assignment, blocker: { code: "PROFILE_NOT_IN_CANDIDATES", message: "quota retry must use the unchanged profile; a different profile needs a new explicit decision" } };
    const open = Object.values(d.store.state.decisions).find((x) => x.id === options.decisionId && x.assignment === assignment && x.kind === "quota");
    if (!open) return { state: "blocked", assignment, blocker: { code: "QUOTA_EXHAUSTED", message: "no quota decision to resolve" } };
    const authorized = await d.store.authorizeRecovery(channel, assignment, options.decisionId);
    if (!authorized.ok) return { state: "blocked", assignment, blocker: authorized.blocker };
    if (open.status === "open") {
      const resolved = await d.store.resolveDecision(channel, options.decisionId, "retry once with the same profile");
      if (!resolved.ok) return { state: "blocked", assignment, blocker: resolved.blocker };
    }
    return this.runAttempt(assignment, plan, prepared, { humanDecisionId: options.decisionId });
  }

  /** Combine the round's deliveries into one exact candidate on the target base. */
  async assemble(task: string, deliveries: readonly Delivery[], mergeBase: string): Promise<Outcome<CandidateRef & { round: number }>> {
    const d = this.deps;
    const t = d.store.state.tasks[task];
    if (!t) return refuse("INVALID_TRANSITION", "unknown task");
    const head = await resolveCommit(d.repo, d.target.ref);
    if (!head.ok) return head;
    const assembled = await assembleCandidate({ repo: d.repo, base: mergeBase, targetBase: head.value, task, round: t.roundsUsed, deliveries, identity: d.commitIdentity, message: `radian: candidate for ${t.title}` });
    if (!assembled.ok) return assembled;
    const candidate = { commit: assembled.value.commit, tree: assembled.value.tree, base: assembled.value.base };
    const recorded = await d.store.recordCandidate(task, candidate);
    if (!recorded.ok) return recorded;
    await d.store.setPhase(task, "verifying");
    // A new candidate makes all earlier evidence historical.
    this.saveEvidence(task, { candidate: { ...candidate, round: t.roundsUsed }, checks: [], risks: [] });
    d.metrics.record("candidate-assembled", { task, round: t.roundsUsed });
    return success({ ...candidate, round: t.roundsUsed });
  }

  /** Record contained candidate-check evidence; only checks bound to the exact candidate count. */
  recordCheckEvidence(task: string, result: WorkerResult): CheckEvidence[] {
    const evidence = this.evidence(task);
    const candidate = evidence.candidate?.commit;
    const exact = result.checks.filter((c) => candidate !== undefined && c.candidate === candidate);
    evidence.checks = [...evidence.checks.filter((c) => !exact.some((x) => x.id === c.id)), ...exact];
    evidence.risks = [...new Set([...evidence.risks, ...result.risks])];
    this.saveEvidence(task, evidence);
    for (const check of exact) this.deps.metrics.record("check-outcome", { task, outcome: check.outcome });
    return exact;
  }

  recordReview(task: string, reviewedCandidate: string, result: WorkerResult): void {
    const evidence = this.evidence(task);
    evidence.review = { candidate: reviewedCandidate, blockingFindings: result.findings.filter((f) => f.severity === "blocker" || f.severity === "major").length, outcome: result.outcome, findings: result.findings.length };
    evidence.risks = [...new Set([...evidence.risks, ...result.risks])];
    this.saveEvidence(task, evidence);
    this.deps.metrics.record("review-outcome", { task, outcome: evidence.review.blockingFindings > 0 ? "changes-requested" : result.outcome });
  }

  /** Compact summary presented to the human before the integration decision. */
  async integrationSummary(task: string, requiredChecks: readonly string[]): Promise<Outcome<{ candidate: CandidateRef; target: { ref: string; commit: string }; checks: CheckEvidence[]; review: TaskEvidence["review"]; risks: string[]; ready: boolean; gaps: string[] }>> {
    const d = this.deps;
    const evidence = this.evidence(task);
    if (!evidence.candidate) return refuse("CANDIDATE_MISMATCH", "no candidate has been assembled");
    const head = await resolveCommit(d.repo, d.target.ref);
    if (!head.ok) return head;
    const gaps: string[] = [];
    for (const id of requiredChecks) {
      const c = evidence.checks.find((x) => x.id === id);
      if (!c) gaps.push(`check ${id}: not run`);
      else if (c.outcome !== "passed") gaps.push(`check ${id}: ${c.outcome}`);
    }
    if (!evidence.review || evidence.review.candidate !== evidence.candidate.commit) gaps.push("review: not run on this candidate");
    else if (evidence.review.blockingFindings > 0) gaps.push(`review: ${evidence.review.blockingFindings} blocking finding(s)`);
    if (head.value !== evidence.candidate.base) gaps.push("target moved since assembly");
    const { round: _round, ...candidate } = evidence.candidate;
    return success({ candidate, target: { ref: d.target.ref, commit: head.value }, checks: evidence.checks, review: evidence.review, risks: evidence.risks, ready: gaps.length === 0, gaps });
  }

  /** Integrate the exact approved, verified, reviewed candidate. Requires Build mode and a human channel. */
  async integrate(channel: HumanChannel, task: string, requiredChecks: readonly string[], approvedArtifact: { path: string }): Promise<Outcome<{ from: string; to: string }>> {
    const d = this.deps;
    if (!HumanChannel.isGenuine(channel)) return refuse("APPROVAL_NOT_HUMAN", "integration is triggered only by explicit user input");
    const modeCheck = requireModeFor(d.mode.mode, { kind: "integrate" });
    if (!modeCheck.ok) return modeCheck;
    const evidence = this.evidence(task);
    if (!evidence.candidate || !evidence.review) return refuse("CANDIDATE_MISMATCH", "candidate evidence is incomplete");
    const artifactHash = d.artifactHash(approvedArtifact.path);
    if (!artifactHash) return refuse("APPROVAL_STALE", "approved integration artifact is missing");
    const { round, ...candidate } = evidence.candidate;
    const result = await integrateCandidate({
      repo: d.repo,
      target: d.target,
      candidate,
      evidence: { requiredChecks, checks: evidence.checks, review: { candidate: evidence.review.candidate, blockingFindings: evidence.review.blockingFindings, outcome: evidence.review.outcome } },
      approval: (target) => requireApproval(d.store.state, { task, kind: "integration" }, { artifactHash, candidate, target }),
    });
    if (!result.ok) return result;
    await d.store.setPhase(task, "integrated");
    d.metrics.record("integration", { task, round, outcome: "integrated" });
    return success(result.value);
  }

  /** Cancel a running attempt: stop, verify, preserve work; reservation released only if verified. */
  async cancel(assignment: string): Promise<Outcome<{ termination: "verified" | "unknown" }>> {
    const entry = this.handles.get(assignment);
    const a = this.deps.store.state.assignments[assignment];
    if (!a) return refuse("INVALID_TRANSITION", "unknown assignment");
    let termination: "verified" | "unknown" = "verified";
    if (entry) {
      termination = (await this.deps.driver.stop(entry.handle)).termination;
      await this.deps.store.endAttempt(assignment, entry.handle.identity.attempt, "cancelled", termination);
      await this.release(assignment, termination);
    }
    await this.deps.store.cancelAssignment(assignment);
    this.deps.metrics.record("cancellation", { task: a.task, assignment, role: a.role, outcome: termination });
    return success({ termination });
  }

  /**
   * Resume after a coordinator restart: reconcile attempts from supervision
   * evidence, reclaim only reservations whose assignments ended with verified
   * termination, and validate owned worktrees. Nothing is relaunched here.
   */
  async reconcileOnResume(inspect: (assignment: string, attempt: string) => AttemptEvidence): Promise<{ attempts: ReconcileReport; reclaimed: string[]; retained: string[]; worktreeIssues: string[] }> {
    const d = this.deps;
    const attempts = await reconcileRun(d.store, inspect);
    const state = d.store.state;
    const { reclaimed, retained } = await d.capacity.reclaim((reservation) => {
      if (reservation.run !== state.run.id) return "alive"; // another run's reservation is not ours to judge
      const a = state.assignments[reservation.assignment];
      if (!a) return "unknown";
      const open = a.attempts.some((x) => x.status !== "ended" || x.termination !== "verified");
      return open ? "unknown" : "terminated";
    });
    const worktreeIssues: string[] = [];
    for (const record of await d.worktrees.list()) {
      if (record.state !== "active") continue;
      const valid = await d.worktrees.validate(record);
      if (!valid.ok) worktreeIssues.push(`${record.id}: ${valid.blocker.code}`);
    }
    if (attempts.unknown.length > 0) d.metrics.record("supervision-gap", { outcome: `${attempts.unknown.length} attempt(s) with unknown termination` });
    return { attempts, reclaimed, retained: retained.map((r) => r.id), worktreeIssues };
  }

  /** Content hash helper for approved artifacts (shared with the interface layer). */
  static artifactDigest(content: string): string {
    return hashJson({ content });
  }
}

/** Render the bounded brief the worker reads: role guidance plus the sealed contract. */
export function renderBrief(sealed: SealedBrief, roleGuide: string): string {
  const b = sealed.brief;
  const lines = [
    `# Radian assignment brief`,
    ``,
    `Identity: ${b.identity.assignment} / attempt ${b.identity.attempt} / generation ${b.identity.generation} / role ${b.identity.role}`,
    `Round: ${b.round.current} of ${b.round.max}`,
    `Base commit: ${b.base.commit}${b.base.candidate ? ` (candidate ${b.base.candidate})` : ""}`,
    `Profile: ${b.profile.runtime} / ${b.profile.provider} / ${b.profile.model} / effort ${b.profile.effort}`,
    `Remaining execution budget: ${Math.floor(b.budget.executionMsRemaining / 60_000)} minute(s)`,
    ``,
    `## Objective`,
    b.objective,
    ``,
    `## Non-goals`,
    ...(b.nonGoals.length ? b.nonGoals.map((x) => `- ${x}`) : ["- (none stated)"]),
    ``,
    `## Acceptance criteria (binding)`,
    ...b.acceptanceCriteria.map((x) => `- ${x}`),
    ``,
    `## Authority (enforced mechanically)`,
    `- Write roots: ${b.authority.writeRoots.length ? b.authority.writeRoots.join(", ") : "none (report only)"}`,
    `- Output directory: ${b.authority.outputDir}`,
    `- Operations: ${b.authority.operations.join(", ")}`,
    `- Never: ${b.authority.prohibited.join(", ")}`,
    ``,
    `## Required checks`,
    ...(b.requiredChecks.length ? b.requiredChecks.map((c) => `- ${c.id}: ${c.description} — \`${c.argv.join(" ")}\``) : ["- (none)"]),
    ``,
    `## Deliverables`,
    ...(b.deliverables.length ? b.deliverables.map((x) => `- ${x}`) : ["- result envelope"]),
    ``,
    `## Context`,
    ...(b.context.length ? b.context.map((c) => `- ${c.label}${c.text ? `: ${c.text}` : ""}`) : ["- (none)"]),
    ``,
    `## Result envelope`,
    `Write \`result.json\` in your output directory with schema \`radian.result/1\`, identity exactly as above, \`briefHash\` "${sealed.hash}", outcome, summary, deliverables, checks (with candidate revision and exit codes), findings, unmet criteria, risks, decision requests, handoff state, usage ("unknown" unless reported), and modelAttestation "unverified".`,
    ``,
    `## Role guidance`,
    roleGuide,
  ];
  return lines.join("\n");
}

/** Attempt evidence from the supervision registry: registered processes must be verifiably gone. */
export function attemptEvidenceFromRegistry(stateDir: string, probe: IdentityProbe = psProbe): (assignment: string, attempt: string) => AttemptEvidence {
  return (assignment, attempt) => {
    const registry = new SupervisionRegistry(stateDir, assignment);
    if (registry.unresolvedIntents(attempt).length > 0) return "unknown";
    const terminated = registry.entries().some((e) => e.kind === "terminated" && e.attempt === attempt && e.postcondition === "verified");
    const states = registry.processes(attempt).map((id) => liveness(id, probe));
    if (states.includes("alive")) return "alive";
    if (states.includes("unknown")) return "unknown";
    if (states.length === 0 && !terminated) return "unknown";
    return "terminated";
  };
}
