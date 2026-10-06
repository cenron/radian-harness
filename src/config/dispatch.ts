// Dispatch configuration: named runtime/model/effort profiles and auditable
// task-routing rules. Rule `use` arrays are candidate sets for the coordinator
// to choose from, never automatic fallback chains. Selection records the source,
// rule, and rationale; a rejected selection returns a blocker and is not
// replaced by another candidate.

import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { ROLES, RUNTIMES, type Role } from "../contracts/identity.ts";
import { type Infer, type Issue, arr, literal, nullable, obj, oneOf, optional, record, refine, str } from "../contracts/schema.ts";
import { type AliasTarget, PROHIBITED_PROFILE_FIELDS, type ResolvedProfile, evaluateProfile } from "./provider-policy.ts";

const NAME = /^[a-z][a-z0-9-]{0,63}$/;

export const profileSchema = obj({
  runtime: oneOf(RUNTIMES),
  provider: nullable(str({ min: 1, max: 64 })),
  model: nullable(str({ min: 1, max: 128 })),
  effort: str({ min: 1, max: 16 }),
  description: optional(str({ max: 400 })),
});

export const ruleSchema = obj({
  id: str({ pattern: NAME }),
  roles: arr(oneOf(ROLES), { min: 1, unique: true }),
  when: str({ min: 1, max: 1000 }),
  use: arr(str({ pattern: NAME }), { min: 1, unique: true }),
  why: str({ min: 1, max: 1000 }),
});

export const dispatchConfigSchema = refine(
  obj({
    version: literal(1),
    default: str({ pattern: NAME }),
    profiles: record(profileSchema, NAME),
    aliases: record(obj({ provider: optional(str({ min: 1, max: 64 })), model: str({ min: 1, max: 128 }) }), NAME),
    rules: arr(ruleSchema),
    selection: obj({
      strategy: literal("coordinator"),
      /** Unavailable or rejected profiles block; there is no automatic fallback. */
      onUnavailable: literal("block"),
    }),
  }),
  (config) => {
    const issues: Issue[] = [];
    if (!(config.default in config.profiles)) issues.push({ path: "$.default", message: "names an undefined profile" });
    const ruleIds = new Set<string>();
    config.rules.forEach((rule, index) => {
      if (ruleIds.has(rule.id)) issues.push({ path: `$.rules[${index}].id`, message: "duplicate rule id" });
      ruleIds.add(rule.id);
      rule.use.forEach((name, j) => {
        if (!(name in config.profiles)) issues.push({ path: `$.rules[${index}].use[${j}]`, message: "names an undefined profile" });
      });
    });
    return issues;
  },
);

export type DispatchConfig = Infer<typeof dispatchConfigSchema>;
export type Profile = Infer<typeof profileSchema>;

/**
 * Inspect raw (pre-schema) profile objects for endpoint/credential fields so the
 * refusal is specific rather than a generic unknown-field error.
 */
export function rawProhibitedFields(raw: unknown): Array<{ profile: string; fields: string[] }> {
  const out: Array<{ profile: string; fields: string[] }> = [];
  if (typeof raw !== "object" || raw === null) return out;
  const profiles = (raw as Record<string, unknown>).profiles;
  if (typeof profiles !== "object" || profiles === null) return out;
  for (const [name, value] of Object.entries(profiles)) {
    if (typeof value !== "object" || value === null) continue;
    const fields = PROHIBITED_PROFILE_FIELDS.filter((field) => field in (value as Record<string, unknown>));
    if (fields.length > 0) out.push({ profile: name, fields });
  }
  return out;
}

export type SelectionSource = "user-override" | "plan-assignment" | "rule" | "default";

export interface SelectionRequest {
  role: Role;
  /** Explicit human task override; must name a configured profile. */
  userOverride?: { profile: string; decisionId: string };
  /** Profile assigned in the approved plan. */
  planAssignment?: { profile: string; planRevision: string };
  /** Coordinator choice among a rule's candidates, with rationale. */
  rule?: { id: string; profile: string; rationale: string };
}

export interface ProfileSelection {
  source: SelectionSource;
  ruleId?: string;
  rationale: string;
  reference?: string;
  profile: ResolvedProfile;
}

export function selectProfile(config: DispatchConfig, request: SelectionRequest): Outcome<ProfileSelection> {
  let name: string;
  let source: SelectionSource;
  let rationale: string;
  let ruleId: string | undefined;
  let reference: string | undefined;

  if (request.userOverride) {
    name = request.userOverride.profile;
    source = "user-override";
    rationale = "explicit user task override";
    reference = request.userOverride.decisionId;
  } else if (request.planAssignment) {
    name = request.planAssignment.profile;
    source = "plan-assignment";
    rationale = "approved plan assignment";
    reference = request.planAssignment.planRevision;
  } else if (request.rule) {
    const rule = config.rules.find((r) => r.id === request.rule?.id);
    if (!rule) return refuse("PROFILE_UNKNOWN", `routing rule '${request.rule.id}' is not configured`);
    if (!rule.roles.includes(request.role)) return refuse("PROFILE_NOT_IN_CANDIDATES", `rule '${rule.id}' does not apply to role ${request.role}`);
    if (!rule.use.includes(request.rule.profile)) {
      return refuse("PROFILE_NOT_IN_CANDIDATES", `profile '${request.rule.profile}' is not a candidate of rule '${rule.id}'`, "Choose one of the rule's candidates or ask the user for an explicit override.");
    }
    if (request.rule.rationale.trim() === "") return refuse("CONFIG_INVALID", "rule selection requires a rationale");
    name = request.rule.profile;
    source = "rule";
    ruleId = rule.id;
    rationale = request.rule.rationale;
  } else {
    name = config.default;
    source = "default";
    rationale = "configured default profile";
  }

  const profile = config.profiles[name];
  if (!profile) return refuse("PROFILE_UNKNOWN", `profile '${name}' is not configured`);
  const aliases: Record<string, AliasTarget> = {};
  for (const [alias, target] of Object.entries(config.aliases)) aliases[alias] = target.provider === undefined ? { model: target.model } : { provider: target.provider, model: target.model };
  const evaluated = evaluateProfile(name, profile, aliases);
  if (!evaluated.ok) return evaluated;
  const selection: ProfileSelection = { source, rationale, profile: evaluated.value };
  if (ruleId) selection.ruleId = ruleId;
  if (reference) selection.reference = reference;
  return success(selection);
}
