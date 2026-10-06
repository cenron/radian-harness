// Provider/model provenance and runtime compatibility (proposal 0015).
//
// - Anthropic models (Opus, Sonnet, Haiku, Fable, any Claude model) run only
//   through Claude Code's claude.ai subscription path.
// - Pi and Codex never receive Anthropic profiles, whatever the provider name.
// - Aliases are fully resolved first; every name in the chain is inspected, so a
//   neutral-looking alias or custom provider cannot disguise an Anthropic model.
// - Unknown providers, custom endpoints, and unresolved aliases block dispatch.
// - Nothing here reroutes: a rejected profile returns a blocker; callers must not
//   substitute Claude Code or any other candidate automatically.

import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import type { RuntimeKind } from "../contracts/identity.ts";
import { RUNTIME_FACTS } from "./runtimes.ts";

export type ProviderFamily = "anthropic" | "openai";

export interface ProviderPolicy {
  family: ProviderFamily;
  /** The only runtimes permitted for this provider, with the subscription route each must use. */
  routes: Partial<Record<RuntimeKind, string>>;
}

/**
 * Shipped, code-owned provider table. User configuration cannot add providers:
 * an unlisted provider is unknown provenance and blocks dispatch.
 */
export const KNOWN_PROVIDERS: Readonly<Record<string, ProviderPolicy>> = {
  anthropic: { family: "anthropic", routes: { "claude-code": "claude.ai subscription (Claude Code)" } },
  openai: {
    family: "openai",
    routes: {
      pi: "ChatGPT subscription OAuth (Pi openai provider)",
      codex: "ChatGPT subscription login (Codex CLI)",
    },
  },
};

/** Provider names that denote Anthropic models through some other route. All are prohibited except `anthropic` on Claude Code. */
const ANTHROPIC_PROVIDER_NAMES = /(anthropic|claude|bedrock|vertex)/i;
/** Model-name markers of Anthropic models, matched anywhere in the alias chain. */
export const ANTHROPIC_MODEL_MARKERS = /(claude|anthropic|opus|sonnet|haiku|fable)/i;

/** Fields that would route a runtime to a custom endpoint, proxy, or separately billed credential. */
export const PROHIBITED_PROFILE_FIELDS = [
  "baseUrl",
  "baseURL",
  "endpoint",
  "apiBase",
  "apiKey",
  "apiKeyEnv",
  "apiKeyHelper",
  "proxy",
  "customProvider",
  "headers",
  "billing",
  "extraUsage",
] as const;

export interface AliasTarget {
  provider?: string;
  model: string;
}

export interface ProfileInput {
  runtime: RuntimeKind;
  provider: string | null;
  model: string | null;
  effort: string;
}

export interface ResolvedProfile {
  name: string;
  runtime: RuntimeKind;
  provider: string;
  model: string;
  effort: string;
  family: ProviderFamily;
  /** Required subscription route; actual credential/billing evidence is checked at preflight. */
  subscriptionRoute: string;
  requested: { provider: string | null; model: string | null };
  aliasChain: string[];
}

export function findProhibitedFields(raw: Record<string, unknown>): string[] {
  return PROHIBITED_PROFILE_FIELDS.filter((field) => field in raw);
}

interface AliasResolution {
  provider: string | null;
  model: string;
  chain: string[];
}

function resolveAliases(provider: string | null, model: string, aliases: Readonly<Record<string, AliasTarget>>): Outcome<AliasResolution> {
  const chain: string[] = [];
  let currentProvider = provider;
  let currentModel = model;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!currentModel.startsWith("@")) return success({ provider: currentProvider, model: currentModel, chain });
    const name = currentModel.slice(1);
    if (chain.includes(name)) return refuse("ALIAS_UNRESOLVED", "alias cycle detected", "Fix the alias definitions in dispatch configuration.");
    chain.push(name);
    const target = aliases[name];
    if (!target) return refuse("ALIAS_UNRESOLVED", `alias '${name}' is not defined`, "Define the alias or use an exact model ID.");
    if (target.provider !== undefined) {
      if (currentProvider !== null && currentProvider !== target.provider) {
        return refuse("PROVIDER_PROVENANCE_UNKNOWN", `alias '${name}' changes the provider`, "Make the profile provider match the alias target.");
      }
      currentProvider = target.provider;
    }
    currentModel = target.model;
  }
  return refuse("ALIAS_UNRESOLVED", "alias chain too deep", "Use an exact model ID.");
}

