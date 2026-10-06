// Durable run store: append-only hash-chained events plus a reconstructable
// snapshot, written only while holding the project's coordinator lease. Every
// transition is a guarded command that validates against current durable state;
// worker input reaches state only through validated result recording.

import { readFileSync } from "node:fs";
import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { newId, type AssignmentIdentity, type Role } from "../contracts/identity.ts";
import { type ApprovalKind, type ApprovalRecord, type CandidateRef, approvalRecordSchema } from "../contracts/records.ts";
import { type WorkerResult, validateResult } from "../contracts/result.ts";
import { formatIssues } from "../contracts/schema.ts";
import { hashJson } from "../util/canonical.ts";
import { type Clock, iso, systemClock } from "../util/clock.ts";
import type { IdentityProbe } from "../util/process-identity.ts";
import { HumanChannel, requireApproval } from "./approvals.ts";
import { appendDurable, atomicWrite, atomicWriteJson, ensureDir, readJsonIfExists, withLock } from "./fsutil.ts";
import type { CoordinatorLease } from "./lease.ts";
import {
  type AssignmentState,
  type AttemptEndReason,
  type BlockReason,
  type EventEnvelope,
  GENESIS_HASH,
  type HarnessProvenance,
  type RunEvent,
  type RunState,
  type TaskPhase,
  type Termination,
  emptyState,
  reduce,
} from "./model.ts";

export interface LoadedRun {
  state: RunState;
  /** A partially written final line was quarantined during load. */
  recoveredTail: boolean;
}

function envelopeHash(envelope: Omit<EventEnvelope, "hash">): string {
  return hashJson(envelope);
}

/** Replay a run's event log, verifying the hash chain. A torn final line is quarantined, never guessed. */
export function loadRunDir(runDir: string): Outcome<LoadedRun> {
  const file = path.join(runDir, "events.jsonl");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return success({ state: emptyState(), recoveredTail: false });
    return refuse("STATE_CORRUPT", "run event log is unreadable");
  }
  const lines = text.split("\n");
  let recoveredTail = false;
  if (lines.at(-1) !== "") {
    // The final line has no newline: an interrupted append. Quarantine it.
    const torn = lines.pop() ?? "";
    recoveredTail = torn.length > 0;
  } else {
    lines.pop();
  }
  let state = emptyState();
  for (const [index, line] of lines.entries()) {
    let envelope: EventEnvelope;
    try {
      envelope = JSON.parse(line) as EventEnvelope;
    } catch {
      return refuse("STATE_CORRUPT", `run event ${index + 1} is not valid JSON`, "Preserve the run directory and inspect it; Radian will not guess state.");
    }
    const { hash, ...body } = envelope;
    if (envelope.seq !== state.seq + 1 || envelope.prevHash !== state.lastHash || envelopeHash(body) !== hash) {
      return refuse("STATE_CORRUPT", `run event ${index + 1} breaks the hash chain`, "Preserve the run directory; the event log was altered or reordered.");
    }
    state = reduce(state, envelope);
  }
  return success({ state, recoveredTail });
}

export interface RunStoreOptions {
  clock?: Clock;
  probe?: IdentityProbe;
}

export interface CreateRunInput {
  workspace: string;
  project: string;
  configHash: string;
  harness: HarnessProvenance;
  runId?: string;
}

export interface CurrentArtifacts {
  spec?: string;
  brief?: string;
  plan?: string;
}

export interface CreateAssignmentInput {
  task: string;
  role: Role;
  profile: AssignmentState["profile"];
  briefHash: string;
  limitMs: number;
  maxAutomaticRecoveries: number;
  /** Current hashes of approved artifacts, computed by the coordinator from disk. */
  artifacts: CurrentArtifacts;
  /** Repairs/reviews/tests of an existing candidate stay within the current round. */
  newCandidateRound: boolean;
}

export class RunStore {
  readonly runDir: string;
  private readonly lease: CoordinatorLease;
  private readonly clock: Clock;
  private readonly probe: IdentityProbe | undefined;
  private cached: RunState;

  private constructor(runDir: string, lease: CoordinatorLease, state: RunState, options: RunStoreOptions) {
    this.runDir = runDir;
    this.lease = lease;
    this.cached = state;
    this.clock = options.clock ?? systemClock;
    this.probe = options.probe;
  }

