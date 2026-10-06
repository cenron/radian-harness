// Pi worker adapter. Chosen boundary: Radian's SDK bridge (pi-bridge.ts) using
// Pi's public package-root exports with an injected read-only credential store.
// The Pi CLI is not used for workers because its file-backed credential store
// requires the auth lock even for reads, and allowing that lock would also allow
// refresh. Missing parity is reported explicitly: no interactive Pi TUI in the
// worker pane, and no Herdr Pi-agent detection.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import type { ResolvedAuthority } from "../contracts/authority.ts";
import type { Role } from "../contracts/identity.ts";
import type { LaunchInput, RuntimeAdapter, RuntimeEvent, RuntimeInstall, RuntimeLaunchPlan } from "./contract.ts";
import { checkArgv, initialPrompt } from "./contract.ts";
import { readVersion, locate, requireWrittenFor } from "./detect.ts";
import { classify } from "./errors.ts";

export const PI_BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "pi-bridge.ts");
const PACKAGE = path.join("lib", "node_modules", "@earendil-works", "pi-coding-agent");

export interface PiLayout {
  node: string;
  packageDir: string;
  entry: string;
  installRoot: string;
}

/** Derive Pi's package and Node interpreter from the installed executable without running it. */
export function piLayout(executable: string): Outcome<PiLayout> {
  // Homebrew layout: <root>/bin/pi (wrapper) and <root>/libexec/{bin/pi, lib/node_modules/...}
  const root = path.dirname(path.dirname(executable));
  const packageDir = path.join(root, "libexec", PACKAGE);
  const launcher = path.join(root, "libexec", "bin", "pi");
  const entry = path.join(packageDir, "dist", "index.js");
  if (!existsSync(entry) || !existsSync(launcher)) return refuse("RUNTIME_UNAVAILABLE", "unrecognized Pi installation layout", "Radian supports the reviewed Homebrew layout; another layout needs adapter review.");
  let node: string;
  try {
    const firstLine = readFileSync(launcher, "utf8").split("\n")[0] ?? "";
    if (!firstLine.startsWith("#!/") || firstLine.includes(" ")) return refuse("RUNTIME_UNAVAILABLE", "Pi launcher interpreter is unrecognized");
    node = realpathSync(firstLine.slice(2));
  } catch {
    return refuse("RUNTIME_UNAVAILABLE", "Pi's Node interpreter cannot be resolved");
  }
  return success({ node, packageDir, entry, installRoot: realpathSync(root) });
}

export function piTools(role: Role, authority: ResolvedAuthority): Outcome<string[]> {
  const ops = new Set(authority.operations);
  const tools = ["read", "grep", "find", "ls"];
  if (ops.has("shell")) tools.push("bash");
  if (ops.has("edit")) tools.push("edit", "write");
  if (role === "reviewer" && tools.some((t) => t === "bash" || t === "edit" || t === "write")) {
    return refuse("ROLE_OPERATION_DENIED", "reviewers are read/report-only");
  }
  return success(tools);
}

