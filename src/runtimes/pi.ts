// Pi worker adapter: starts Pi's normal interactive session with an explicit
// provider, model, and thinking level, the role guide appended to the system
// prompt, an explicit role tool set, and the task as its first message.
// Project-local Pi files (including the Radian package entry), extensions,
// skills, and prompt templates are not loaded, so a worker never becomes a
// coordinator.

import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import type { ResolvedAuthority } from "../contracts/authority.ts";
import type { Role } from "../contracts/identity.ts";
import type { LaunchInput, RuntimeAdapter, RuntimeInstall, RuntimeLaunchPlan } from "./contract.ts";
import { checkArgv, initialPrompt } from "./contract.ts";
import { readVersion, locate, requireWrittenFor } from "./detect.ts";

export function piTools(role: Role, authority: ResolvedAuthority): Outcome<string[]> {
  const ops = new Set(authority.operations);
  const tools = ["read", "grep", "find", "ls"];
  if (ops.has("shell")) tools.push("bash");
  if (ops.has("edit")) tools.push("edit", "write");
  // Reviewers write only their result file.
  if (role === "reviewer") tools.push("write");
  return success([...new Set(tools)]);
}

export function createPiAdapter(options: { executable?: string } = {}): RuntimeAdapter {
  const writtenFor = ["1.0.2"] as const;
  return {
    runtime: "pi",
    writtenFor,
    async detect(): Promise<Outcome<RuntimeInstall>> {
      const exe = locate("pi", "pi", options.executable);
      if (!exe.ok) return exe;
      const version = await readVersion(exe.value, { PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" });
      if (!version.ok) return version;
      const supported = requireWrittenFor("pi", version.value, writtenFor);
      if (!supported.ok) return supported;
      return success({ runtime: "pi", executable: exe.value, version: version.value });
    },
    toolsFor: piTools,
    buildLaunch(input: LaunchInput): Outcome<RuntimeLaunchPlan> {
      if (input.profile.runtime !== "pi" || input.profile.family === "anthropic") return refuse("ANTHROPIC_REQUIRES_CLAUDE_CODE", "Pi workers never run Anthropic profiles");
      const tools = piTools(input.identity.role, input.authority);
      if (!tools.ok) return tools;
      const argv = [
        input.install.executable,
        "--provider",
        input.profile.provider,
        "--model",
        input.profile.model,
        "--thinking",
        input.profile.effort,
        "--append-system-prompt",
        input.systemPrompt,
        "--tools",
        tools.value.join(","),
        "--no-approve",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        initialPrompt(input),
      ];
      if (!checkArgv(argv)) return refuse("PATH_INVALID", "launch arguments contain control characters");
      return success({ argv, env: { PI_SKIP_VERSION_CHECK: "1" }, cwd: input.authority.worktree, tools: tools.value });
    },
  };
}