  static runDir(stateDir: string, runId: string): string {
    return path.join(stateDir, "runs", runId);
  }

  static async create(stateDir: string, lease: CoordinatorLease, input: CreateRunInput, options: RunStoreOptions = {}): Promise<Outcome<RunStore>> {
    const runId = input.runId ?? newId("run");
    const runDir = RunStore.runDir(stateDir, runId);
    ensureDir(runDir);
    const loaded = loadRunDir(runDir);
    if (!loaded.ok) return loaded;
    if (loaded.value.state.seq > 0) return refuse("INVALID_TRANSITION", "run already exists");
    const store = new RunStore(runDir, lease, loaded.value.state, options);
    const clock = options.clock ?? systemClock;
    const created = await store.transact({ kind: "coordinator", id: "coordinator" }, undefined, () =>
      success([{ type: "run.created", run: { id: runId, workspace: input.workspace, project: input.project, createdAt: iso(clock.now()), status: "active", configHash: input.configHash, harness: input.harness } }]),
    );
    if (!created.ok) return created;
    return success(store);
  }

  static async open(stateDir: string, runId: string, lease: CoordinatorLease, options: RunStoreOptions = {}): Promise<Outcome<RunStore>> {
    const runDir = RunStore.runDir(stateDir, runId);
    const loaded = loadRunDir(runDir);
    if (!loaded.ok) return loaded;
    if (loaded.value.state.seq === 0) return refuse("INVALID_TRANSITION", "run does not exist");
    if (loaded.value.recoveredTail) {
      // Quarantine the torn tail so the log is well-formed again; keep the bytes as evidence.
      await withLock(path.join(runDir, "lock"), "run log", () => {
        const file = path.join(runDir, "events.jsonl");
        const text = readFileSync(file, "utf8");
        const cut = text.lastIndexOf("\n") + 1;
        atomicWriteJson(path.join(runDir, `torn-tail-${Date.now()}.json`), { bytes: text.slice(cut) });
        atomicWrite(file, text.slice(0, cut));
      }, options.probe ? { probe: options.probe } : {});
    }
    return success(new RunStore(runDir, lease, loaded.value.state, options));
  }

  get state(): RunState {
    return this.cached;
  }

  /**
   * Serialized transition: under the run lock and a live coordinator lease,
   * reload durable state, honour idempotency, compute events from the guard,
   * then append and snapshot.
   */
  async transact(actor: EventEnvelope["actor"], idempotencyKey: string | undefined, guard: (state: RunState) => Outcome<RunEvent[]>): Promise<Outcome<RunState>> {
    return withLock(path.join(this.runDir, "lock"), "run log", () => {
      const held = this.lease.checkHeld();
      if (!held.ok) return held;
      const loaded = loadRunDir(this.runDir);
      if (!loaded.ok) return loaded;
      if (loaded.value.recoveredTail) return refuse("STATE_CORRUPT", "run log has an unrecovered torn tail", "Reopen the run to quarantine it.");
      let state = loaded.value.state;
      if (idempotencyKey && state.idempotencyKeys[idempotencyKey] !== undefined) {
        this.cached = state;
        return success(state);
      }
      const events = guard(state);
      if (!events.ok) {
        this.cached = state;
        return events;
      }
      const atMs = this.clock.now();
      for (const event of events.value) {
        const body: Omit<EventEnvelope, "hash"> = {
          seq: state.seq + 1,
          at: iso(atMs),
          atMs,
          actor,
          leaseGeneration: this.lease.generation,
          event,
          prevHash: state.lastHash,
        };
        if (idempotencyKey) body.idempotencyKey = idempotencyKey;
        const envelope: EventEnvelope = { ...body, hash: envelopeHash(body) };
        appendDurable(path.join(this.runDir, "events.jsonl"), JSON.stringify(envelope));
        state = reduce(state, envelope);
      }
      atomicWriteJson(path.join(this.runDir, "snapshot.json"), state);
      this.cached = state;
      return success(state);
    }, this.probe ? { probe: this.probe } : {});
  }

  // --- Run lifecycle ---------------------------------------------------------

