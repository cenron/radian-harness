// Human approval authority. Only an explicit user-initiated command or UI
// control may construct a HumanChannel; the coordinator's model-callable tools,
// worker results, and assistant text have no way to produce one. Approvals bind
// to artifact hashes (and, for integration, to exact candidate and target
// revisions); a changed artifact makes the approval stale until a human decides.

import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import type { ApprovalKind, ApprovalRecord, CandidateRef, TargetRef } from "../contracts/records.ts";
import type { ApprovalState, RunState } from "./model.ts";

const issued = new WeakSet<HumanChannel>();

export class HumanChannel {
  readonly channel: "user-command" | "user-ui";
  readonly actorId: string;
  readonly origin: string;

  private constructor(channel: "user-command" | "user-ui", actorId: string, origin: string) {
    this.channel = channel;
    this.actorId = actorId;
    this.origin = origin;
  }

  /**
   * Called only by a registered user command/UI handler while processing the
   * user's own input. `origin` names the command for the audit trail.
   */
  static fromUserInput(channel: "user-command" | "user-ui", actorId: string, origin: string): HumanChannel {
    if (!/^[A-Za-z0-9._@-]{1,128}$/.test(actorId)) throw new Error("invalid human actor id");
    const instance = new HumanChannel(channel, actorId, origin);
    issued.add(instance);
    return instance;
  }

  static isGenuine(value: unknown): value is HumanChannel {
    return value instanceof HumanChannel && issued.has(value);
  }
}

export type ApprovalValidity =
  | { state: "valid"; approval: ApprovalState }
  | { state: "missing" }
  | { state: "rejected"; approval: ApprovalState }
  | { state: "stale"; approval: ApprovalState; reason: string };

export interface ApprovalScope {
  task?: string;
  kind: ApprovalKind;
}

function latest(state: RunState, scope: ApprovalScope): ApprovalState | undefined {
  const matching = Object.values(state.approvals).filter((a) => a.kind === scope.kind && (scope.task === undefined ? a.task === undefined : a.task === scope.task));
  return matching.sort((a, b) => a.decidedAt.localeCompare(b.decidedAt)).at(-1);
}

/** Check an approval against the artifact's current hash (and candidate/target for integration). */
export function approvalValidity(
  state: RunState,
  scope: ApprovalScope,
  current: { artifactHash: string; candidate?: CandidateRef; target?: TargetRef },
): ApprovalValidity {
  const approval = latest(state, scope);
  if (!approval) return { state: "missing" };
  if (approval.decision === "rejected") return { state: "rejected", approval };
  if (approval.invalidated) return { state: "stale", approval, reason: approval.invalidated.reason };
  if (approval.artifact.hash !== current.artifactHash) return { state: "stale", approval, reason: "approved artifact changed" };
  if (scope.kind === "integration") {
    if (!approval.candidate || !current.candidate || approval.candidate.commit !== current.candidate.commit || approval.candidate.tree !== current.candidate.tree || approval.candidate.base !== current.candidate.base) {
      return { state: "stale", approval, reason: "candidate changed since integration approval" };
    }
    if (!approval.target || !current.target || approval.target.ref !== current.target.ref || approval.target.commit !== current.target.commit) {
      return { state: "stale", approval, reason: "target changed since integration approval" };
    }
  }
  return { state: "valid", approval };
}

export function requireApproval(
  state: RunState,
  scope: ApprovalScope,
  current: { artifactHash: string; candidate?: CandidateRef; target?: TargetRef },
): Outcome<ApprovalRecord> {
  const validity = approvalValidity(state, scope, current);
  switch (validity.state) {
    case "valid":
      return success(validity.approval);
    case "missing":
      return refuse("APPROVAL_MISSING", `${scope.kind} approval is required`, "Ask the user to review and approve through a Radian command.");
    case "rejected":
      return refuse("APPROVAL_MISSING", `${scope.kind} was rejected by the user`, "Revise the artifact and request a new decision.");
    case "stale":
      return refuse("APPROVAL_STALE", `${scope.kind} approval is stale: ${validity.reason}`, "Ask the user to review the changed artifact and approve again.");
  }
}
