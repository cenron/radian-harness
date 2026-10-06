// Codex CLI worker adapter: starts Codex's normal interactive session with an
// explicit model and reasoning effort, the role guide as developer
// instructions, Codex's own sandbox policy (read-only for reviewers,
// workspace-write otherwise, with the output directory writable), approvals
// never requested, and the task as its first message. Blanket approval/sandbox
// bypass flags are never used.

import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import type { ResolvedAuthority } from "../contracts/authority.ts";
import type { Role } from "../contracts/identity.ts";
import type { LaunchInput, RuntimeAdapter, RuntimeInstall, RuntimeLaunchPlan } from "./contract.ts";
import { checkArgv, initialPrompt } from "./contract.ts";
import { readVersion, locate, requireWrittenFor } from "./detect.ts";

export const CODEX_FORBIDDEN_FLAGS = ["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--approve-for-me", "danger-full-access", "--oss", "--search"] as const;

export function codexSandbox(role: Role, authority: ResolvedAuthority): Outcome<"read-only" | "workspace-write"> {
  if (role === "reviewer") return success("read-only");
  if (authority.operations.includes("edit")) return success("workspace-write");
  return success("read-only");
}

/** A TOML basic string (JSON string escapes are valid TOML escapes). */
const toml = (value: string) => JSON.stringify(value);

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
      return success({ runtime: "codex", executable: exe.value, version: version.value });
    },
    toolsFor(role, authority) {
      const sandbox = codexSandbox(role, authority);
      return sandbox.ok ? success([`codex-shell(${sandbox.value})`]) : sandbox;
    },
    buildLaunch(input: LaunchInput): Outcome<RuntimeLaunchPlan> {
      if (input.profile.runtime !== "codex" || input.profile.family === "anthropic") return refuse("ANTHROPIC_REQUIRES_CLAUDE_CODE", "Codex workers never run Anthropic profiles");
      const sandbox = codexSandbox(input.identity.role, input.authority);
      if (!sandbox.ok) return sandbox;
      const argv = [
        input.install.executable,
        "--model",
        input.profile.model,
        "-c",
        `model_reasoning_effort=${toml(input.profile.effort)}`,
        "-c",
        `developer_instructions=${toml(input.systemPrompt)}`,
        "-c",
        `sandbox_workspace_write.network_access=${input.authority.network === "ordinary-outbound"}`,
        "--sandbox",
        sandbox.value,
        "--ask-for-approval",
        "never",
        "--cd",
        input.authority.worktree,
        "--add-dir",
        input.authority.outputDir,
        initialPrompt(input),
      ];
      if (argv.some((arg) => (CODEX_FORBIDDEN_FLAGS as readonly string[]).includes(arg))) return refuse("CAPABILITY_MISSING", "a forbidden Codex flag was produced");
      if (!checkArgv(argv)) return refuse("PATH_INVALID", "launch arguments contain control characters");
      return success({ argv, env: {}, cwd: input.authority.worktree, tools: [`codex-shell(${sandbox.value})`] });
    },
  };
}
