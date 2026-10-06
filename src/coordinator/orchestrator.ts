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

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Blocker, type Outcome, refuse, success } from "../contracts/blockers.ts";
import { type AuthorityRequest, type Operation, resolveAuthority } from "../contracts/authority.ts";
import { sealBrief, type SealedBrief } from "../contracts/brief.ts";
import { newId, type AssignmentIdentity, type Role } from "../contracts/identity.ts";
import type { CandidateRef, CheckEvidence } from "../contracts/records.ts";
import type { WorkerResult } from "../contracts/result.ts";
import { type ResolvedProfile, recheckResolvedProfile } from "../config/provider-policy.ts";
import { type SelectionRequest, selectProfile } from "../config/dispatch.ts";
import type { ConfigSnapshot } from "../config/resolve.ts";
import { assembleCandidate, validateCheckOutputRoots, verifyCheckout } from "../git/candidate.ts";
import { type CommitIdentity, type Delivery, deliverFromWorktree } from "../git/delivery.ts";
import { integrateCandidate } from "../git/integration.ts";
import { type ProtectedTarget, type Repository, resolveCommit } from "../git/repository.ts";
import type { WorktreeManager, WorktreePurpose } from "../git/worktrees.ts";
import { HumanChannel, requireApproval } from "../state/approvals.ts";
import type { CapacityLedger } from "../state/capacity.ts";
import { atomicWriteJson, ensureDir, readJsonIfExists } from "../state/fsutil.ts";
import { collectResult } from "../state/inbox.ts";
import { type AttemptEvidence, type ReconcileReport, reconcileRun } from "../state/reconcile.ts";
import { SupervisionRegistry } from "../isolation/registry.ts";
import { type IdentityProbe, liveness, psProbe } from "../util/process-identity.ts";
import { type RunStore, candidateCycle } from "../state/run-store.ts";
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
  /**
   * Current content of an approved artifact, read without following links.
   * Required-check definitions come only from the approved plan's content;
   * without this reader, required checks are refused.
   */
  artifactContent?: (relativePath: string) => string | undefined;
  roleGuide: (role: Role) => string;
  /** Watcher and coordinator-lease health; polled at launch and while owned work is alive. */
  supervisionHealthy: () => Outcome<true>;
  /** Interval for active health monitoring while this coordinator owns live attempts (default 1000 ms). */
  safetyIntervalMs?: number;
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
  /**
   * Repository-relative write roots ("" = whole tree); empty for report-only
   * roles. For candidate checks these are only declared untracked output roots
   * (validated against the candidate tree); source, tests, and config stay read-only.
   */
  writeRoots: string[];
  operations: Operation[];
  ports?: number[];
  dependencyChangesApproved?: boolean;
  selection: Omit<SelectionRequest, "role">;
  /**
   * Legacy, non-authoritative: ignored. Candidate cycles are derived from
   * durable task state by the run store (`candidateCycle`), never from a flag.
   */
  newCandidateRound?: boolean;
  /** Commit the worktree starts from: target head, or the candidate being repaired/checked/reviewed. */
  base: { kind: "target" } | { kind: "commit"; commit: string };
  artifacts: ApprovedArtifacts;
  context?: Array<{ label: string; text?: string }>;
}

export type AssignmentOutcome =
  | { state: "completed"; assignment: string; result: WorkerResult; delivery?: Delivery; worktree: string; checks?: CheckEvidence[] }
  | { state: "blocked"; assignment?: string; blocker: { code: string; message: string; nextAction?: string }; decisionId?: string }
  | { state: "failed"; assignment: string; reason: string; termination: "verified" | "unknown" };

interface TaskEvidence {
  candidate?: CandidateRef & { round: number };
  /** Check IDs the approved plan requires for this task; integration is refused until each passes. */
  requiredChecks?: string[];
  /** Argument vector for each required check, as declared by the approved plan named in `checkDefinitionsPlan`. */
  requiredCheckArgv?: Record<string, string[]>;
  /** Content hash of the human-approved plan the definitions came from (their approval provenance). */
  checkDefinitionsPlan?: string;
  /** Only coordinator-bound evidence (assignment, attempt, tree, approved argv) is recorded here. */
  checks: CheckEvidence[];
  review?: { candidate: string; blockingFindings: number; outcome: WorkerResult["outcome"]; findings: number };
  risks: string[];
}

interface AttemptEntry {
  handle: WorkerHandle;
  reservation: string;
  worktree: string;
  plan: AssignmentPlan;
  profile: ResolvedProfile;
  brief: SealedBrief;
  /** Aborts the attempt's binding/settlement waits when it is interrupted. */
  abort: AbortController;
  /** Set (synchronously) by whichever path takes over finishing the attempt. */
  finishing?: boolean;
  /** The one stop for this attempt; a retained unknown-termination entry clears it to retry. */
  stopping?: Promise<{ termination: "verified" | "unknown" }>;
  interruption?: { blocker: Blocker; done: Promise<void> };
}

const INTERRUPTED: unique symbol = Symbol("interrupted");

export class Coordinator {
  readonly deps: CoordinatorDeps;
  private readonly handles = new Map<string, AttemptEntry>();
  /** Attempts whose termination could not be verified; their resources stay owned. */
  private readonly unresolved = new Map<string, AttemptEntry>();
  /** Latched on supervision or lease loss: no new dispatch from this coordinator. */
  private halted: Blocker | undefined;
  private monitor: NodeJS.Timeout | undefined;
  /**
   * Attempts handed to the driver whose runtime has not been confirmed bound:
   * a product-approval change revokes their start before it is committed
   * (W06/F03), so nothing new begins under the old approval.
   */
  private readonly pendingStarts = new Map<string, { assignment: string; task: string; authorize: () => Outcome<true> }>();
  /** Pending starts revoked by an approval change (or a failed recheck) before they were known to have begun. */
  private readonly approvalRevoked = new Set<string>();

  constructor(deps: CoordinatorDeps) {
    this.deps = deps;
    deps.store.onBeforeApprovalChange?.((change) => this.revokePendingStarts(change.task));
  }

