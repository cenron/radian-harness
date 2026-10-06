// Codex CLI worker adapter: `codex exec --json` with an explicit model and
// reasoning effort, Codex's own sandbox policy composed inside Radian's outer
// boundary (read-only for reviewers, workspace-write otherwise), user config and
// execpolicy rules ignored, and an ephemeral session per attempt. Blanket
// approval/sandbox bypass flags are never used. Composition of Codex's sandbox
// with the outer boundary remains an unverified capability.

import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import type { ResolvedAuthority } from "../contracts/authority.ts";
import type { Role } from "../contracts/identity.ts";
import type { LaunchInput, RuntimeAdapter, RuntimeEvent, RuntimeInstall, RuntimeLaunchPlan } from "./contract.ts";
import { checkArgv, initialPrompt } from "./contract.ts";
import { readVersion, locate, requireWrittenFor } from "./detect.ts";
import { classify } from "./errors.ts";
import { renderEvent } from "./pi.ts";

export const CODEX_FORBIDDEN_FLAGS = ["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--approve-for-me", "danger-full-access", "--oss", "--search", "--worktree"] as const;

export function codexSandbox(role: Role, authority: ResolvedAuthority): Outcome<"read-only" | "workspace-write"> {
  if (role === "reviewer") return success("read-only");
  if (authority.operations.includes("edit")) return success("workspace-write");
  return success("read-only");
}

export function createCodexAdapter(options: { executable?: string } = {}): RuntimeAdapter {
  const writtenFor = ["0.160.0"] as const;
  return {
    runtime: "codex",
    writtenFor,
    async detect(): Promise<Outcome<RuntimeInstall>> {
      const exe = locate("codex", "codex", options.executable);
      if (!exe.ok) return exe;
      const version = await readVersion(exe.value);
      if (!version.ok) return version;
      const supported = requireWrittenFor("codex", version.value, writtenFor);
      if (!supported.ok) return supported;
      return success({ runtime: "codex", executable: exe.value, version: version.value, installRoots: [path.dirname(path.dirname(exe.value))], helpers: [] });
    },
    toolsFor(role, authority) {
      // Codex exposes its own tool set; Radian constrains it by sandbox policy and the outer boundary.
      const sandbox = codexSandbox(role, authority);
      if (!sandbox.ok) return sandbox;
      return success([`codex-shell(${sandbox.value})`, ...(sandbox.value === "workspace-write" ? ["codex-apply-patch"] : [])]);
    },
    buildLaunch(input: LaunchInput): Outcome<RuntimeLaunchPlan> {
      if (input.profile.runtime !== "codex" || input.profile.family === "anthropic") return refuse("ANTHROPIC_REQUIRES_CLAUDE_CODE", "Codex workers never run Anthropic profiles");
      const sandbox = codexSandbox(input.identity.role, input.authority);
      if (!sandbox.ok) return sandbox;
      const home = input.projection.env.CODEX_HOME;
      if (!home) return refuse("CREDENTIAL_UNAVAILABLE", "Codex projection is missing CODEX_HOME");
      const argv = [
        input.install.executable,
        "exec",
        "--json",
        "--model",
        input.profile.model,
        "-c",
        `model_reasoning_effort="${input.profile.effort}"`,
        "-c",
        `sandbox_workspace_write.network_access=${input.authority.network === "ordinary-outbound"}`,
        "--sandbox",
        sandbox.value,
        "--cd",
        input.authority.worktree,
        "--ignore-user-config",
        "--ignore-rules",
        "--ephemeral",
        "--color",
        "never",
        "--output-last-message",
        path.join(input.authority.outputDir, "codex-last-message.txt"),
        initialPrompt(input),
      ];
      if (argv.some((arg) => (CODEX_FORBIDDEN_FLAGS as readonly string[]).includes(arg))) return refuse("CAPABILITY_MISSING", "a forbidden Codex flag was produced");
      if (!checkArgv(argv.slice(0, -1))) return refuse("PATH_INVALID", "launch arguments contain control characters");
      const tools = [`codex-shell(${sandbox.value})`, ...(sandbox.value === "workspace-write" ? ["codex-apply-patch"] : [])];
      return success({
        argv,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: input.authority.scratchDir, TMPDIR: input.authority.scratchDir, CODEX_HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", TERM: "dumb", NO_COLOR: "1" },
        cwd: input.authority.worktree,
        readRoots: input.install.installRoots,
        tools,
        parity: { interactiveUi: false, herdrAgentDetection: false, notes: "codex exec JSONL in a launcher-rendered pane; not the interactive Codex TUI" },
      });
    },
    parseEvent(line: string): RuntimeEvent[] {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return [];
      }
      switch (record.type) {
        case "thread.started":
          return [{ kind: "session-started", sessionId: String(record.thread_id ?? "") }];
        case "turn.started":
          return [{ kind: "prompt-accepted" }];
        case "item.started":
        case "item.completed": {
          const item = record.item as { type?: string; command?: string } | undefined;
          if (item?.type === "command_execution") return [{ kind: "tool", name: "shell", phase: record.type === "item.started" ? "start" : "end" }];
          if (item?.type === "file_change") return [{ kind: "tool", name: "apply_patch", phase: record.type === "item.started" ? "start" : "end" }];
          return [{ kind: "activity", detail: String(item?.type ?? "item") }];
        }
        case "turn.completed": {
          const usage = record.usage as { input_tokens?: number; output_tokens?: number } | undefined;
          return [
            ...(usage ? [{ kind: "usage" as const, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, source: "codex-exec" }] : []),
            { kind: "settled", outcome: "success" },
          ];
        }
        case "turn.failed": {
          const error = record.error as { message?: string; resets_at?: unknown } | undefined;
          const classified = classify(String(error?.message ?? "turn failed"), { resetsAt: error?.resets_at });
          return [{ kind: "error", error: classified }, { kind: "settled", outcome: "error", error: classified }];
        }
        case "error":
          return [{ kind: "error", error: classify(String(record.message ?? "error")) }];
        default:
          return [];
      }
    },
    render: renderEvent,
  };
}
