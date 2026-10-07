import { assertProfileAllowed, type Profile } from "./profiles.ts";
import { canEditCode, type Role } from "./roles.ts";

export interface LaunchInput {
  profile: Profile;
  role: Role;
  /** Holds the brief, status, and report files; outside the worktree. */
  workerDir: string;
  /** Commits from a worktree are written to the main repository's git directory. */
  gitCommonDir: string;
}

/** Variables that would move a worker off the user's subscription login onto API billing, a custom endpoint, or a proxy. */
export const SCRUBBED_ENV: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
];

/** Flags for the runtime's normal interactive session. The prompt is typed in afterwards, never passed here. */
export function runtimeArgs(input: LaunchInput): string[] {
  assertProfileAllowed(input.profile);
  if (input.profile.runtime === "claude") return claudeArgs(input);
  if (input.profile.runtime === "codex") return codexArgs(input);
  return piArgs(input);
}

function claudeArgs({ profile, role, workerDir }: LaunchInput): string[] {
  const tools = [
    "Read",
    "Glob",
    "Grep",
    "Bash",
    "Write",
    ...(canEditCode(role) ? ["Edit"] : []),
  ].join(",");
  return [
    "--model",
    profile.model,
    "--effort",
    profile.effort,
    "--tools",
    tools,
    "--allowedTools",
    tools,
    "--add-dir",
    workerDir,
    "--permission-mode",
    "dontAsk",
  ];
}

// Every role runs workspace-write: a read-only Codex sandbox could not append to
// the status file, which lives outside the worktree.
function codexArgs({ profile, workerDir, gitCommonDir }: LaunchInput): string[] {
  return [
    "--model",
    profile.model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(profile.effort)}`,
    "-c",
    "sandbox_workspace_write.network_access=true",
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "never",
    "--add-dir",
    workerDir,
    "--add-dir",
    gitCommonDir,
  ];
}

// --no-approve and --no-extensions keep a Pi worker from loading Radian from the
// workspace settings and becoming a second coordinator.
function piArgs({ profile, role }: LaunchInput): string[] {
  const tools = [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "write",
    ...(canEditCode(role) ? ["edit"] : []),
  ];
  return [
    "--provider",
    profile.provider ?? "",
    "--model",
    profile.model,
    "--thinking",
    profile.effort,
    "--tools",
    tools.join(","),
    "--no-approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
  ];
}
