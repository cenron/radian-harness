// Static, version-annotated runtime facts used by profile validation. These are
// documentation-derived declarations, not verified capabilities: adapters must
// still establish capability evidence at preflight (milestones 05–06).

import type { RuntimeKind } from "../contracts/identity.ts";

export interface RuntimeFacts {
  /** Documented effort/thinking levels accepted by this runtime version. */
  efforts: readonly string[];
  /** Where the effort list came from; "unverified" lists still require preflight evidence. */
  effortSource: string;
  /** Model names that are native aliases resolving to a moving target. */
  nativeAliases: RegExp;
  /** Version the facts were read from. */
  observedVersion: string;
}

export const RUNTIME_FACTS: Readonly<Record<RuntimeKind, RuntimeFacts>> = {
  pi: {
    efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    effortSource: "Pi 1.0.2 settings documentation (defaultThinkingLevel) and --thinking",
    // Pi accepts fuzzy model matches and globs; Radian requires an exact ID.
    nativeAliases: /[*?]|^latest$/i,
    observedVersion: "1.0.2",
  },
  "claude-code": {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    effortSource: "Claude Code 2.1.285 --effort help text",
    nativeAliases: /^(opus|sonnet|haiku|fable|default|best|opusplan)(\[[^\]]*\])?$/i,
    observedVersion: "2.1.285",
  },
  codex: {
    efforts: ["minimal", "low", "medium", "high"],
    effortSource: "unverified: Codex CLI 0.160.0 accepts model_reasoning_effort via -c; accepted values are not listed in its help",
    nativeAliases: /^latest$/i,
    observedVersion: "0.160.0",
  },
};
