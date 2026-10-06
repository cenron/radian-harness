// Worker result envelopes. A result is task data: it can never grant authority
// or approvals. Validation is strict (unknown fields such as `approval` or
// `authority` are rejected), identity must match the current generation, and
// the brief hash must match the brief the worker was given.

import { type Outcome, refuse, success } from "./blockers.ts";
import { type AssignmentIdentity, assignmentIdentitySchema, identityDifferences, sameIdentity } from "./identity.ts";
import { safeRelative } from "./paths.ts";
import { COMMIT, HASH, checkEvidenceSchema, usageSchema } from "./records.ts";
import { type Infer, arr, bool, formatIssues, literal, obj, oneOf, optional, str } from "./schema.ts";

export const RESULT_OUTCOMES = ["completed", "blocked", "failed", "cancelled"] as const;
export type ResultOutcome = (typeof RESULT_OUTCOMES)[number];

export const resultSchema = obj({
  schema: literal("radian.result/1"),
  identity: assignmentIdentitySchema,
  briefHash: str({ pattern: HASH }),
  outcome: oneOf(RESULT_OUTCOMES),
  summary: str({ min: 1, max: 4000 }),
  deliverables: arr(obj({ path: str({ min: 1, max: 512 }), hash: optional(str({ pattern: HASH })), description: optional(str({ max: 500 })) }), { max: 200 }),
  candidate: optional(obj({ commit: optional(str({ pattern: COMMIT })), patch: optional(obj({ path: str({ min: 1, max: 512 }), hash: str({ pattern: HASH }) })) })),
  checks: arr(checkEvidenceSchema, { max: 200 }),
  findings: arr(obj({ severity: oneOf(["blocker", "major", "minor", "note"] as const), summary: str({ min: 1, max: 2000 }), location: optional(str({ max: 512 })) }), { max: 200 }),
  unmetCriteria: arr(str({ min: 1, max: 2000 }), { max: 100 }),
  risks: arr(str({ min: 1, max: 2000 }), { max: 100 }),
  decisionRequests: arr(obj({ question: str({ min: 1, max: 4000 }), options: optional(arr(str({ min: 1, max: 500 }), { max: 10 })) }), { max: 20 }),
  handoff: obj({
    dirty: bool(),
    incomplete: arr(str({ min: 1, max: 2000 }), { max: 100 }),
    runningServices: arr(str({ min: 1, max: 500 }), { max: 50 }),
    ownedResources: arr(str({ min: 1, max: 500 }), { max: 100 }),
  }),
  usage: usageSchema,
  /** Vendor-side model identity is generally not observable; stays unverified unless attested. */
  modelAttestation: oneOf(["unverified", "runtime-reported"] as const),
});

export type WorkerResult = Infer<typeof resultSchema>;

export interface ResultExpectation {
  identity: AssignmentIdentity;
  briefHash: string;
}

export function validateResult(raw: unknown, expected: ResultExpectation): Outcome<WorkerResult> {
  const parsed = resultSchema.parse(raw);
  if (!parsed.ok) return refuse("RESULT_INVALID", `result envelope invalid: ${formatIssues(parsed.issues).slice(0, 1000)}`);
  const result = parsed.value;
  if (!sameIdentity(result.identity, expected.identity)) {
    const fields = identityDifferences(expected.identity, result.identity);
    const stale = fields.includes("generation") || fields.includes("attempt");
    return refuse(stale ? "STALE_GENERATION" : "IDENTITY_MISMATCH", `result identity does not match (${fields.join(", ")})`, "Ignore the result; it belongs to another or superseded assignment.");
  }
  if (result.briefHash !== expected.briefHash) return refuse("IDENTITY_MISMATCH", "result references a different brief revision");
  for (const deliverable of result.deliverables) {
    if (!safeRelative(deliverable.path)) return refuse("RESULT_INVALID", "deliverable paths must be relative and inside the assignment");
  }
  if (result.candidate?.patch && !safeRelative(result.candidate.patch.path)) return refuse("RESULT_INVALID", "patch path must be relative");
  // "completed" means the deliverable was produced, not that it is accepted;
  // unmet criteria and findings remain visible data for coordinator verification.
  return success(result);
}