  pause(reason: string): Promise<Outcome<RunState>> {
    return this.transact({ kind: "coordinator", id: "coordinator" }, undefined, (s) =>
      s.run.status === "active" ? success([{ type: "run.status", status: "paused", reason }]) : refuse("INVALID_TRANSITION", `run is ${s.run.status}`),
    );
  }

  /** Resume requires the same effective configuration unless a human approved migration. */
  resume(currentConfigHash: string, migration?: { channel: HumanChannel; decisionId: string }): Promise<Outcome<RunState>> {
    return this.transact({ kind: migration ? "human" : "coordinator", id: migration?.channel.actorId ?? "coordinator" }, undefined, (s) => {
      if (s.run.status !== "paused") return refuse("INVALID_TRANSITION", `run is ${s.run.status}`);
      if (currentConfigHash !== s.run.configHash) {
        if (!migration || !HumanChannel.isGenuine(migration.channel)) {
          return refuse("CONFIG_CHANGED_FOR_PAUSED_RUN", "configuration changed while the run was paused", "Resume with the original configuration, or ask the user to approve migrating the run.");
        }
        return success([{ type: "run.status", status: "active", configHash: currentConfigHash, reason: `migration approved (${migration.decisionId})` }]);
      }
      return success([{ type: "run.status", status: "active" }]);
    });
  }

  // --- Tasks and approvals ---------------------------------------------------

  addTask(title: string, maxRounds: number, taskId = newId("task")): Promise<Outcome<RunState>> {
    return this.transact({ kind: "coordinator", id: "coordinator" }, `task.added:${taskId}`, (s) => {
      if (s.run.status !== "active") return refuse("INVALID_TRANSITION", "run is not active");
      if (maxRounds < 1 || maxRounds > 3) return refuse("CONFIG_INVALID", "task round cap must be between 1 and 3");
      return success([{ type: "task.added", task: { id: taskId, title, maxRounds } }]);
    });
  }

  setPhase(task: string, phase: TaskPhase): Promise<Outcome<RunState>> {
    return this.transact({ kind: "coordinator", id: "coordinator" }, undefined, (s) =>
      s.tasks[task] ? success([{ type: "task.phase", task, phase }]) : refuse("INVALID_TRANSITION", "unknown task"),
    );
  }

  /** The only approval writer. Requires a genuine human channel; model tools and worker input cannot reach it. */
  recordApproval(channel: HumanChannel, approval: Omit<ApprovalRecord, "schema" | "actor" | "channel" | "decidedAt" | "id" | "project" | "run">): Promise<Outcome<RunState>> {
    if (!HumanChannel.isGenuine(channel)) return Promise.resolve(refuse("APPROVAL_NOT_HUMAN", "approvals can only be recorded from explicit user input"));
    const record: ApprovalRecord = {
      ...approval,
      schema: "radian.approval/1",
      id: newId("apr"),
      project: this.cached.run.project,
      run: this.cached.run.id,
      actor: { kind: "human", id: channel.actorId },
      channel: channel.channel,
      decidedAt: iso(this.clock.now()),
    };
    const parsed = approvalRecordSchema.parse(record);
    if (!parsed.ok) return Promise.resolve(refuse("AUTHORITY_INVALID", `approval invalid: ${formatIssues(parsed.issues)}`));
    if (record.kind === "integration" && (!record.candidate || !record.target)) {
      return Promise.resolve(refuse("AUTHORITY_INVALID", "integration approval must bind the exact candidate and target"));
    }
    return this.transact({ kind: "human", id: channel.actorId }, undefined, (s) => {
      if (record.task && !s.tasks[record.task]) return refuse("INVALID_TRANSITION", "unknown task");
      return success([{ type: "approval.recorded", approval: parsed.value }]);
    });
  }

  /** Mark approvals stale when their bound artifact changed (current hashes computed from disk). */
  invalidateChangedApprovals(currentHashes: Record<string, string>): Promise<Outcome<RunState>> {
    return this.transact({ kind: "system", id: "artifact-watch" }, undefined, (s) => {
      const events: RunEvent[] = [];
      for (const approval of Object.values(s.approvals)) {
        if (approval.invalidated || approval.decision !== "approved") continue;
        const current = currentHashes[approval.artifact.path];
        if (current !== undefined && current !== approval.artifact.hash) {
          events.push({ type: "approval.invalidated", approvalId: approval.id, reason: "approved artifact changed" });
        }
      }
      return success(events);
    });
  }

