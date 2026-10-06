// Durable record schemas shared by state, Git, and orchestration services:
// approvals, candidate identity, check evidence, and owned resources.

import { ROLES } from "./identity.ts";
import { type Infer, arr, literal, nullable, num, obj, oneOf, optional, str, union } from "./schema.ts";

export const HASH = /^sha256:[0-9a-f]{64}$/;
export const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export const APPROVAL_KINDS = ["spec", "brief", "plan", "integration"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** Artifact identity bound by an approval: a repository-relative path plus content hash. */
export const artifactRefSchema = obj({
  path: str({ min: 1, max: 512 }),
  hash: str({ pattern: HASH }),
});
export type ArtifactRef = Infer<typeof artifactRefSchema>;

export const candidateRefSchema = obj({
  commit: str({ pattern: COMMIT }),
  tree: str({ pattern: COMMIT }),
  base: str({ pattern: COMMIT }),
});
export type CandidateRef = Infer<typeof candidateRefSchema>;

export const targetRefSchema = obj({
  ref: str({ pattern: /^refs\/heads\/[A-Za-z0-9._/-]+$/ }),
  commit: str({ pattern: COMMIT }),
});
export type TargetRef = Infer<typeof targetRefSchema>;

/**
 * Approval records are written only through explicit human controls. The actor
 * must be human and the channel a user-initiated command; worker reports and
 * assistant text are never accepted as approval channels.
 */
export const approvalRecordSchema = obj({
  schema: literal("radian.approval/1"),
  id: str({ min: 1 }),
  kind: oneOf(APPROVAL_KINDS),
  project: str({ min: 1 }),
  run: str({ min: 1 }),
  task: optional(str({ min: 1 })),
  artifact: artifactRefSchema,
  /** Integration approvals additionally bind the exact candidate and target revision. */
  candidate: optional(candidateRefSchema),
  target: optional(targetRefSchema),
  /** Lightweight brief path chosen by the human, recorded explicitly. */
  lightweight: optional(literal(true)),
  actor: obj({ kind: literal("human"), id: str({ min: 1, max: 128 }) }),
  channel: oneOf(["user-command", "user-ui"] as const),
  decision: oneOf(["approved", "rejected"] as const),
  reason: optional(str({ max: 2000 })),
  decidedAt: str({ min: 1 }),
});
export type ApprovalRecord = Infer<typeof approvalRecordSchema>;

export const CHECK_OUTCOMES = ["passed", "failed", "not-run", "inconclusive"] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

export const checkEvidenceSchema = obj({
  id: str({ min: 1, max: 128 }),
  outcome: oneOf(CHECK_OUTCOMES),
  /** Exact candidate revision the check ran against. */
  candidate: optional(str({ pattern: COMMIT })),
  argv: optional(arr(str({ max: 4096 }), { max: 256 })),
  exitCode: optional(nullable(num({ int: true }))),
  reason: optional(str({ max: 2000 })),
  log: optional(artifactRefSchema),
  startedAt: optional(str({ min: 1 })),
  finishedAt: optional(str({ min: 1 })),
});
export type CheckEvidence = Infer<typeof checkEvidenceSchema>;

export const RESOURCE_KINDS = ["process", "pane", "worktree", "branch", "port", "service", "credential-projection", "scratch", "output"] as const;

export const ownedResourceSchema = obj({
  kind: oneOf(RESOURCE_KINDS),
  id: str({ min: 1, max: 512 }),
  assignment: str({ min: 1 }),
  attempt: str({ min: 1 }),
  generation: num({ int: true, min: 1 }),
  role: optional(oneOf(ROLES)),
  /** Identity evidence used before any signal or deletion (e.g. process start time). */
  identity: optional(str({ max: 512 })),
  createdAt: str({ min: 1 }),
  state: oneOf(["active", "retired", "unknown"] as const),
});
export type OwnedResource = Infer<typeof ownedResourceSchema>;

export const usageSchema = union([
  obj({ status: literal("unknown") }),
  obj({
    status: literal("reported"),
    source: str({ min: 1, max: 128 }),
    inputTokens: optional(num({ int: true, min: 0 })),
    outputTokens: optional(num({ int: true, min: 0 })),
  }),
] as const);
export type Usage = Infer<typeof usageSchema>;
