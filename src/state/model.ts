// Run state model: event envelopes, state shapes, and the pure reducer.
// The reducer never validates authority; it only folds already-accepted events.
// Guarded transitions live in src/state/run-store.ts.

import type { Role } from "../contracts/identity.ts";
import type { ApprovalKind, ApprovalRecord, CandidateRef } from "../contracts/records.ts";
import type { ResultOutcome } from "../contracts/result.ts";

export type RunStatus = "active" | "paused" | "completed" | "cancelled";

export const TASK_PHASES = [
  "spec_draft",
  "awaiting_spec_approval",
  "planning",
  "awaiting_plan_approval",
  "building",
  "verifying",
  "awaiting_integration_approval",
  "integrated",
  "blocked",
  "cancelled",
  "failed",
] as const;
export type TaskPhase = (typeof TASK_PHASES)[number];

export const ASSIGNMENT_STATUSES = [
  "prepared",
  "preflight",
  "running",
  "blocked",
  "interrupted",
  "result-submitted",
  "result-validated",
  "failed",
  "cancelled",
  "retired",
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export type BlockReason = "question" | "quota" | "user-pause" | "supervision" | "other";
export type AttemptEndReason = "completed" | "infrastructure" | "quota" | "cancelled" | "timeout" | "unknown";
export type Termination = "verified" | "unknown";

export interface HarnessProvenance {
  version: string;
  revision: string;
  locallyModified: boolean | "unknown";
}

export interface RunInfo {
  id: string;
  workspace: string;
  project: string;
  createdAt: string;
  status: RunStatus;
  configHash: string;
  harness: HarnessProvenance;
}

export interface TaskState {
  id: string;
  title: string;
  phase: TaskPhase;
  roundsUsed: number;
  maxRounds: number;
  /** Additional rounds explicitly granted by a recorded human decision. */
  humanRoundGrants: Array<{ decisionId: string; rounds: number }>;
  candidates: Array<{ round: number; candidate: CandidateRef }>;
}

export interface AttemptState {
  id: string;
  generation: number;
  status: "launching" | "bound" | "ended";
  startedAt: string;
  boundAt?: string;
  endedAt?: string;
  endReason?: AttemptEndReason;
  termination?: Termination;
  automatic: boolean;
  humanDecisionId?: string;
}

export interface BudgetState {
  limitMs: number;
  consumedMs: number;
  /** Wall-clock ms when execution time started accruing, or null when not accruing. */
  runningSince: number | null;
  blocked: { reason: BlockReason; since: number } | null;
  blockedMs: Record<string, number>;
}

export interface AssignmentState {
  id: string;
  task: string;
  role: Role;
  round: number;
  status: AssignmentStatus;
  generation: number;
  profile: { name: string; runtime: string; provider: string; model: string; effort: string };
  briefHash: string;
  budget: BudgetState;
  attempts: AttemptState[];
  automaticRecoveriesUsed: number;
  maxAutomaticRecoveries: number;
  humanRecoveries: string[];
  result?: { hash: string; outcome: ResultOutcome; validated: boolean };
}

export interface DecisionState {
  id: string;
  kind: "question" | "quota" | "recovery" | "accounting" | "scope" | "other";
  task?: string;
  assignment?: string;
  prompt: string;
  status: "open" | "resolved";
  resolution?: { answer: string; actor: string; at: string };
}

export interface ApprovalState extends ApprovalRecord {
  invalidated?: { at: string; reason: string };
}

export interface RunState {
  schema: "radian.run-state/1";
  run: RunInfo;
  tasks: Record<string, TaskState>;
  assignments: Record<string, AssignmentState>;
  approvals: Record<string, ApprovalState>;
  decisions: Record<string, DecisionState>;
  /** Result hashes already processed, for deduplication. */
  results: Record<string, { assignment: string; accepted: boolean }>;
  idempotencyKeys: Record<string, number>;
  seq: number;
  lastHash: string;
}

export type RunEvent =
  | { type: "run.created"; run: RunInfo }
  | { type: "run.status"; status: RunStatus; configHash?: string; reason?: string }
  | { type: "task.added"; task: { id: string; title: string; maxRounds: number } }
  | { type: "task.phase"; task: string; phase: TaskPhase }
  | { type: "task.round-started"; task: string; round: number }
  | { type: "task.round-grant"; task: string; decisionId: string; rounds: number }
  | { type: "task.candidate"; task: string; round: number; candidate: CandidateRef }
  | { type: "approval.recorded"; approval: ApprovalRecord }
  | { type: "approval.invalidated"; approvalId: string; reason: string }
  | {
      type: "assignment.created";
      assignment: { id: string; task: string; role: Role; round: number; profile: AssignmentState["profile"]; briefHash: string; limitMs: number; maxAutomaticRecoveries: number };
    }
  | { type: "assignment.status"; assignment: string; status: AssignmentStatus }
  | { type: "attempt.started"; assignment: string; attempt: string; generation: number; automatic: boolean; humanDecisionId?: string }
  | { type: "attempt.bound"; assignment: string; attempt: string }
  | { type: "attempt.ended"; assignment: string; attempt: string; reason: AttemptEndReason; termination: Termination }
  | { type: "assignment.blocked"; assignment: string; reason: BlockReason }
  | { type: "assignment.unblocked"; assignment: string }
  | { type: "recovery.authorized"; assignment: string; decisionId: string }
  | { type: "result.recorded"; assignment: string; hash: string; outcome: ResultOutcome; accepted: boolean }
  | { type: "decision.opened"; decision: Omit<DecisionState, "status" | "resolution"> }
  | { type: "decision.resolved"; decisionId: string; answer: string; actor: string };

export interface EventEnvelope {
  seq: number;
  at: string;
  /** Wall-clock milliseconds, used for budget accounting. */
  atMs: number;
  actor: { kind: "coordinator" | "human" | "system"; id: string };
  leaseGeneration: number;
  idempotencyKey?: string;
  event: RunEvent;
  prevHash: string;
  hash: string;
}

export const GENESIS_HASH = "sha256:" + "0".repeat(64);

export function emptyState(): RunState {
  return {
    schema: "radian.run-state/1",
    run: { id: "", workspace: "", project: "", createdAt: "", status: "active", configHash: "", harness: { version: "", revision: "", locallyModified: "unknown" } },
    tasks: {},
    assignments: {},
    approvals: {},
    decisions: {},
    results: {},
    idempotencyKeys: {},
    seq: 0,
    lastHash: GENESIS_HASH,
  };
}

function stopClock(budget: BudgetState, at: number): void {
  if (budget.runningSince !== null) {
    budget.consumedMs += Math.max(0, at - budget.runningSince);
    budget.runningSince = null;
  }
}

function currentAttempt(assignment: AssignmentState): AttemptState | undefined {
  return assignment.attempts[assignment.attempts.length - 1];
}

/** Fold one accepted event into a copy of the state. */
export function reduce(previous: RunState, envelope: EventEnvelope): RunState {
  const state: RunState = structuredClone(previous);
  const at = envelope.atMs;
  const e = envelope.event;
  switch (e.type) {
    case "run.created":
      state.run = { ...e.run };
      break;
    case "run.status":
      state.run.status = e.status;
      if (e.configHash) state.run.configHash = e.configHash;
      break;
    case "task.added":
      state.tasks[e.task.id] = { id: e.task.id, title: e.task.title, phase: "spec_draft", roundsUsed: 0, maxRounds: e.task.maxRounds, humanRoundGrants: [], candidates: [] };
      break;
    case "task.phase":
      state.tasks[e.task]!.phase = e.phase;
      break;
    case "task.round-started":
      state.tasks[e.task]!.roundsUsed = e.round;
      break;
    case "task.round-grant":
      state.tasks[e.task]!.humanRoundGrants.push({ decisionId: e.decisionId, rounds: e.rounds });
      break;
    case "task.candidate":
      state.tasks[e.task]!.candidates.push({ round: e.round, candidate: e.candidate });
      break;
    case "approval.recorded":
      state.approvals[e.approval.id] = { ...e.approval };
      break;
    case "approval.invalidated":
      state.approvals[e.approvalId]!.invalidated = { at: envelope.at, reason: e.reason };
      break;
    case "assignment.created": {
      const a = e.assignment;
      state.assignments[a.id] = {
        id: a.id,
        task: a.task,
        role: a.role,
        round: a.round,
        status: "prepared",
        generation: 0,
        profile: a.profile,
        briefHash: a.briefHash,
        budget: { limitMs: a.limitMs, consumedMs: 0, runningSince: null, blocked: null, blockedMs: {} },
        attempts: [],
        automaticRecoveriesUsed: 0,
        maxAutomaticRecoveries: a.maxAutomaticRecoveries,
        humanRecoveries: [],
      };
      break;
    }
    case "assignment.status":
      state.assignments[e.assignment]!.status = e.status;
      break;
    case "attempt.started": {
      const a = state.assignments[e.assignment]!;
      a.generation = e.generation;
      a.status = "preflight";
      if (a.attempts.length > 0 && e.automatic) a.automaticRecoveriesUsed += 1;
      const attempt: AttemptState = { id: e.attempt, generation: e.generation, status: "launching", startedAt: envelope.at, automatic: e.automatic };
      if (e.humanDecisionId) attempt.humanDecisionId = e.humanDecisionId;
      a.attempts.push(attempt);
      break;
    }
    case "attempt.bound": {
      const a = state.assignments[e.assignment]!;
      const attempt = currentAttempt(a)!;
      attempt.status = "bound";
      attempt.boundAt = envelope.at;
      a.status = "running";
      if (a.budget.blocked === null) a.budget.runningSince = at;
      break;
    }
    case "attempt.ended": {
      const a = state.assignments[e.assignment]!;
      const attempt = a.attempts.find((x) => x.id === e.attempt)!;
      attempt.status = "ended";
      attempt.endedAt = envelope.at;
      attempt.endReason = e.reason;
      attempt.termination = e.termination;
      stopClock(a.budget, at);
      if (e.reason !== "completed" && a.status !== "result-submitted" && a.status !== "result-validated") a.status = e.reason === "cancelled" ? "cancelled" : "interrupted";
      break;
    }
    case "assignment.blocked": {
      const a = state.assignments[e.assignment]!;
      stopClock(a.budget, at);
      a.budget.blocked = { reason: e.reason, since: at };
      a.status = "blocked";
      break;
    }
    case "assignment.unblocked": {
      const a = state.assignments[e.assignment]!;
      if (a.budget.blocked) {
        const reason = a.budget.blocked.reason;
        a.budget.blockedMs[reason] = (a.budget.blockedMs[reason] ?? 0) + Math.max(0, at - a.budget.blocked.since);
        a.budget.blocked = null;
      }
      const attempt = currentAttempt(a);
      if (attempt?.status === "bound") {
        a.budget.runningSince = at;
        a.status = "running";
      } else {
        a.status = attempt ? "interrupted" : "prepared";
      }
      break;
    }
    case "recovery.authorized":
      state.assignments[e.assignment]!.humanRecoveries.push(e.decisionId);
      break;
    case "result.recorded": {
      const a = state.assignments[e.assignment]!;
      a.result = { hash: e.hash, outcome: e.outcome, validated: e.accepted };
      a.status = e.accepted ? "result-validated" : a.status;
      state.results[e.hash] = { assignment: e.assignment, accepted: e.accepted };
      break;
    }
    case "decision.opened":
      state.decisions[e.decision.id] = { ...e.decision, status: "open" };
      break;
    case "decision.resolved": {
      const d = state.decisions[e.decisionId]!;
      d.status = "resolved";
      d.resolution = { answer: e.answer, actor: e.actor, at: envelope.at };
      break;
    }
  }
  state.seq = envelope.seq;
  state.lastHash = envelope.hash;
  if (envelope.idempotencyKey) state.idempotencyKeys[envelope.idempotencyKey] = envelope.seq;
  return state;
}

export function approvalKinds(): readonly ApprovalKind[] {
  return ["spec", "brief", "plan", "integration"];
}