  // --- Rounds and assignments -----------------------------------------------

  private roundCap(state: RunState, task: string): number {
    const t = state.tasks[task]!;
    return t.maxRounds + t.humanRoundGrants.reduce((sum, g) => sum + g.rounds, 0);
  }

  grantRounds(channel: HumanChannel, task: string, rounds: number, decisionId: string): Promise<Outcome<RunState>> {
    if (!HumanChannel.isGenuine(channel)) return Promise.resolve(refuse("APPROVAL_NOT_HUMAN", "additional rounds require an explicit human decision"));
    return this.transact({ kind: "human", id: channel.actorId }, `round-grant:${decisionId}`, (s) => {
      if (!s.tasks[task]) return refuse("INVALID_TRANSITION", "unknown task");
      if (!Number.isInteger(rounds) || rounds < 1 || rounds > 3) return refuse("CONFIG_INVALID", "grant 1–3 rounds per decision");
      return success([{ type: "task.round-grant", task, decisionId, rounds }]);
    });
  }

  createAssignment(input: CreateAssignmentInput, assignmentId = newId("asg")): Promise<Outcome<RunState>> {
    return this.transact({ kind: "coordinator", id: "coordinator" }, `assignment.created:${assignmentId}`, (s) => {
      if (s.run.status !== "active") return refuse("INVALID_TRANSITION", "run is not active");
      const task = s.tasks[input.task];
      if (!task) return refuse("INVALID_TRANSITION", "unknown task");
      if (["integrated", "cancelled", "failed"].includes(task.phase)) return refuse("INVALID_TRANSITION", `task is ${task.phase}`);
      if (input.role === "developer" || input.role === "tester") {
        const behaviour = input.artifacts.spec !== undefined
          ? requireApproval(s, { task: input.task, kind: "spec" }, { artifactHash: input.artifacts.spec })
          : input.artifacts.brief !== undefined
            ? requireApproval(s, { task: input.task, kind: "brief" }, { artifactHash: input.artifacts.brief })
            : refuse("APPROVAL_MISSING", "an approved spec or lightweight brief is required");
        if (!behaviour.ok) return behaviour;
        if (input.artifacts.plan === undefined) return refuse("APPROVAL_MISSING", "an approved plan is required");
        const plan = requireApproval(s, { task: input.task, kind: "plan" }, { artifactHash: input.artifacts.plan });
        if (!plan.ok) return plan;
      }
      if (input.role === "reviewer" && task.candidates.length === 0) return refuse("CANDIDATE_MISMATCH", "review requires an assembled candidate");
      const events: RunEvent[] = [];
      let round = Math.max(task.roundsUsed, 1);
      if (input.newCandidateRound) {
        if (task.roundsUsed >= this.roundCap(s, input.task)) {
          return refuse("ROUNDS_EXHAUSTED", `task used all ${this.roundCap(s, input.task)} candidate rounds`, "Present remaining findings and preserved work to the user; only a human decision can grant more rounds.");
        }
        round = task.roundsUsed + 1;
        events.push({ type: "task.round-started", task: input.task, round });
      } else if (task.roundsUsed === 0 && input.role !== "scout") {
        return refuse("AMBIGUOUS_ACCOUNTING", "no candidate round has started for this task");
      }
      if (input.limitMs <= 0) return refuse("EXECUTION_BUDGET_EXHAUSTED", "assignment has no execution budget");
      events.push({
        type: "assignment.created",
        assignment: { id: assignmentId, task: input.task, role: input.role, round, profile: input.profile, briefHash: input.briefHash, limitMs: input.limitMs, maxAutomaticRecoveries: input.maxAutomaticRecoveries },
      });
      return success(events);
    });
  }

  recordCandidate(task: string, candidate: CandidateRef): Promise<Outcome<RunState>> {
    return this.transact({ kind: "coordinator", id: "coordinator" }, `candidate:${task}:${candidate.commit}`, (s) => {
      const t = s.tasks[task];
      if (!t) return refuse("INVALID_TRANSITION", "unknown task");
      if (t.roundsUsed === 0) return refuse("AMBIGUOUS_ACCOUNTING", "candidate recorded outside a round");
      return success([{ type: "task.candidate", task, round: t.roundsUsed, candidate }]);
    });
  }

