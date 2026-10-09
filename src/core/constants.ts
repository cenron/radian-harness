export const RUNTIMES = ["claude", "codex", "pi"] as const;
export type Runtime = (typeof RUNTIMES)[number];

export const ROLES = ["developer", "tester", "reviewer", "scout"] as const;
export type Role = (typeof ROLES)[number];

export const RUNTIME_EFFORTS: Record<Runtime, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
};

// Matched against both provider and model so a renamed provider or a bare alias
// such as "opus" cannot route an Anthropic model around Claude Code.
export const ANTHROPIC_MARKERS = /(anthropic|claude|opus|sonnet|haiku|fable|bedrock|vertex)/i;

/** The countdown `/radian automerge on` sets: long enough to cancel, short enough not to stall. */
export const DEFAULT_AUTO_MERGE_SECONDS = 60;

/** How many files Radian names before it says "and N more". */
export const FILE_LIST_LIMIT = 10;