export function evaluateProfile(
  name: string,
  profile: ProfileInput,
  aliases: Readonly<Record<string, AliasTarget>>,
  raw: Record<string, unknown> = {},
): Outcome<ResolvedProfile> {
  const prohibited = findProhibitedFields(raw);
  if (prohibited.length > 0) {
    return refuse("CUSTOM_ENDPOINT_PROHIBITED", `profile '${name}' sets custom endpoint/credential fields`, "Remove endpoint, key, proxy, and billing fields; only supported subscription paths are allowed.", {
      fields: prohibited.join(","),
    });
  }
  if (profile.model === null || profile.provider === null) {
    return refuse("PROFILE_UNCONFIGURED", `profile '${name}' has no configured provider/model`, "Configure an exact provider and model in a workspace or project override.");
  }

  const resolved = resolveAliases(profile.provider, profile.model, aliases);
  if (!resolved.ok) return resolved;
  const { model, chain } = resolved.value;
  const provider = resolved.value.provider ?? profile.provider;

  if (/[\s:]/.test(model) || model.includes("/")) {
    return refuse("PROVIDER_PROVENANCE_UNKNOWN", `profile '${name}' model must be an exact ID without provider prefix or thinking suffix`, "Set provider, model, and effort as separate fields.");
  }
  const facts = RUNTIME_FACTS[profile.runtime];
  if (facts.nativeAliases.test(model)) {
    return refuse("ALIAS_UNRESOLVED", `profile '${name}' uses a native alias rather than an exact model ID`, "Configure the exact model ID the runtime will report.");
  }

  const names = [provider, profile.model, model, ...chain];
  const anthropic = ANTHROPIC_PROVIDER_NAMES.test(provider) || names.some((n) => ANTHROPIC_MODEL_MARKERS.test(n));
  if (anthropic) {
    if (profile.runtime !== "claude-code") {
      return refuse("ANTHROPIC_REQUIRES_CLAUDE_CODE", `profile '${name}' routes an Anthropic model through ${profile.runtime}`, "Anthropic models run only through Claude Code. Choose a Claude Code profile explicitly; Radian does not reroute.");
    }
    if (provider !== "anthropic") {
      return refuse("PROVIDER_PROVENANCE_UNKNOWN", `profile '${name}' uses an Anthropic model through provider '${provider}'`, "Claude Code profiles must use provider 'anthropic' via the claude.ai subscription path.");
    }
  }

  const policy = KNOWN_PROVIDERS[provider];
  if (!policy) {
    return refuse("PROVIDER_PROVENANCE_UNKNOWN", `profile '${name}' uses an unknown provider`, "Use a supported subscription provider; unknown provenance blocks dispatch.");
  }
  if (profile.runtime === "claude-code" && policy.family !== "anthropic") {
    return refuse("RUNTIME_PROVIDER_MISMATCH", `profile '${name}' runs a non-Anthropic provider through Claude Code`, "Claude Code is used only for Anthropic models.");
  }
  const route = policy.routes[profile.runtime];
  if (!route) {
    return refuse("RUNTIME_PROVIDER_MISMATCH", `provider '${provider}' is not supported on ${profile.runtime}`, "Choose a runtime that supports this provider's subscription path.");
  }
  if (!facts.efforts.includes(profile.effort)) {
    return refuse("EFFORT_UNSUPPORTED", `effort '${profile.effort}' is not supported by ${profile.runtime}`, `Choose one of: ${facts.efforts.join(", ")}. Radian never clamps effort silently.`);
  }
  return success({
    name,
    runtime: profile.runtime,
    provider,
    model,
    effort: profile.effort,
    family: policy.family,
    subscriptionRoute: route,
    requested: { provider: profile.provider, model: profile.model },
    aliasChain: chain,
  });
}

/**
 * Recheck an already-resolved profile immediately before credential projection
 * or launch. Configuration may have changed since selection; a profile whose
 * runtime/provider/model pairing no longer passes is refused, never rewritten.
 */
export function recheckResolvedProfile(profile: ResolvedProfile): Outcome<ResolvedProfile> {
  const again = evaluateProfile(profile.name, { runtime: profile.runtime, provider: profile.provider, model: profile.model, effort: profile.effort }, {});
  if (!again.ok) return again;
  const names = [profile.requested.provider ?? "", profile.requested.model ?? "", ...profile.aliasChain];
  if (profile.runtime !== "claude-code" && names.some((n) => ANTHROPIC_MODEL_MARKERS.test(n) || ANTHROPIC_PROVIDER_NAMES.test(n))) {
    return refuse("ANTHROPIC_REQUIRES_CLAUDE_CODE", `profile '${profile.name}' has Anthropic provenance in its request`, "Anthropic models run only through Claude Code.");
  }
  if (again.value.family !== profile.family || again.value.subscriptionRoute !== profile.subscriptionRoute) {
    return refuse("PROVIDER_PROVENANCE_UNKNOWN", `profile '${profile.name}' provenance changed since selection`, "Re-select the profile through the coordinator.");
  }
  return success(profile);
}
