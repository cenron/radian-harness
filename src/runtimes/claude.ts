// Claude Code worker adapter — the only route for Anthropic models (proposal
// 0015). Starts Claude Code's normal interactive session with the exact model
// and effort, the role guide appended to its system prompt, a fresh session
// id, no MCP servers, an explicit role tool set with everything else denied
// without prompting, and the task as its first message.

import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import type { ResolvedAuthority } from "../contracts/authority.ts";
import type { Role } from "../contracts/identity.ts";
import type { LaunchInput, RuntimeAdapter, RuntimeInstall, RuntimeLaunchPlan } from "./contract.ts";
import { checkArgv, initialPrompt } from "./contract.ts";
import { readVersion, locate, requireWrittenFor } from "./detect.ts";

export const CLAUDE_FORBIDDEN_FLAGS = ["--bare", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "bypassPermissions", "--fallback-model", "--continue", "--resume", "--agents"] as const;

/** Claude tool names per role; Task/Agent delegation, web, and notebook tools are excluded. */
export function claudeTools(role: Role, authority: ResolvedAuthority): Outcome<string[]> {
  const ops = new Set(authority.operations);
  const tools = ["Read", "Glob", "Grep"];
  if (ops.has("shell")) tools.push("Bash");
  if (ops.has("edit")) tools.push("Edit", "Write");
  if (role === "reviewer") tools.push("Write");
  return success([...new Set(tools)]);
}

export function createClaudeAdapter(options: { executable?: string } = {}): RuntimeAdapter {
  const writtenFor = ["2.1.285"] as const;
  return {
    runtime: "claude-code",
    writtenFor,
    async detect(): Promise<Outcome<RuntimeInstall>> {
      const exe = locate("claude-code", "claude", options.executable);
      if (!exe.ok) return exe;
      const version = await readVersion(exe.value, { DISABLE_AUTOUPDATER: "1" });
      if (!version.ok) return version;
      const supported = requireWrittenFor("claude-code", version.value, writtenFor);
      if (!supported.ok) return supported;
      return success({ runtime: "claude-code", executable: exe.value, version: version.value });
    },
    toolsFor: claudeTools,
    buildLaunch(input: LaunchInput): Outcome<RuntimeLaunchPlan> {
      if (input.profile.runtime !== "claude-code" || input.profile.family !== "anthropic" || input.profile.provider !== "anthropic") {
        return refuse("RUNTIME_PROVIDER_MISMATCH", "Claude Code runs only Anthropic profiles through the claude.ai subscription path");
      }
      const tools = claudeTools(input.identity.role, input.authority);
      if (!tools.ok) return tools;
      const settings = JSON.stringify({ permissions: { deny: ["WebFetch", "WebSearch", "Task", "Agent", "NotebookEdit"] }, includeCoAuthoredBy: false });
      const argv = [
        input.install.executable,
        "--model",
        input.profile.model,
        "--effort",
        input.profile.effort,
        "--session-id",
        input.sessionId,
        "--name",
        `${input.identity.role} ${input.identity.assignment.slice(0, 12)}`,
        "--append-system-prompt",
        input.systemPrompt,
        "--strict-mcp-config",
        "--tools",
        tools.value.join(","),
        "--allowedTools",
        tools.value.join(","),
        "--permission-mode",
        "dontAsk",
        "--settings",
        settings,
        "--add-dir",
        input.authority.outputDir,
        initialPrompt(input),
      ];
      if (argv.some((arg) => (CLAUDE_FORBIDDEN_FLAGS as readonly string[]).includes(arg))) return refuse("CAPABILITY_MISSING", "a forbidden Claude Code flag was produced");
      if (!checkArgv(argv)) return refuse("PATH_INVALID", "launch arguments contain control characters");
      return success({ argv, env: { DISABLE_AUTOUPDATER: "1" }, cwd: input.authority.worktree, tools: tools.value });
    },
  };
}
