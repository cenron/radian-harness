import { RadianError } from "./errors.ts";
import { ANTHROPIC_MARKERS, type Role, RUNTIME_EFFORTS } from "./constants.ts";
import type { DispatchConfig, Profile } from "#core/types.ts";

export function selectProfile(config: DispatchConfig, role: Role, requested?: string): Profile {
  const name = requested ?? config.roles[role];
  const profile = config.profiles[name];
  if (!profile) {
    const known = Object.keys(config.profiles).join(", ");
    throw new RadianError(
      "unknown_profile",
      `Unknown profile "${name}". Known profiles: ${known}.`,
    );
  }
  assertProfileAllowed(profile);
  return profile;
}

export function isAnthropicModel(profile: Profile): boolean {
  return ANTHROPIC_MARKERS.test(profile.model) || ANTHROPIC_MARKERS.test(profile.provider ?? "");
}

/** Anthropic models use the Claude Code subscription only; nothing is rerouted. */
export function assertProfileAllowed(profile: Profile): void {
  const isAnthropic = isAnthropicModel(profile);
  if (isAnthropic && profile.runtime !== "claude") {
    throw new RadianError(
      "anthropic_requires_claude",
      `Profile "${profile.name}": Anthropic models run only on Claude Code, not ${profile.runtime}.`,
    );
  }
  if (!isAnthropic && profile.runtime === "claude") {
    throw new RadianError(
      "claude_requires_anthropic",
      `Profile "${profile.name}": Claude Code runs only Anthropic models.`,
    );
  }
  if (profile.runtime === "pi" && !profile.provider) {
    throw new RadianError(
      "missing_provider",
      `Profile "${profile.name}": Pi profiles need a provider.`,
    );
  }
  if (!RUNTIME_EFFORTS[profile.runtime].includes(profile.effort)) {
    const allowed = RUNTIME_EFFORTS[profile.runtime].join(", ");
    throw new RadianError(
      "invalid_effort",
      `Profile "${profile.name}": effort "${profile.effort}" is not supported by ${profile.runtime}. Use ${allowed}.`,
    );
  }
}