  /**
   * Classify a failed candidate cycle. Candidate defects already consumed their
   * round; infrastructure evidence failures do not add a hidden extra round;
   * ambiguous classifications open a human decision rather than guessing.
   */
  classifyFailure(task: string, classification: "candidate-defect" | "infrastructure" | "ambiguous", detail: string): Promise<Outcome<RunState>> {
    return this.transact({ kind: "coordinator", id: "coordinator" }, undefined, (s) => {
      if (!s.tasks[task]) return refuse("INVALID_TRANSITION", "unknown task");
      if (classification === "ambiguous") {
        return success([{ type: "decision.opened", decision: { id: newId("dec"), kind: "accounting", task, prompt: `Classify failure for round accounting: ${detail}` } }]);
      }
      return success([]);
    });
  }

  // --- Attempts, binding, budgets, recovery --------------------------------

  /**
   * Start a fresh attempt (new generation). Replacing a previous attempt
   * requires its termination to be verified, remaining execution budget, and
   * either the one automatic recovery or a recorded human authorization.
   */
  startAttempt(assignment: string, options: { humanDecisionId?: string; resumeDecisionId?: string } = {}): Promise<Outcome<RunState>> {
    const attemptId = newId("att");
    return this.transact({ kind: "coordinator", id: "coordinator" }, `attempt:${attemptId}`, (s) => {
      if (s.run.status !== "active") return refuse("INVALID_TRANSITION", "run is not active");
      const a = s.assignments[assignment];
      if (!a) return refuse("INVALID_TRANSITION", "unknown assignment");
      if (["retired", "cancelled", "failed", "result-validated"].includes(a.status)) return refuse("INVALID_TRANSITION", `assignment is ${a.status}`);
      if (a.budget.blocked) return refuse("QUESTION_OPEN", "assignment is blocked", "Resolve the blocking decision first.");
      const previous = a.attempts.at(-1);
      let automatic = false;
      let humanDecisionId: string | undefined;
      if (previous) {
        if (previous.status !== "ended") return refuse("TERMINATION_REQUIRED", "the previous attempt has not ended", "Stop and verify the previous attempt before replacing it.");
        if (previous.termination !== "verified") return refuse("TERMINATION_UNVERIFIED", "the previous attempt's termination is unverified", "Reconcile owned processes before any replacement.");
        if (options.resumeDecisionId) {
          // Resuming after an answered question or a user pause is a fresh attempt, not an infrastructure recovery.
          const decision = s.decisions[options.resumeDecisionId];
          if (!decision || decision.assignment !== assignment || decision.status !== "resolved" || !["question", "other"].includes(decision.kind)) {
            return refuse("QUESTION_OPEN", "resume requires a resolved question or pause decision for this assignment");
          }
          if (a.attempts.some((x) => x.humanDecisionId === options.resumeDecisionId)) return refuse("INVALID_TRANSITION", "that decision already resumed this assignment");
          humanDecisionId = options.resumeDecisionId;
        } else if (options.humanDecisionId) {
          if (!a.humanRecoveries.includes(options.humanDecisionId)) return refuse("RECOVERY_EXHAUSTED", "human recovery decision is not recorded for this assignment");
          if (a.attempts.some((x) => x.humanDecisionId === options.humanDecisionId)) return refuse("RECOVERY_EXHAUSTED", "human recovery decision was already used");
          humanDecisionId = options.humanDecisionId;
        } else if (a.automaticRecoveriesUsed < a.maxAutomaticRecoveries) {
          automatic = true;
        } else {
          return refuse("RECOVERY_EXHAUSTED", "the automatic recovery for this assignment is used", "Ask the user whether to authorize another attempt.");
        }
      }
      if (a.budget.consumedMs >= a.budget.limitMs) return refuse("EXECUTION_BUDGET_EXHAUSTED", "no execution time remains", "Ask the user for a decision; budgets are never extended silently.");
      const event: RunEvent = { type: "attempt.started", assignment, attempt: attemptId, generation: a.generation + 1, automatic };
      if (humanDecisionId) event.humanDecisionId = humanDecisionId;
      return success([event]);
    });
  }