  /**
   * Revoke every not-yet-bound start of a task (all tasks when undefined)
   * under the supervision registry lock — the same lock the launcher holds
   * when it records an intent — and stop attempts the driver already returned.
   * Called before an approval change is committed.
   */
  async revokePendingStarts(task: string | undefined, reason = "a product approval changed before the attempt started"): Promise<void> {
    for (const [attempt, pending] of [...this.pendingStarts]) {
      if (task !== undefined && pending.task !== task) continue;
      await new SupervisionRegistry(this.deps.paths.stateDir, pending.assignment).revoke(attempt);
      this.approvalRevoked.add(attempt);
      const entry = this.handles.get(pending.assignment);
      if (entry && entry.handle.identity.attempt === attempt) void this.stopForApproval(pending.assignment, entry, reason).catch(() => undefined);
    }
  }

  /** Stop and account for an attempt whose start authorization became stale; never a recovery trigger. */
  private stopForApproval(assignment: string, entry: AttemptEntry, reason: string): Promise<void> {
    const blocker: Blocker = { code: "APPROVAL_STALE", message: `${reason}; nothing new starts under the old approval`, nextAction: "Review the change, then dispatch again under the current approvals." };
    return this.interrupt(entry, blocker, async (termination) => {
      const attempt = entry.handle.identity.attempt;
      const began = new SupervisionRegistry(this.deps.paths.stateDir, assignment).entries().some((e) => e.attempt === attempt && (e.kind === "intent" || e.kind === "process"));
      await this.deps.store.endAttempt(assignment, attempt, began ? "cancelled" : "not-started", termination);
      await this.release(assignment, termination);
    });
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

  /**
   * The required checks declared by the task's human-approved plan revision
   * (the `radian-checks` block of the plan artifact whose approval the plan
   * hash names). The artifact is re-read and re-hashed, so a definition has
   * approval provenance only if it is in the approved content itself.
   */
  approvedCheckDefinitions(task: string, planHash: string): Outcome<{ plan: string; checks: Record<string, string[]> }> {
    const approval = requireApproval(this.deps.store.state, { task, kind: "plan" }, { artifactHash: planHash });
    if (!approval.ok) return approval;
    const content = this.deps.artifactContent?.(approval.value.artifact.path);
    if (content === undefined) return refuse("APPROVAL_STALE", "the approved plan cannot be read safely; its check definitions cannot be verified");
    if (Coordinator.artifactDigest(content) !== planHash) return refuse("APPROVAL_STALE", "the approved plan changed; its check definitions need a new approval");
    const parsed = parseCheckDefinitions(content);
    return parsed.ok ? success({ plan: planHash, checks: parsed.value }) : parsed;
  }

  /**
   * Record the required checks for a task. Every requested check must be
   * declared, with exactly the same argument vector, by the human-approved plan
   * revision the assignment is bound to; the task then requires every check
   * that plan declares. A first-seen vector is not approval, and a changed
   * definition needs an approved plan revision. Definitions persist across
   * candidate assembly, restarts, and context restores.
   */
  setRequiredChecks(task: string, checks: ReadonlyArray<{ id: string; argv: readonly string[] }>, planHash: string): Outcome<true> {
    const approved = this.approvedCheckDefinitions(task, planHash);
    if (!approved.ok) return approved;
    const declared = approved.value.checks;
    if (Object.keys(declared).length === 0) return refuse("APPROVAL_MISSING", "the approved plan declares no required checks", "Add a radian-checks block to the plan and ask the user to approve the revision.");
    for (const check of checks) {
      const definition = declared[check.id];
      if (!definition) return refuse("CANDIDATE_MISMATCH", `required check '${check.id}' is not declared by the approved plan`, "Use the plan's declared checks, or ask the user to approve a revised plan.");
      if (!sameArgv(definition, check.argv)) return refuse("CANDIDATE_MISMATCH", `required check '${check.id}' does not match the approved plan's command`, "Keep the approved check definition, or ask the user to approve a revised plan.");
    }
    const evidence = this.evidence(task);
    evidence.requiredChecks = Object.keys(declared).sort();
    evidence.requiredCheckArgv = declared;
    evidence.checkDefinitionsPlan = approved.value.plan;
    this.saveEvidence(task, evidence);
    return success(true);
  }

  /** Before an exact-candidate check: the current candidate, approved checks, and untracked output roots only. */
  private async validateCandidateCheck(plan: AssignmentPlan): Promise<Outcome<CandidateRef>> {
    const current = this.evidence(plan.task).candidate;
    if (plan.base.kind !== "commit" || !current || current.commit !== plan.base.commit) {
      return refuse("CANDIDATE_MISMATCH", "candidate checks run only on the task's current assembled candidate", "Check the latest candidate; a repaired candidate needs its own checks.");
    }
    if (!plan.requiredChecks?.length) return refuse("CANDIDATE_MISMATCH", "a candidate check needs the plan's required checks");
    if (plan.requiredChecks.some((c) => !/^[A-Za-z0-9._-]{1,128}$/.test(c.id) || c.argv.length === 0)) return refuse("CONFIG_INVALID", "check ids must be simple names and every check needs an argument vector");
    const recorded = this.setRequiredChecks(plan.task, plan.requiredChecks, plan.artifacts.plan);
    if (!recorded.ok) return recorded;
    const roots = await validateCheckOutputRoots(this.deps.repo, current.commit, plan.writeRoots);
    if (!roots.ok) return roots;
    const { round: _round, ...candidate } = current;
    return success(candidate);
  }

  private identityFor(assignment: string, attempt: string, generation: number, task: string, role: Role): AssignmentIdentity {
    return { workspace: this.deps.workspace, project: this.deps.project, run: this.deps.store.state.run.id, task, assignment, attempt, generation, role };
  }

  /** Validate a plan, allocate an owned worktree, resolve authority, seal the brief, and record the assignment. */
  async prepare(plan: AssignmentPlan): Promise<Outcome<{ assignment: string; profile: ResolvedProfile; brief: SealedBrief; worktree: string; reservation?: string }>> {
    const d = this.deps;
    if (this.halted) return { ok: false, blocker: this.halted };
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

    if (plan.purpose === "candidate-check") {
      const checkable = await this.validateCandidateCheck(plan);
      if (!checkable.ok) return checkable;
    } else if (plan.requiredChecks?.length) {
      const recorded = this.setRequiredChecks(plan.task, plan.requiredChecks, plan.artifacts.plan);
      if (!recorded.ok) return recorded;
    }

    // The candidate cycle comes from durable state; the store re-derives it under its lock.
    const cycle = candidateCycle(d.store.state, plan.task, plan.role, plan.purpose);
    if (!cycle.ok) {
      if (cycle.blocker.code === "ROUNDS_EXHAUSTED") {
        d.metrics.record("rounds-exhausted", { task: plan.task, role: plan.role });
        await d.store.setPhase(plan.task, "blocked");
      }
      return cycle;
    }

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

    const round = Math.max(cycle.value.round, 1);
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
        purpose: plan.purpose,
        expectedRound: cycle.value.round,
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
    if (cycle.value.starts) d.metrics.record("round-started", { task: plan.task, round });
    return success({ assignment, profile, brief: sealed.value, worktree: worktree.value.path });
  }

  /**
   * Run one attempt of a prepared assignment end to end. Capacity is reserved
   * before launch; the reservation and worktree ownership are released only
   * after verified termination.
   */
  async runAttempt(assignment: string, plan: AssignmentPlan, prepared: { profile: ResolvedProfile; brief: SealedBrief; worktree: string }, attemptOptions: { humanDecisionId?: string; resumeDecisionId?: string } = {}): Promise<AssignmentOutcome> {
    const d = this.deps;
    // The launch authorization: rechecked before reservation, after every awaited
    // setup step, and by the driver at the last boundary before delivery.
    const authorize = (): Outcome<true> => this.launchAuthorization(plan, prepared);
    const initial = authorize();
    if (!initial.ok) return { state: "blocked", assignment, blocker: initial.blocker };

    const reservation = await d.capacity.reserve(d.capacityCeiling, { project: d.project, run: d.store.state.run.id, assignment, role: plan.role });
    if (!reservation.ok) return { state: "blocked", assignment, blocker: reservation.blocker };

    const started = await d.store.startAttempt(assignment, attemptOptions);
    if (!started.ok) {
      await d.capacity.release(reservation.value.id, "terminated");
      return { state: "blocked", assignment, blocker: started.blocker };
    }
    const a = started.value.assignments[assignment]!;
    const attempt = a.attempts.at(-1)!;
    let claimedWorktree: string | undefined;
    const notStarted = (blocker: Blocker): Promise<AssignmentOutcome> => this.endBeforeLaunch(assignment, attempt.id, claimedWorktree, reservation.value.id, blocker);
    const identity = this.identityFor(assignment, attempt.id, attempt.generation, a.task, a.role);
    const worktreeRecord = (await d.worktrees.list()).find((w) => w.assignment === assignment && w.state === "active");
    if (!worktreeRecord) return notStarted({ code: "OWNERSHIP_AMBIGUOUS", message: "assignment worktree is missing" });
    const claimed = await d.worktrees.claim(worktreeRecord.id, attempt.id, attempt.generation);
    if (!claimed.ok) return notStarted(claimed.blocker);
    claimedWorktree = worktreeRecord.id;

    // The brief identity carries the real attempt/generation; reseal against it.
    const brief = sealBrief({ ...prepared.brief.brief, identity, budget: { ...prepared.brief.brief.budget, executionMsRemaining: d.store.remainingMs(assignment), automaticRecoveriesRemaining: Math.max(0, a.maxAutomaticRecoveries - a.automaticRecoveriesUsed) } });
    if (!brief.ok) return notStarted(brief.blocker);
    const fixed = await d.store.recordAttemptBrief(assignment, attempt.id, brief.value.hash);
    if (!fixed.ok) return notStarted(fixed.blocker);
    // Workers cannot read the project root, and planning drafts need not be committed: deliver verified copies.
    const delivered = this.deliverApprovedArtifacts(brief.value);
    if (!delivered.ok) return notStarted(delivered.blocker);
    const briefText = renderBrief(brief.value, d.roleGuide(a.role));
    // Exact-candidate checks are executed by the contained launcher itself; their records are the evidence.
    const checkRuns = plan.purpose === "candidate-check" ? brief.value.brief.requiredChecks.map((c) => ({ id: c.id, argv: [...c.argv] })) : undefined;
    const checkTimeoutMs = checkRuns ? d.store.remainingMs(assignment) : 0;
    // An approval change whose pre-commit revocation already ran (before this attempt was a
    // pending start) may still be waiting to commit: wait, then authorize against the committed
    // decision. Nothing awaits between this authorization and registering the pending start,
    // so every later change revokes it before committing (W06/F03 follow-up).
    while (d.store.approvalChangeInFlight()) await d.store.whenApprovalChangesSettled();
    const ready = authorize();
    if (!ready.ok) return notStarted(ready.blocker);
    if (attempt.automatic) d.metrics.record("recovery", { task: a.task, assignment, role: a.role, outcome: "automatic" });
    d.metrics.record("assignment-started", { task: a.task, assignment, role: a.role, runtime: prepared.profile.runtime, model: prepared.profile.model, effort: prepared.profile.effort, round: a.round });

    // From here until binding, an approval change revokes this start before it is committed.
    this.pendingStarts.set(attempt.id, { assignment, task: a.task, authorize });
    const launched = await d.driver.launch({
      identity,
      profile: prepared.profile,
      authority: brief.value.brief.authority,
      brief: brief.value,
      briefText,
      systemPrompt: d.roleGuide(a.role),
      authorize,
      // The launcher re-hashes every approved artifact immediately before anything starts.
      startGate: { projectRoot: d.repo.root, artifacts: brief.value.brief.approvals.map((x) => ({ kind: x.kind, path: x.artifact.path, hash: x.artifact.hash })) },
      ...(checkRuns ? { checks: { runs: checkRuns, timeoutMs: checkTimeoutMs } } : {}),
    });
    if (launched.kind === "refused") {
      this.pendingStarts.delete(attempt.id);
      this.approvalRevoked.delete(attempt.id);
      d.metrics.record("preflight-blocked", { task: a.task, assignment, role: a.role, outcome: launched.blocker.code });
      return notStarted(launched.blocker);
    }
    // From here the attempt may have started: it is owned work until stopped and verified.
    const handle = launched.handle;
    const entry: AttemptEntry = { handle, reservation: reservation.value.id, worktree: worktreeRecord.id, plan, profile: prepared.profile, brief: brief.value, abort: new AbortController() };
    this.handles.set(assignment, entry);
    this.ensureMonitoring();
    await d.capacity.setState(reservation.value.id, "active");
    // Supervision may have been lost while the launch was in flight: the new attempt is stopped with the rest.
    const afterLaunch = this.halted ? { ok: false as const, blocker: this.halted } : d.supervisionHealthy();
    if (!afterLaunch.ok) await this.supervisionLost(afterLaunch.blocker);
    // An approval changed while the launch was in flight: its start was revoked; stop and account for it.
    if (!entry.abort.signal.aborted && this.approvalRevoked.has(attempt.id)) await this.stopForApproval(assignment, entry, "a product approval changed during the launch");
    if (entry.abort.signal.aborted) return this.interrupted(assignment, entry);
    if (launched.kind === "uncertain") return this.finishFailure(assignment, "infrastructure", `launch delivery was not confirmed: ${launched.blocker.message}`);

    const bound = await this.interruptible(entry, d.driver.awaitBinding(handle, Date.now() + d.startupMs + checkTimeoutMs, entry.abort.signal));
    if (bound === INTERRUPTED || entry.abort.signal.aborted) return this.interrupted(assignment, entry);
    if (!bound.ok) return this.finishFailure(assignment, "infrastructure", bound.blocker.message);
    // Bound: the runtime started under then-current approvals (later changes do not stop running work).
    this.pendingStarts.delete(attempt.id);
    const binding = await d.store.bindAttempt(identity);
    if (entry.abort.signal.aborted) return this.interrupted(assignment, entry);
    if (!binding.ok) return this.finishFailure(assignment, "infrastructure", binding.blocker.message);
    d.metrics.record("assignment-bound", { task: a.task, assignment, role: a.role });

    const settled = await this.interruptible(entry, d.driver.awaitSettled(handle, Date.now() + d.store.remainingMs(assignment), entry.abort.signal));
    if (settled === INTERRUPTED || entry.abort.signal.aborted) return this.interrupted(assignment, entry);
    if (settled.kind === "timeout") return this.finishFailure(assignment, "timeout", "execution budget exhausted");
    if (settled.kind === "settled" && settled.outcome === "error" && settled.error?.class === "quota") {
      return this.finishQuota(assignment, settled.error.summary, settled.error.resetAtMs);
    }
    if (settled.kind === "settled" && settled.outcome === "error" && (settled.error?.class === "infrastructure" || settled.error?.class === "unknown")) {
      // Results written before the failure are still collected below if present.
    }
    return this.finishSettled(assignment, settled.kind === "settled" ? settled.usage : undefined);
  }

  /**
   * Whether a new attempt of this plan may begin now: Build mode for modifying
   * work, healthy supervision, the proposal 0015 pairing, and every approval
   * bound into the brief still current — its artifact re-hashed from the
   * coordinator-owned path and the latest human decision for that kind still an
   * approval of exactly that content (not rejected, invalidated, or replaced).
   * Recovery or retry authorizations never substitute for these approvals.
   */
  launchAuthorization(plan: AssignmentPlan, prepared: { profile: ResolvedProfile; brief: SealedBrief }): Outcome<true> {
    const d = this.deps;
    if (this.halted) return { ok: false, blocker: this.halted };
    const modeCheck = requireModeFor(d.mode.mode, plan.purpose === "candidate-check" ? { kind: "candidate-check" } : { kind: "dispatch", role: plan.role });
    if (!modeCheck.ok) return modeCheck;
    const healthy = d.supervisionHealthy();
    if (!healthy.ok) return healthy;
    const pairing = recheckResolvedProfile(prepared.profile);
    if (!pairing.ok) return pairing;
    const approvals = prepared.brief.brief.approvals;
    if (approvals.length === 0) return refuse("APPROVAL_MISSING", "assignments require at least one current approved artifact");
    for (const bound of approvals) {
      const current = d.artifactHash(bound.artifact.path);
      if (current === undefined) return refuse("APPROVAL_STALE", `the approved ${bound.kind} artifact is missing or unreadable`, "Restore the artifact or ask the user to approve a revision.");
      if (current !== bound.artifact.hash) return refuse("APPROVAL_STALE", `the approved ${bound.kind} artifact changed after the assignment was prepared`, "Ask the user to review and approve the changed artifact.");
      const valid = requireApproval(d.store.state, { task: plan.task, kind: bound.kind }, { artifactHash: current });
      if (!valid.ok) return valid;
    }
    return success(true);
  }

  /**
   * Copy each approved artifact into the attempt's output directory, only if
   * its current content still matches the approved hash. The brief lists
   * these copies; the project's own files stay the authority.
   */
  private deliverApprovedArtifacts(sealed: SealedBrief): Outcome<true> {
    const outputDir = sealed.brief.authority.outputDir;
    for (const approval of sealed.brief.approvals) {
      const content = this.deps.artifactContent?.(approval.artifact.path);
      if (content === undefined || Coordinator.artifactDigest(content) !== approval.artifact.hash) {
        return refuse("APPROVAL_STALE", `the approved ${approval.kind} artifact cannot be delivered unchanged`, "Ask the user to review and approve the current artifact.");
      }
      const file = approvedCopyPath(outputDir, approval);
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      rmSync(file, { force: true });
      writeFileSync(file, content, { mode: 0o444 });
    }
    return success(true);
  }

  /** A launch refused before anything could start: end the attempt verified as not-started and release what it held. */
  private async endBeforeLaunch(assignment: string, attempt: string, worktree: string | undefined, reservation: string, blocker: Blocker): Promise<AssignmentOutcome> {
    this.pendingStarts.delete(attempt);
    this.approvalRevoked.delete(attempt);
    await this.deps.store.endAttempt(assignment, attempt, "not-started", "verified");
    if (worktree) await this.deps.worktrees.markRetired(worktree, attempt);
    await this.deps.capacity.release(reservation, "terminated");
    return { state: "blocked", assignment, blocker };
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
    const entry = this.handles.get(assignment) ?? this.unresolved.get(assignment);
    if (!entry) return;
    this.pendingStarts.delete(entry.handle.identity.attempt);
    this.approvalRevoked.delete(entry.handle.identity.attempt);
    this.handles.delete(assignment);
    if (termination === "verified") {
      this.unresolved.delete(assignment);
      await this.deps.worktrees.markRetired(entry.worktree, entry.handle.identity.attempt);
      await this.deps.capacity.release(entry.reservation, "terminated");
      return;
    }
    // Unknown termination keeps the reservation, worktree ownership, and the
    // handle (so a later cancel can retry the stop): replacement stays blocked.
    delete entry.stopping;
    this.unresolved.set(assignment, entry);
  }

  private stopOnce(entry: AttemptEntry): Promise<{ termination: "verified" | "unknown" }> {
    entry.stopping ??= this.deps.driver.stop(entry.handle);
    return entry.stopping;
  }

  private interruptible<T>(entry: AttemptEntry, wait: Promise<T>): Promise<T | typeof INTERRUPTED> {
    if (entry.abort.signal.aborted) return Promise.resolve(INTERRUPTED);
    const aborted = new Promise<typeof INTERRUPTED>((resolve) => entry.abort.signal.addEventListener("abort", () => resolve(INTERRUPTED), { once: true }));
    return Promise.race([wait, aborted]);
  }

  /** The attempt was taken over by an interruption (supervision loss, pause, cancel); report its outcome. */
  private async interrupted(assignment: string, entry: AttemptEntry): Promise<AssignmentOutcome> {
    await entry.interruption?.done;
    return { state: "blocked", assignment, blocker: entry.interruption?.blocker ?? this.halted ?? { code: "SUPERVISION_UNHEALTHY", message: "the attempt was interrupted" } };
  }

  /**
   * Take over a live attempt: abort its waits, stop it once, then finalize.
   * Idempotent per attempt. If the normal path is already finishing it, only
   * the (shared) stop is awaited so the worker is not left running.
   */
  private interrupt(entry: AttemptEntry, blocker: Blocker, finalize: (termination: "verified" | "unknown") => Promise<void>): Promise<void> {
    if (entry.interruption) return entry.interruption.done;
    if (entry.finishing) {
      const done = this.stopOnce(entry).then(() => undefined);
      entry.interruption = { blocker, done };
      return done;
    }
    entry.finishing = true;
    entry.abort.abort();
    const done = (async () => {
      const stopped = await this.stopOnce(entry);
      try {
        await finalize(stopped.termination);
      } catch {
        // Bookkeeping failures (for example a lost lease) never undo the stop; ownership stays as released above.
      }
    })();
    entry.interruption = { blocker, done };
    return done;
  }

  /**
   * Respond to watcher, heartbeat, or coordinator-lease loss while this
   * coordinator is still alive: latch a halt (no new dispatch), then stop every
   * live attempt concurrently, ending each with its honest termination, keeping
   * capacity and ownership when termination is unknown, and opening a
   * supervision blocker. Nothing restarts automatically; a restarted watcher
   * is not evidence that earlier work stopped. Idempotent.
   */
  async supervisionLost(blocker: Blocker): Promise<void> {
    const d = this.deps;
    if (!this.halted) {
      this.halted = { code: blocker.code, message: blocker.message, nextAction: "Owned work was stopped. Restart the coordinator session and reconcile before dispatching again." };
      d.metrics.record("supervision-gap", { outcome: blocker.code });
    }
    const lost = this.halted;
    const outcomes: Array<{ assignment: string; attempt: string; termination: "verified" | "unknown"; retained?: true }> = [];
    await Promise.all([
      ...[...this.handles.entries()].map(([assignment, entry]) =>
        this.interrupt(entry, lost, async (termination) => {
          outcomes.push({ assignment, attempt: entry.handle.identity.attempt, termination });
          await d.store.endAttempt(assignment, entry.handle.identity.attempt, "infrastructure", termination);
          await this.release(assignment, termination);
          await d.store.block(assignment, "supervision", `Supervision was lost (${lost.code}: ${lost.message}). Owned work was stopped; termination ${termination}. Work is preserved; nothing restarts automatically.`);
        }),
      ),
      // Retained work whose earlier stop was unverified may still be alive: stop it again (W06/F04).
      ...[...this.unresolved.entries()].map(async ([assignment, entry]) => {
        const termination = await this.retryRetained(assignment, entry);
        outcomes.push({ assignment, attempt: entry.handle.identity.attempt, termination, retained: true });
      }),
    ]);
    try {
      ensureDir(path.join(d.paths.stateDir, "supervision"));
      atomicWriteJson(path.join(d.paths.stateDir, "supervision", "coordinator-loss.json"), { schema: "radian.coordinator-loss/1", reason: lost.code, message: lost.message, at: new Date(d.clock.now()).toISOString(), outcomes });
    } catch {
      // The run log and supervision registry still hold the per-attempt evidence.
    }
    if (this.handles.size === 0) this.stopMonitoring();
  }

  /**
   * Stop retained (unknown-termination) work again. The stop is shared by
   * concurrent callers; the attempt was already ended, so it is never
   * finalized twice; a verified stop releases its slot and worktree once.
   */
  private async retryRetained(assignment: string, entry: AttemptEntry): Promise<"verified" | "unknown"> {
    const stopped = await this.stopOnce(entry);
    if (this.unresolved.get(assignment) === entry) await this.release(assignment, stopped.termination);
    return stopped.termination;
  }

  /** Poll supervision and lease health while this coordinator owns live or retained (possibly alive) attempts. */
  private ensureMonitoring(): void {
    if (this.monitor) return;
    this.monitor = setInterval(() => {
      if (this.handles.size === 0 && this.unresolved.size === 0) {
        this.stopMonitoring();
        return;
      }
      const healthy = this.halted ? { ok: false as const, blocker: this.halted } : this.deps.supervisionHealthy();
      if (!healthy.ok) {
        void this.supervisionLost(healthy.blocker).catch(() => undefined);
        return;
      }
      // An approved artifact can change without a recorded decision: recheck starts that are not yet bound.
      for (const [attempt, pending] of this.pendingStarts) {
        if (this.approvalRevoked.has(attempt) || !this.handles.has(pending.assignment)) continue;
        const current = pending.authorize();
        if (!current.ok) void this.revokeOne(attempt, pending, current.blocker.message).catch(() => undefined);
      }
    }, Math.max(10, this.deps.safetyIntervalMs ?? 1000));
    this.monitor.unref();
  }

  private async revokeOne(attempt: string, pending: { assignment: string }, reason: string): Promise<void> {
    if (this.approvalRevoked.has(attempt)) return;
    this.approvalRevoked.add(attempt);
    await new SupervisionRegistry(this.deps.paths.stateDir, pending.assignment).revoke(attempt);
    const entry = this.handles.get(pending.assignment);
    if (entry && entry.handle.identity.attempt === attempt) await this.stopForApproval(pending.assignment, entry, reason);
  }

  /** Stop active monitoring (session shutdown). */
  stopMonitoring(): void {
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = undefined;
  }

  private async finishFailure(assignment: string, reason: "infrastructure" | "timeout", detail: string): Promise<AssignmentOutcome> {
    const entry = this.handles.get(assignment)!;
    entry.finishing = true;
    const stopped = await this.stopOnce(entry);
    await this.deps.store.endAttempt(assignment, entry.handle.identity.attempt, reason, stopped.termination);
    const a = this.deps.store.state.assignments[assignment]!;
    this.deps.metrics.record("assignment-ended", { task: a.task, assignment, role: a.role, outcome: reason, durationMs: a.budget.consumedMs, blockedMs: a.budget.blockedMs });
    await this.release(assignment, stopped.termination);
    return { state: "failed", assignment, reason: `${reason}: ${detail}`, termination: stopped.termination };
  }

  private async finishQuota(assignment: string, summary: string, resetAtMs: number | undefined): Promise<AssignmentOutcome> {
    const entry = this.handles.get(assignment)!;
    entry.finishing = true;
    const stopped = await this.stopOnce(entry);
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
    entry.finishing = true;
    const stopped = await this.stopOnce(entry);
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

    if (entry.plan.purpose === "candidate-check") {
      // Results are claims; only coordinator-verified bindings become evidence.
      const bound = await this.bindCheckEvidence(assignment, entry, result, stopped.termination);
      await this.release(assignment, stopped.termination);
      if (stopped.termination === "verified") await d.store.retire(assignment);
      if (!bound.ok) return { state: "blocked", assignment, blocker: bound.blocker };
      return { state: "completed", assignment, result, worktree: entry.handle.authority.worktree, checks: bound.value };
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
    // A new candidate makes earlier outcomes and reviews historical; the approved check definitions stay.
    const previous = this.evidence(task);
    this.saveEvidence(task, {
      candidate: { ...candidate, round: t.roundsUsed },
      checks: [],
      risks: [],
      ...(previous.requiredChecks ? { requiredChecks: previous.requiredChecks } : {}),
      ...(previous.requiredCheckArgv ? { requiredCheckArgv: previous.requiredCheckArgv } : {}),
      ...(previous.checkDefinitionsPlan ? { checkDefinitionsPlan: previous.checkDefinitionsPlan } : {}),
    });
    d.metrics.record("candidate-assembled", { task, round: t.roundsUsed });
    return success({ ...candidate, round: t.roundsUsed });
  }

  /**
   * Bind a finished candidate check to coordinator-recorded facts: verified
   * termination, the task's still-current candidate, a checkout verified to
   * hold exactly that candidate (outside declared output roots), the attempt
   * that ran, and each approved check's argument vector. The outcome comes only
   * from the launcher's execution record (exit status 0 and no timeout =
   * passed); the worker's report is a claim, noted when it disagrees. An
   * approved check without exactly one execution record is not-run.
   */
  private async bindCheckEvidence(assignment: string, entry: { handle: WorkerHandle; plan: AssignmentPlan; brief: SealedBrief }, result: WorkerResult, termination: "verified" | "unknown"): Promise<Outcome<CheckEvidence[]>> {
    if (termination !== "verified") return refuse("TERMINATION_UNVERIFIED", "the check's termination is unverified; its results are not evidence", "Reconcile the check assignment; run a fresh check after verified termination.");
    const task = entry.plan.task;
    const current = this.evidence(task).candidate;
    const checked = entry.brief.brief.base.candidate;
    if (!current || checked === undefined || current.commit !== checked) return refuse("CANDIDATE_MISMATCH", "the candidate changed while the check ran; its results are historical");
    const checkout = await verifyCheckout(this.deps.repo, entry.handle.authority.worktree, current, entry.plan.writeRoots);
    if (!checkout.ok) return checkout;
    const executions = this.deps.driver.checkExecutions(entry.handle);
    const bound: CheckEvidence[] = [];
    for (const approved of entry.brief.brief.requiredChecks) {
      const runs = executions.filter((e) => e.id === approved.id);
      const record: CheckEvidence = { id: approved.id, outcome: "not-run", candidate: current.commit, tree: current.tree, argv: [...approved.argv], assignment, attempt: entry.handle.identity.attempt };
      const notes: string[] = [];
      const run = runs.length === 1 ? runs[0]! : undefined;
      if (!run) notes.push(runs.length === 0 ? "no launcher execution record" : "more than one execution record");
      else {
        record.outcome = run.exitCode === 0 && !run.timedOut ? "passed" : "failed";
        record.exitCode = run.exitCode;
        if (run.timedOut) notes.push("timed out");
        else if (run.signal) notes.push(`ended by ${run.signal}`);
      }
      const claim = result.checks.find((c) => c.id === approved.id);
      if (claim && claim.outcome !== record.outcome) notes.push(`worker reported ${claim.outcome}`);
      if (notes.length) record.reason = notes.join("; ");
      bound.push(record);
    }
    const evidence = this.evidence(task);
    if (evidence.candidate?.commit !== current.commit) return refuse("CANDIDATE_MISMATCH", "the candidate changed while the check ran; its results are historical");
    evidence.checks = [...evidence.checks.filter((c) => !bound.some((b) => b.id === c.id)), ...bound];
    evidence.risks = [...new Set([...evidence.risks, ...result.risks])];
    this.saveEvidence(task, evidence);
    for (const check of bound) this.deps.metrics.record("check-outcome", { task, outcome: check.outcome });
    return success(bound);
  }

  /** Evidence the coordinator itself bound to the current candidate; anything else is historical or a claim. */
  private boundChecks(evidence: TaskEvidence): CheckEvidence[] {
    const candidate = evidence.candidate;
    return candidate ? evidence.checks.filter((c) => c.candidate === candidate.commit && c.tree === candidate.tree && c.attempt !== undefined && c.assignment !== undefined) : [];
  }

  recordReview(task: string, reviewedCandidate: string, result: WorkerResult): void {
    const evidence = this.evidence(task);
    evidence.review = { candidate: reviewedCandidate, blockingFindings: result.findings.filter((f) => f.severity === "blocker" || f.severity === "major").length, outcome: result.outcome, findings: result.findings.length };
    evidence.risks = [...new Set([...evidence.risks, ...result.risks])];
    this.saveEvidence(task, evidence);
    this.deps.metrics.record("review-outcome", { task, outcome: evidence.review.blockingFindings > 0 ? "changes-requested" : result.outcome });
  }

  /**
   * The required checks of the task's *current* approved plan revision (its
   * latest plan decision, still valid for the content on disk). Integration
   * is judged against these exact definitions, never against a caller-supplied
   * list or definitions recorded under an earlier revision (W06/F02 follow-up).
   */
  currentPlanChecks(task: string): Outcome<{ plan: string; checks: Record<string, string[]> }> {
    const latest = Object.values(this.deps.store.state.approvals).filter((a) => a.task === task && a.kind === "plan").at(-1);
    if (!latest) return refuse("APPROVAL_MISSING", "the task has no approved plan");
    const hash = this.deps.artifactHash(latest.artifact.path);
    if (!hash) return refuse("APPROVAL_STALE", "the approved plan is missing or unreadable");
    const current = this.approvedCheckDefinitions(task, hash);
    if (!current.ok) return current;
    if (Object.keys(current.value.checks).length === 0) return refuse("APPROVAL_MISSING", "the approved plan declares no required checks");
    return current;
  }

  /**
   * Gaps between the bound check evidence and the required checks: every check
   * the current plan declares must have passed with exactly its declared
   * command; any additional id the caller names must have passed too.
   */
  private checkGaps(task: string, checks: readonly CheckEvidence[], extra: readonly string[]): { gaps: string[]; required: string[]; accepted: CheckEvidence[] } {
    const current = this.currentPlanChecks(task);
    if (!current.ok) return { gaps: [`plan: ${current.blocker.message}`], required: [...extra], accepted: [] };
    const declared = current.value.checks;
    const gaps: string[] = [];
    const accepted: CheckEvidence[] = [];
    const required = [...new Set([...Object.keys(declared), ...extra])].sort();
    for (const id of required) {
      const definition = declared[id];
      if (!definition) {
        gaps.push(`check ${id}: not declared by the current approved plan`);
        continue;
      }
      const ran = checks.filter((c) => c.id === id);
      const matching = ran.filter((c) => c.argv !== undefined && sameArgv(c.argv, definition));
      const passed = matching.find((c) => c.outcome === "passed");
      if (passed) accepted.push(passed);
      else if (matching.length > 0) gaps.push(`check ${id}: ${matching.at(-1)!.outcome}`);
      else if (ran.length > 0) gaps.push(`check ${id}: ran a command the current approved plan does not declare`);
      else gaps.push(`check ${id}: not run`);
    }
    return { gaps, required, accepted };
  }

  /** Compact summary presented to the human before the integration decision. */
  async integrationSummary(task: string, requiredChecks: readonly string[]): Promise<Outcome<{ candidate: CandidateRef; target: { ref: string; commit: string }; checks: CheckEvidence[]; review: TaskEvidence["review"]; risks: string[]; ready: boolean; gaps: string[] }>> {
    const d = this.deps;
    const evidence = this.evidence(task);
    if (!evidence.candidate) return refuse("CANDIDATE_MISMATCH", "no candidate has been assembled");
    const head = await resolveCommit(d.repo, d.target.ref);
    if (!head.ok) return head;
    const checks = this.boundChecks(evidence);
    const gaps = [...this.checkGaps(task, checks, requiredChecks).gaps];
    if (!evidence.review || evidence.review.candidate !== evidence.candidate.commit) gaps.push("review: not run on this candidate");
    else if (evidence.review.blockingFindings > 0) gaps.push(`review: ${evidence.review.blockingFindings} blocking finding(s)`);
    if (head.value !== evidence.candidate.base) gaps.push("target moved since assembly");
    const { round: _round, ...candidate } = evidence.candidate;
    return success({ candidate, target: { ref: d.target.ref, commit: head.value }, checks, review: evidence.review, risks: evidence.risks, ready: gaps.length === 0, gaps });
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
    // Judged against the current approved plan's exact definitions; the caller's list can only add.
    const judged = this.checkGaps(task, this.boundChecks(evidence), requiredChecks);
    if (judged.gaps.length > 0) return refuse("CANDIDATE_MISMATCH", `required checks are not satisfied: ${judged.gaps.join("; ")}`, "Run the current plan's checks on this candidate, or ask the user to approve a revised plan.");
    const { round, ...candidate } = evidence.candidate;
    const result = await integrateCandidate({
      repo: d.repo,
      target: d.target,
      candidate,
      evidence: { requiredChecks: judged.required, checks: judged.accepted, review: { candidate: evidence.review.candidate, blockingFindings: evidence.review.blockingFindings, outcome: evidence.review.outcome } },
      approval: (target) => requireApproval(d.store.state, { task, kind: "integration" }, { artifactHash, candidate, target }),
    });
    if (!result.ok) return result;
    await d.store.setPhase(task, "integrated");
    d.metrics.record("integration", { task, round, outcome: "integrated" });
    return success(result.value);
  }

  /**
   * Cancel an attempt: stop, verify, preserve work; reservation released only
   * if verified. An attempt whose earlier stop was unverified is stopped again
   * (idempotent); without any handle the recorded termination is reported as is.
   */
  async cancel(assignment: string): Promise<Outcome<{ termination: "verified" | "unknown" }>> {
    const a = this.deps.store.state.assignments[assignment];
    if (!a) return refuse("INVALID_TRANSITION", "unknown assignment");
    const last = a.attempts.at(-1);
    let termination: "verified" | "unknown" = !last ? "verified" : last.status === "ended" ? (last.termination ?? "unknown") : "unknown";
    const live = this.handles.get(assignment);
    const retained = this.unresolved.get(assignment);
    if (live) {
      await this.interrupt(live, { code: "INVALID_TRANSITION", message: "cancelled by the user" }, async (t) => {
        termination = t;
        await this.deps.store.endAttempt(assignment, live.handle.identity.attempt, "cancelled", t);
        await this.release(assignment, t);
      });
      termination = (await this.stopOnce(live)).termination;
    } else if (retained) {
      termination = (await this.stopOnce(retained)).termination;
      await this.deps.store.endAttempt(assignment, retained.handle.identity.attempt, "cancelled", termination);
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

  /**
   * Owned execution in this coordinator process: live attempts plus retained
   * attempts whose termination is unknown (they may still be alive). Used for
   * interface counts and to decide that shutdown must not orderly release the
   * watcher (W06/F04).
   */
  liveAssignments(): Array<{ assignment: string; role: Role; retained?: true }> {
    return [
      ...[...this.handles.entries()].map(([assignment, entry]) => ({ assignment, role: entry.handle.identity.role })),
      ...[...this.unresolved.entries()].filter(([assignment]) => !this.handles.has(assignment)).map(([assignment, entry]) => ({ assignment, role: entry.handle.identity.role, retained: true as const })),
    ];
  }

  /** Pause a running attempt at the user's request: stop and verify, preserve work, and block for a later resume decision. */
  async pause(assignment: string, reason: string): Promise<Outcome<{ termination: "verified" | "unknown"; decisionId?: string }>> {
    const entry = this.handles.get(assignment);
    if (!entry) return refuse("INVALID_TRANSITION", "assignment has no live attempt in this coordinator");
    let decisionId: string | undefined;
    await this.interrupt(entry, { code: "QUESTION_OPEN", message: `paused by the user: ${reason}` }, async (termination) => {
      await this.deps.store.endAttempt(assignment, entry.handle.identity.attempt, "paused", termination);
      await this.release(assignment, termination);
      const blocked = await this.deps.store.block(assignment, "user-pause", `Paused by the user: ${reason}. Resume starts a fresh attempt with preserved work.`);
      decisionId = blocked.ok ? Object.values(blocked.value.decisions).filter((x) => x.assignment === assignment && x.status === "open").at(-1)?.id : undefined;
    });
    const stopped = await this.stopOnce(entry);
    return success({ termination: stopped.termination, ...(decisionId ? { decisionId } : {}) });
  }

  /** Content hash helper for approved artifacts (shared with the interface layer). */
  static artifactDigest(content: string): string {
    return hashJson({ content });
  }
}

/**
 * Parse a plan's required-check declarations:
 *
 *   ```radian-checks
 *   unit: ["npm", "test"]
 *   ```
 *
 * One `id: [argv…]` per line (JSON array of non-empty strings); `#` comments
 * and blank lines are ignored. Malformed or duplicate declarations refuse.
 */
export function parseCheckDefinitions(content: string): Outcome<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const lines = content.split(/\r?\n/);
  let inside = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inside) {
      if (trimmed === "```radian-checks") inside = true;
      continue;
    }
    if (trimmed === "```") {
      inside = false;
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z0-9._-]{1,128}):\s*(\[.*\])$/.exec(trimmed);
    let argv: unknown;
    try {
      argv = match ? JSON.parse(match[2]!) : undefined;
    } catch {
      argv = undefined;
    }
    if (!match || !Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string" || a.length === 0)) return refuse("CONFIG_INVALID", "the plan's radian-checks block has a malformed declaration");
    if (out[match[1]!]) return refuse("CONFIG_INVALID", `the plan declares check '${match[1]}' more than once`);
    out[match[1]!] = argv as string[];
  }
  if (inside) return refuse("CONFIG_INVALID", "the plan's radian-checks block is not closed");
  return success(out);
}

function sameArgv(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Render the bounded brief the worker reads: role guidance plus the sealed contract. */
/**
 * A minimal valid `radian.result/1` envelope for this exact assignment and
 * brief revision. Real workers cannot infer identity fields or nested shapes
 * from prose (a live Claude Code run invented them and every result was
 * rejected), so the brief carries this template verbatim.
 */
/** Where an attempt's copy of an approved artifact is delivered (inside its output directory). */
export function approvedCopyPath(outputDir: string, approval: { kind: string; artifact: { path: string } }): string {
  const ext = path.extname(approval.artifact.path) || ".md";
  return path.join(outputDir, "approved", `${approval.kind}${/^\.[A-Za-z0-9]{1,8}$/.test(ext) ? ext : ".md"}`);
}

export function resultTemplate(identity: AssignmentIdentity, briefHash: string, checkIds: readonly string[]): Record<string, unknown> {
  return {
    schema: "radian.result/1",
    identity: { workspace: identity.workspace, project: identity.project, run: identity.run, task: identity.task, assignment: identity.assignment, attempt: identity.attempt, generation: identity.generation, role: identity.role },
    briefHash,
    outcome: "completed",
    summary: "Replace with what you did and what remains.",
    deliverables: [],
    checks: checkIds.map((id) => ({ id, outcome: "not-run", exitCode: null, reason: "Replace with the result of running this check." })),
    findings: [],
    unmetCriteria: [],
    risks: [],
    decisionRequests: [],
    handoff: { dirty: false, incomplete: [], runningServices: [], ownedResources: [] },
    usage: { status: "unknown" },
    modelAttestation: "unverified",
  };
}

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
    `## Approved artifacts (read these first)`,
    ...(b.approvals.length ? [`These are the human-approved documents for this task. They are binding: follow them exactly, and report anything you cannot meet instead of reinterpreting it.`, ...b.approvals.map((a) => `- ${a.kind}: ${approvedCopyPath(b.authority.outputDir, a)} (approved content ${a.artifact.hash.replace(/^sha256:/, "").slice(0, 12)})`)] : ["- (none)"]),
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
    `When finished, blocked, or unable to continue, write \`result.json\` in your output directory (${b.authority.outputDir}). Start from this template: keep \`schema\`, \`identity\`, \`briefHash\`, and \`modelAttestation\` exactly as given, and replace the other values. Use exactly these field names; no other fields are accepted, and a result that does not match is rejected.`,
    "",
    "```json",
    JSON.stringify(resultTemplate(b.identity, sealed.hash, b.requiredChecks.map((c) => c.id)), null, 2),
    "```",
    "",
    `- \`outcome\`: \`completed\`, \`blocked\`, \`failed\`, or \`cancelled\`. \`summary\`: what you did and what remains (required, non-empty).`,
    `- \`deliverables\`: \`{ "path": "<relative path>", "description": "<optional>" }\` for each file you produced or changed.`,
    `- \`checks\`: one entry per required check: \`{ "id": "<check id>", "outcome": "passed" | "failed" | "not-run" | "inconclusive", "exitCode": <number or null>, "reason": "<optional>" }\`. Use \`not-run\` with a reason if you could not run it.`,
    `- \`findings\`: \`{ "severity": "blocker" | "major" | "minor" | "note", "summary": "<text>", "location": "<optional path:line>" }\`. \`unmetCriteria\` and \`risks\`: lists of strings. \`decisionRequests\`: \`{ "question": "<text>", "options": ["<optional>"] }\`.`,
    `- \`handoff\`: \`dirty\` (true if you left uncommitted changes Radian should collect), and string lists \`incomplete\`, \`runningServices\`, \`ownedResources\` (empty when none).`,
    `- \`usage\`: keep \`{ "status": "unknown" }\` unless your runtime reported token counts.`,
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
