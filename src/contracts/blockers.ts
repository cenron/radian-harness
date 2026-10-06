// Structured blockers. Every refusal path returns one of these instead of
// improvising, widening authority, or silently rerouting. Messages are safe to
// display: they never include credentials, raw logs, or private content.

export const BLOCKER_CODES = [
  // configuration and profiles
  "CONFIG_INVALID",
  "PROFILE_UNKNOWN",
  "PROFILE_UNCONFIGURED",
  "PROFILE_NOT_IN_CANDIDATES",
  "PROVIDER_PROVENANCE_UNKNOWN",
  "ANTHROPIC_REQUIRES_CLAUDE_CODE",
  "RUNTIME_PROVIDER_MISMATCH",
  "CUSTOM_ENDPOINT_PROHIBITED",
  "ALIAS_UNRESOLVED",
  "EFFORT_UNSUPPORTED",
  "BILLING_PATH_UNVERIFIED",
  // authority and identity
  "AUTHORITY_INVALID",
  "PATH_OUTSIDE_SCOPE",
  "PATH_INVALID",
  "ROLE_OPERATION_DENIED",
  "IDENTITY_MISMATCH",
  "STALE_GENERATION",
  "RESULT_INVALID",
  "APPROVAL_MISSING",
  "APPROVAL_STALE",
  "APPROVAL_NOT_HUMAN",
  // lifecycle and budgets
  "LEASE_HELD",
  "LEASE_LOST",
  "CAPACITY_FULL",
  "RESERVATION_UNKNOWN_OWNER",
  "ROUNDS_EXHAUSTED",
  "RECOVERY_EXHAUSTED",
  "EXECUTION_BUDGET_EXHAUSTED",
  "INVALID_TRANSITION",
  "DUPLICATE_BINDING",
  "RUN_ACTIVE",
  "CONFIG_CHANGED_FOR_PAUSED_RUN",
  "AMBIGUOUS_ACCOUNTING",
  "QUOTA_EXHAUSTED",
  "QUESTION_OPEN",
  "STATE_CORRUPT",
  "TERMINATION_REQUIRED",
  // git and candidates
  "GIT_FAILURE",
  "TARGET_DIRTY",
  "TARGET_DRIFT",
  "CANDIDATE_MISMATCH",
  "PATCH_BASE_MISMATCH",
  "PATCH_OUT_OF_SCOPE",
  "CONFLICT",
  "OWNERSHIP_AMBIGUOUS",
  "WORK_UNPRESERVED",
  // containment, credentials, supervision
  "CAPABILITY_UNVERIFIED",
  "CAPABILITY_MISSING",
  "CONTAINMENT_UNAVAILABLE",
  "POLICY_TAMPERED",
  "CREDENTIAL_UNAVAILABLE",
  "CREDENTIAL_EXPIRED",
  "CREDENTIAL_REFRESH_OWNERSHIP",
  "CREDENTIAL_EXPOSURE_PROHIBITED",
  "SUPERVISION_UNHEALTHY",
  "TERMINATION_UNVERIFIED",
  "PROCESS_IDENTITY_MISMATCH",
  // runtimes and transport
  "RUNTIME_UNAVAILABLE",
  "RUNTIME_VERSION_UNSUPPORTED",
  "AUTH_REQUIRED",
  "TRUST_PROMPT",
  "TRANSPORT_FAILURE",
  "BINDING_UNCONFIRMED",
  "INFRASTRUCTURE_FAILURE",
  "UNKNOWN_FAILURE",
  // interface and installer
  "MODE_PLAN",
  "NONINTERACTIVE_APPROVAL_REQUIRED",
  "INSTALL_TARGET_INVALID",
  "INSTALL_CONFLICT",
  "LOCAL_MODIFICATION",
  "INTERRUPTED_OPERATION",
  "PREREQUISITE_MISSING",
  // workspace navigation and project selection
  "WORKSPACE_BLOCKED",
  "NO_PROJECT_SELECTED",
  "PROJECT_UNAVAILABLE",
  "CONTEXT_LOCKED",
  "SESSION_BUSY",
  "GIT_IDENTITY_MISSING",
] as const;

export type BlockerCode = (typeof BLOCKER_CODES)[number];

export interface Blocker {
  code: BlockerCode;
  message: string;
  /** What a human can do next, without implying automatic retries or fallback. */
  nextAction?: string;
  details?: Record<string, string | number | boolean | null>;
}

export function blocker(code: BlockerCode, message: string, nextAction?: string, details?: Blocker["details"]): Blocker {
  const out: Blocker = { code, message };
  if (nextAction) out.nextAction = nextAction;
  if (details) out.details = details;
  return out;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; blocker: Blocker };

export function success<T>(value: T): Outcome<T> {
  return { ok: true, value };
}

export function refuse<T = never>(code: BlockerCode, message: string, nextAction?: string, details?: Blocker["details"]): Outcome<T> {
  return { ok: false, blocker: blocker(code, message, nextAction, details) };
}

export class BlockedError extends Error {
  readonly blocker: Blocker;
  constructor(b: Blocker) {
    super(`${b.code}: ${b.message}`);
    this.blocker = b;
  }
}

export function unwrap<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new BlockedError(outcome.blocker);
  return outcome.value;
}
