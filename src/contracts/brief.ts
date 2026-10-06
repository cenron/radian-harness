// Assignment briefs: the bounded, durable input each fresh worker receives.
// A brief binds approved artifact revisions, the exact starting candidate/base,
// resolved authority, resolved profile, the round, remaining budgets, and the
// generation identity. Its hash is recorded so results can be correlated.

import { type Outcome, refuse, success } from "./blockers.ts";
import { assignmentIdentitySchema, type AssignmentIdentity } from "./identity.ts";
import { resolvedAuthoritySchema, type ResolvedAuthority, verifyAuthorityHash } from "./authority.ts";
import { APPROVAL_KINDS, COMMIT, HASH, artifactRefSchema } from "./records.ts";
import { type Infer, arr, formatIssues, literal, num, obj, oneOf, optional, str } from "./schema.ts";
import { RUNTIMES } from "./identity.ts";
import { deepFreeze, hashJson } from "../util/canonical.ts";

export const requiredCheckSchema = obj({
  id: str({ pattern: /^[a-z0-9][a-z0-9._-]{0,63}$/ }),
  description: str({ min: 1, max: 500 }),
  /** Argument vector run inside the contained assignment; never a shell string. */
  argv: arr(str({ min: 1, max: 4096 }), { min: 1, max: 256 }),
  cwd: optional(str({ max: 512 })),
});

export const briefSchema = obj({
  schema: literal("radian.brief/1"),
  identity: assignmentIdentitySchema,
  round: obj({ current: num({ int: true, min: 1, max: 3 }), max: num({ int: true, min: 1, max: 3 }) }),
  objective: str({ min: 1, max: 8000 }),
  nonGoals: arr(str({ min: 1, max: 2000 }), { max: 50 }),
  acceptanceCriteria: arr(str({ min: 1, max: 2000 }), { max: 100 }),
  approvals: arr(obj({ kind: oneOf(APPROVAL_KINDS), approvalId: str({ min: 1 }), artifact: artifactRefSchema }), { min: 1 }),
  base: obj({
    commit: str({ pattern: COMMIT }),
    /** Candidate being repaired/tested/reviewed, when not starting from the base. */
    candidate: optional(str({ pattern: COMMIT })),
    checkout: str({ min: 1 }),
  }),
  authority: resolvedAuthoritySchema,
  profile: obj({
    name: str({ min: 1 }),
    runtime: oneOf(RUNTIMES),
    provider: str({ min: 1 }),
    model: str({ min: 1 }),
    effort: str({ min: 1 }),
    selection: oneOf(["user-override", "plan-assignment", "rule", "default"] as const),
    ruleId: optional(str({ min: 1 })),
  }),
  deliverables: arr(str({ min: 1, max: 2000 }), { max: 50 }),
  requiredChecks: arr(requiredCheckSchema, { max: 50 }),
  budget: obj({
    executionMsRemaining: num({ int: true, min: 0 }),
    automaticRecoveriesRemaining: num({ int: true, min: 0, max: 1 }),
  }),
  /** Findings, decisions, and artifact references for repairs/reviews; no transcripts. */
  context: arr(obj({ label: str({ min: 1, max: 200 }), ref: optional(artifactRefSchema), text: optional(str({ max: 8000 })) }), { max: 50 }),
  decisionRoute: literal("coordinator"),
  configSnapshot: str({ pattern: HASH }),
});

export type Brief = Infer<typeof briefSchema>;

export interface SealedBrief {
  brief: Brief;
  hash: string;
}

export function sealBrief(input: unknown): Outcome<SealedBrief> {
  const parsed = briefSchema.parse(input);
  if (!parsed.ok) return refuse("AUTHORITY_INVALID", `brief invalid: ${formatIssues(parsed.issues)}`);
  const brief = parsed.value;
  if (brief.round.current > brief.round.max) return refuse("ROUNDS_EXHAUSTED", "brief round exceeds the round cap");
  if (brief.identity.role !== brief.authority.role) return refuse("AUTHORITY_INVALID", "brief role and authority role differ");
  if (!verifyAuthorityHash(brief.authority as ResolvedAuthority)) return refuse("AUTHORITY_INVALID", "authority record hash does not match its content");
  return success(deepFreeze({ brief, hash: hashJson(brief) }));
}

export function briefIdentity(sealed: SealedBrief): AssignmentIdentity {
  return sealed.brief.identity;
}
