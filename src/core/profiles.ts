import { RadianError } from "./errors.ts";
import type { Role } from "./roles.ts";

export const RUNTIMES = ["claude", "codex", "pi"] as const;
export type Runtime = (typeof RUNTIMES)[number];

export interface Profile {
  name: string;
  runtime: Runtime;
  /** Pi needs a provider to find the model; Claude Code and Codex each have one fixed provider. */
  provider?: string;
  model: string;
  effort: string;
  description?: string;
}

export interface DispatchConfig {
  roles: Record<Role, string>;
  profiles: Record<string, Profile>;
}

const RUNTIME_EFFORTS: Record<Runtime, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
};

// Matched against both provider and model so a renamed provider or a bare alias
// such as "opus" cannot route an Anthropic model around Claude Code.
const ANTHROPIC_MARKERS = /(anthropic|claude|opus|sonnet|haiku|fable|bedrock|vertex)/i;

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