export function createPiAdapter(options: { executable?: string } = {}): RuntimeAdapter {
  const writtenFor = ["1.0.2"] as const;
  return {
    runtime: "pi",
    writtenFor,
    async detect(): Promise<Outcome<RuntimeInstall>> {
      const exe = locate("pi", "pi", options.executable);
      if (!exe.ok) return exe;
      const layout = piLayout(exe.value);
      if (!layout.ok) return layout;
      const version = await readVersion(exe.value, { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" });
      if (!version.ok) return version;
      const supported = requireWrittenFor("pi", version.value, writtenFor);
      if (!supported.ok) return supported;
      return success({ runtime: "pi", executable: layout.value.node, version: version.value, installRoots: [layout.value.installRoot, path.dirname(path.dirname(layout.value.node))], helpers: [layout.value.node] });
    },
    toolsFor: piTools,
    buildLaunch(input: LaunchInput): Outcome<RuntimeLaunchPlan> {
      if (input.profile.runtime !== "pi" || input.profile.family === "anthropic") return refuse("ANTHROPIC_REQUIRES_CLAUDE_CODE", "Pi workers never run Anthropic profiles");
      const tools = piTools(input.identity.role, input.authority);
      if (!tools.ok) return tools;
      const agentDir = input.projection.env.PI_CODING_AGENT_DIR;
      if (!agentDir) return refuse("CREDENTIAL_UNAVAILABLE", "Pi projection is missing its agent directory");
      const bridge = input.bridgeScript ?? PI_BRIDGE;
      const configFile = path.join(input.projection.dir, "bridge-config.json");
      const argv = [input.install.executable, bridge, configFile];
      if (!checkArgv(argv)) return refuse("PATH_INVALID", "launch arguments contain control characters");
      return success({
        argv,
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: input.authority.scratchDir,
          TMPDIR: input.authority.scratchDir,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
          PI_TELEMETRY: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          TERM: "dumb",
        },
        cwd: input.authority.worktree,
        readRoots: [path.dirname(bridge), ...input.install.installRoots],
        tools: tools.value,
        parity: { interactiveUi: false, herdrAgentDetection: false, notes: "Pi SDK bridge using public package-root exports with a read-only credential store; no Pi TUI, no Herdr Pi-agent detection" },
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
        case "radian_session":
          return [{ kind: "session-started", sessionId: String(record.sessionId ?? ""), model: String(record.model ?? ""), effort: String(record.thinkingLevel ?? ""), authSource: "oauth-read-only-store", tools: Array.isArray(record.tools) ? record.tools.map(String) : [] }];
        case "radian_prompt_accepted":
          return [{ kind: "prompt-accepted" }];
        case "radian_blocker":
          return [{ kind: "error", error: classify(String(record.message ?? "")) }, { kind: "settled", outcome: "error", error: { class: "unknown", summary: String(record.code ?? "blocked") } }];
        case "tool_start":
          return [{ kind: "tool", name: String(record.toolName ?? ""), phase: "start" }];
        case "tool_end":
          return [{ kind: "tool", name: String(record.toolName ?? ""), phase: "end", isError: record.isError === true }];
        case "assistant_end": {
          const usage = record.usage as { input?: number; output?: number } | undefined;
          const events: RuntimeEvent[] = [];
          if (usage) events.push({ kind: "usage", inputTokens: usage.input, outputTokens: usage.output, source: "pi-sdk" });
          if (record.stopReason === "error") events.push({ kind: "error", error: classify(String(record.errorMessage ?? "error")) });
          return events;
        }
        case "auto_retry_start":
          return [{ kind: "error", error: classify(String(record.errorMessage ?? "")) }];
        case "agent_settled":
          return [{ kind: "settled", outcome: "success" }];
        case "turn_start":
          return [{ kind: "activity", detail: "turn" }];
        default:
          return [];
      }
    },
    render: renderEvent,
  };
}

export function renderEvent(event: RuntimeEvent): string | undefined {
  switch (event.kind) {
    case "session-started":
      return `[radian] session started (${event.model ?? "?"}, effort ${event.effort ?? "?"})`;
    case "tool":
      return event.phase === "start" ? `[radian] tool ${event.name}` : event.isError ? `[radian] tool ${event.name} failed` : undefined;
    case "error":
      return `[radian] ${event.error.class}: ${event.error.summary}`;
    case "settled":
      return `[radian] settled: ${event.outcome}`;
    default:
      return undefined;
  }
}

/** Bridge configuration written into the read-only projection directory. */
export function piBridgeConfig(input: LaunchInput, piEntry: string, tools: string[], systemPromptFile: string): Record<string, unknown> {
  return {
    schema: "radian.pi-bridge/1",
    piEntry: pathToFileURL(piEntry).href,
    provider: input.profile.provider,
    model: input.profile.model,
    effort: input.profile.effort,
    credentialFile: path.join(input.projection.env.PI_CODING_AGENT_DIR ?? "", "auth.json"),
    agentDir: input.projection.env.PI_CODING_AGENT_DIR,
    cwd: input.authority.worktree,
    tools,
    systemPromptFile,
    prompt: initialPrompt(input),
    sessionId: input.sessionId,
    catalogFile: path.join(input.authority.scratchDir, "pi-catalog.json"),
  };
}