  /** Record the sealed brief delivered to the current attempt, before launch. */
  recordAttemptBrief(assignment: string, attempt: string, briefHash: string): Promise<Outcome<RunState>> {
    return this.transact({ kind: "coordinator", id: "coordinator" }, `brief:${attempt}`, (s) => {
      const current = s.assignments[assignment]?.attempts.at(-1);
      if (!current || current.id !== attempt) return refuse("STALE_GENERATION", "brief does not belong to the current attempt");
      if (current.status !== "launching" || current.briefHash) return refuse("INVALID_TRANSITION", "attempt brief is already fixed");
      if (!/^sha256:[0-9a-f]{64}$/.test(briefHash)) return refuse("AUTHORITY_INVALID", "brief hash is malformed");
      return success([{ type: "attempt.brief", assignment, attempt, briefHash }]);
    });
  }

  /** Semantic assignment binding confirmed by the adapter; execution time starts accruing here. */
  bindAttempt(identity: AssignmentIdentity): Promise<Outcome<RunState>> {
    // No idempotency key: a replayed binding must still be checked against the current generation.
    return this.transact({ kind: "coordinator", id: "coordinator" }, undefined, (s) => {
      const a = s.assignments[identity.assignment];
      const attempt = a?.attempts.at(-1);
      if (!a || !attempt || attempt.id !== identity.attempt || attempt.generation !== identity.generation) {
        return refuse("STALE_GENERATION", "binding does not match the current attempt");
      }
      if (attempt.status === "bound") return success([]);
      if (attempt.status !== "launching") return refuse("INVALID_TRANSITION", `attempt is ${attempt.status}`);
      return success([{ type: "attempt.bound", assignment: a.id, attempt: attempt.id }]);
    });
  }

  endAttempt(assignment: string, attempt: string, reason: AttemptEndReason, termination: Termination): Promise<Outcome<RunState>> {
    return this.transact({ kind: "coordinator", id: "coordinator" }, `end:${attempt}:${termination}`, (s) => {
      const a = s.assignments[assignment];
      const found = a?.attempts.find((x) => x.id === attempt);
      if (!a || !found) return refuse("INVALID_TRANSITION", "unknown attempt");
      if (found.status === "ended" && found.termination === "verified") return refuse("INVALID_TRANSITION", "attempt already ended");
      return success([{ type: "attempt.ended", assignment, attempt, reason, termination }]);
    });
  }

  block(assignment: string, reason: BlockReason, prompt: string): Promise<Outcome<RunState>> {
    return this.transact({ kind: "coordinator", id: "coordinator" }, undefined, (s) => {
      const a = s.assignments[assignment];
      if (!a) return refuse("INVALID_TRANSITION", "unknown assignment");
      if (a.budget.blocked) return refuse("INVALID_TRANSITION", "assignment already blocked");
      return success([
        { type: "assignment.blocked", assignment, reason },
        { type: "decision.opened", decision: { id: newId("dec"), kind: reason === "quota" ? "quota" : reason === "question" ? "question" : "other", task: a.task, assignment, prompt } },
      ]);
    });
  }

  /** Resolve a durable decision; only a human may resolve it. Unblocks its assignment if no other decision is open. */
  resolveDecision(channel: HumanChannel, decisionId: string, answer: string): Promise<Outcome<RunState>> {
    if (!HumanChannel.isGenuine(channel)) return Promise.resolve(refuse("APPROVAL_NOT_HUMAN", "decisions are resolved only by explicit user input"));
    return this.transact({ kind: "human", id: channel.actorId }, `resolve:${decisionId}`, (s) => {
      const d = s.decisions[decisionId];
      if (!d) return refuse("INVALID_TRANSITION", "unknown decision");
      if (d.status !== "open") return refuse("INVALID_TRANSITION", "decision already resolved");
      const events: RunEvent[] = [{ type: "decision.resolved", decisionId, answer, actor: channel.actorId }];
      if (d.assignment) {
        const others = Object.values(s.decisions).filter((x) => x.id !== decisionId && x.status === "open" && x.assignment === d.assignment);
        if (others.length === 0 && s.assignments[d.assignment]?.budget.blocked) events.push({ type: "assignment.unblocked", assignment: d.assignment });
      }
      return success(events);
    });
  }

