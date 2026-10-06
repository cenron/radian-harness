// Claude Code worker adapter — the only route for Anthropic models (proposal
// 0015). Headless `claude -p --output-format stream-json` with an exact model and
// effort, a fresh session ID, no session persistence, safe mode (no CLAUDE.md,
// skills, plugins, hooks, MCP, custom agents), strict empty MCP config, no
// slash commands, an explicit role tool set, and permission prompts denied.
// Reviewers additionally run in restricted mode. Never used: --bare (API-key
// only), --fallback-model, permission bypass flags, API keys, or custom
// endpoints. The init event's auth source must show no API key.

import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import type { ResolvedAuthority } from "../contracts/authority.ts";
import type { Role } from "../contracts/identity.ts";
import type { LaunchInput, RuntimeAdapter, RuntimeEvent, RuntimeInstall, RuntimeLaunchPlan } from "./contract.ts";
import { checkArgv, initialPrompt } from "./contract.ts";
import { readVersion, locate, requireWrittenFor } from "./detect.ts";
import { classify } from "./errors.ts";
import { renderEvent } from "./pi.ts";

export const CLAUDE_FORBIDDEN_FLAGS = ["--bare", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "bypassPermissions", "--fallback-model", "--chrome", "--remote-control", "--cloud", "--bg", "--background", "--worktree", "--tmux", "--ide", "--continue", "--resume", "--agents", "--plugin-url", "--plugin-dir", "--betas"] as const;

/** Claude tool names per role; Task/Agent delegation, web, and notebook tools are excluded. */
export function claudeTools(role: Role, authority: ResolvedAuthority): Outcome<string[]> {
  const ops = new Set(authority.operations);
  const tools = ["Read", "Glob", "Grep"];
  if (ops.has("shell")) tools.push("Bash");
  if (ops.has("edit")) tools.push("Edit", "Write");
  if (role === "reviewer" && tools.length !== 3) return refuse("ROLE_OPERATION_DENIED", "reviewers are read/report-only");
  return success(tools);
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
      return success({ runtime: "claude-code", executable: exe.value, version: version.value, installRoots: [path.dirname(exe.value)], helpers: [] });
    },
    toolsFor: claudeTools,
    buildLaunch(input: LaunchInput): Outcome<RuntimeLaunchPlan> {
      if (input.profile.runtime !== "claude-code" || input.profile.family !== "anthropic" || input.profile.provider !== "anthropic") {
        return refuse("RUNTIME_PROVIDER_MISMATCH", "Claude Code runs only Anthropic profiles through the claude.ai subscription path");
      }
      const tools = claudeTools(input.identity.role, input.authority);
      if (!tools.ok) return tools;
      const configDir = input.projection.env.CLAUDE_CONFIG_DIR;
      if (!configDir) return refuse("CREDENTIAL_UNAVAILABLE", "Claude Code projection is missing its config directory");
      const settings = JSON.stringify({ permissions: { deny: ["WebFetch", "WebSearch", "Task", "Agent", "NotebookEdit"] }, includeCoAuthoredBy: false });
      const argv = [
        input.install.executable,
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        input.profile.model,
        "--effort",
        input.profile.effort,
        "--session-id",
        input.sessionId,
        "--no-session-persistence",
        "--safe-mode",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--tools",
        tools.value.join(","),
        "--allowedTools",
        tools.value.join(","),
        "--permission-prompts",
        "none",
        "--permission-mode",
        "dontAsk",
        "--settings",
        settings,
        ...(input.identity.role === "reviewer" ? ["--restricted"] : []),
        initialPrompt(input),
      ];
      if (argv.some((arg) => (CLAUDE_FORBIDDEN_FLAGS as readonly string[]).includes(arg))) return refuse("CAPABILITY_MISSING", "a forbidden Claude Code flag was produced");
      if (!checkArgv(argv.slice(0, -1))) return refuse("PATH_INVALID", "launch arguments contain control characters");
      return success({
        argv,
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: input.authority.scratchDir,
          TMPDIR: input.authority.scratchDir,
          CLAUDE_CONFIG_DIR: configDir,
          CLAUDE_CODE_TMPDIR: input.authority.scratchDir,
          DISABLE_AUTOUPDATER: "1",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          TERM: "dumb",
          NO_COLOR: "1",
        },
        cwd: input.authority.worktree,
        readRoots: input.install.installRoots,
        tools: tools.value,
        parity: { interactiveUi: false, herdrAgentDetection: false, notes: "claude -p stream-json in a launcher-rendered pane; not the interactive Claude Code UI" },
      });
    },
    parseEvent(line: string): RuntimeEvent[] {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return [];
      }
      if (record.type === "system" && record.subtype === "init") {
        return [{ kind: "session-started", sessionId: String(record.session_id ?? ""), model: String(record.model ?? ""), authSource: String(record.apiKeySource ?? "unknown"), tools: Array.isArray(record.tools) ? record.tools.map(String) : [] }, { kind: "prompt-accepted" }];
      }
      if (record.type === "assistant") {
        const content = ((record.message as { content?: unknown[] } | undefined)?.content ?? []) as Array<{ type?: string; name?: string }>;
        return content.filter((c) => c.type === "tool_use").map((c) => ({ kind: "tool" as const, name: String(c.name ?? ""), phase: "start" as const }));
      }
      if (record.type === "result") {
        const usage = record.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        const events: RuntimeEvent[] = [];
        if (usage) events.push({ kind: "usage", inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, source: "claude-code-result" });
        if (record.is_error === true || record.subtype !== "success") {
          const error = classify(String(record.result ?? record.subtype ?? "error"));
          events.push({ kind: "error", error }, { kind: "settled", outcome: "error", error });
        } else {
          events.push({ kind: "settled", outcome: "success" });
        }
        return events;
      }
      return [];
    },
    render: renderEvent,
  };
}