  authorizeRecovery(channel: HumanChannel, assignment: string, decisionId: string): Promise<Outcome<RunState>> {
    if (!HumanChannel.isGenuine(channel)) return Promise.resolve(refuse("APPROVAL_NOT_HUMAN", "additional recovery attempts require explicit user authorization"));
    return this.transact({ kind: "human", id: channel.actorId }, `recovery:${decisionId}`, (s) =>
      s.assignments[assignment] ? success([{ type: "recovery.authorized", assignment, decisionId }]) : refuse("INVALID_TRANSITION", "unknown assignment"),
    );
  }

  remainingMs(assignment: string): number {
    const a = this.cached.assignments[assignment];
    if (!a) return 0;
    const running = a.budget.runningSince === null ? 0 : Math.max(0, this.clock.now() - a.budget.runningSince);
    return Math.max(0, a.budget.limitMs - a.budget.consumedMs - running);
  }

  // --- Results ---------------------------------------------------------------

  /**
   * Record a worker result after validating identity, generation, and brief hash.
   * Duplicates are idempotent; stale or spoofed results are recorded as rejected
   * data only when they match a known assignment, never as state promotion.
   */
  recordResult(raw: unknown, expected: { identity: AssignmentIdentity; briefHash: string }): Promise<Outcome<WorkerResult>> {
    const hash = hashJson(raw);
    let accepted: WorkerResult | undefined;
    return this.transact({ kind: "coordinator", id: "result-inbox" }, `result:${hash}`, (s) => {
      const a = s.assignments[expected.identity.assignment];
      if (!a) return refuse("IDENTITY_MISMATCH", "result for an unknown assignment");
      const current = a.attempts.at(-1);
      if (!current || current.id !== expected.identity.attempt || current.generation !== expected.identity.generation) {
        return refuse("STALE_GENERATION", "result expectation is not the current attempt");
      }
      if (expected.briefHash !== (current.briefHash ?? a.briefHash)) return refuse("IDENTITY_MISMATCH", "brief hash differs from the brief delivered to this attempt");
      const validated = validateResult(raw, expected);
      if (!validated.ok) return validated;
      accepted = validated.value;
      return success([{ type: "result.recorded", assignment: a.id, hash, outcome: validated.value.outcome, accepted: true }]);
    }).then((outcome) => {
      if (!outcome.ok) return outcome;
      if (accepted) return success(accepted);
      // Idempotent replay of an already-recorded result: re-validate to return it.
      const again = validateResult(raw, expected);
      return again;
    });
  }

  retire(assignment: string): Promise<Outcome<RunState>> {
    return this.transact({ kind: "coordinator", id: "coordinator" }, `retire:${assignment}`, (s) => {
      const a = s.assignments[assignment];
      if (!a) return refuse("INVALID_TRANSITION", "unknown assignment");
      const last = a.attempts.at(-1);
      if (last && (last.status !== "ended" || last.termination !== "verified")) {
        return refuse("TERMINATION_UNVERIFIED", "cannot retire before verified termination of the last attempt");
      }
      return success([{ type: "assignment.status", assignment, status: "retired" }]);
    });
  }

  cancelAssignment(assignment: string): Promise<Outcome<RunState>> {
    return this.transact({ kind: "coordinator", id: "coordinator" }, undefined, (s) =>
      s.assignments[assignment] ? success([{ type: "assignment.status", assignment, status: "cancelled" }]) : refuse("INVALID_TRANSITION", "unknown assignment"),
    );
  }
}

export function snapshotMatchesLog(runDir: string): boolean {
  const snapshot = readJsonIfExists(path.join(runDir, "snapshot.json"));
  const loaded = loadRunDir(runDir);
  if (snapshot.state !== "ok" || !loaded.ok) return false;
  const snap = snapshot.value as RunState;
  return snap.seq === loaded.value.state.seq && snap.lastHash === loaded.value.state.lastHash;
}

export function approvalKindsFor(role: Role): ApprovalKind[] {
  return role === "developer" || role === "tester" ? ["spec", "plan"] : [];
}

export { GENESIS_HASH };
