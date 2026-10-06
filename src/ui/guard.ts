// Coordinator tool guard for managed sessions (both Plan and Build). Pi stays a
// coordinator: it may read and search through Radian's confined read tools and
// call Radian's registered tools (planning drafts through
// radian_write_artifact, Git through the fixed read-only radian_git_inspect).
// Pi's own write/edit, every shell command, MCP/codemode/tool search,
// deferred and other extensions' tools, and unknown tools are blocked with a
// stable rule and a safe alternative — including nested calls, which Pi also
// passes through tool_call. The guard is state-aware: a recognized but
// invalid workspace is `blocked` (every tool refused), and with no project
// selected only workspace status and confined workspace reads are allowed.
// This is a mistake/prompt-injection guard inside the Pi process, not an OS
// boundary.
//
// The coordinator's shell runs outside worker containment. Programs that look
// read-only still accept options, repository configuration, and environment
// that start helpers or write files (rg --pre, git --ext-diff/--textconv,
// core.fsmonitor and pagers, file --compile, output flags), so a program-name
// allowlist or metacharacter filter cannot make shell commands safe. Reads go
// through Pi's read/grep/find/ls tools, whose patterns are passed after "--",
// and Git inspection goes through radian_git_inspect, which only runs fixed,
// validated argument vectors under controlled Git.

import path from "node:path";
import { canonicalPath, isWithin } from "../contracts/paths.ts";
import type { HostToolCallEvent } from "./pi-host.ts";

export interface GuardDecision {
  block: boolean;
  rule?: "RH-COORD-PRODUCTION-WRITE" | "RH-COORD-SHELL" | "RH-COORD-UNKNOWN-TOOL" | "RH-COORD-PATH" | "RH-WORKSPACE-BLOCKED" | "RH-NO-PROJECT";
  reason?: string;
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
/** Allowed with no project selected: workspace status and confined workspace reads. */
const DASHBOARD_TOOLS = new Set(["radian_status", "read", "ls"]);

export interface GuardOptions {
  /** `project` (selected or direct entry), `dashboard` (workspace, nothing selected), or `blocked`. */
  state?: "project" | "dashboard" | "blocked";
  /** Why a blocked workspace is blocked. */
  blockedReason?: string;
  projectRoot: string;
  /** Canonical directories where approved planning artifacts may be written. */
  planningRoots: readonly string[];
  /** Radian's own registered tool names. */
  radianTools: ReadonlySet<string>;
  /**
   * Whether the active read/grep/find/ls definitions are Radian's confined
   * overrides. When another extension has replaced one, it is refused.
   * Undefined means not checked (direct-entry compatibility with older hosts).
   */
  ownedReadTools?: ReadonlySet<string>;
}

export function guardToolCall(event: HostToolCallEvent, options: GuardOptions, cwd: string): GuardDecision {
  const name = event.toolName;
  const state = options.state ?? "project";
  if (state === "blocked") {
    return { block: true, rule: "RH-WORKSPACE-BLOCKED", reason: `This Radian workspace is blocked (${options.blockedReason ?? "invalid workspace"}); no tool runs until it is fixed. Check it with the installer's status and recover commands.` };
  }
  if (READ_TOOLS.has(name) && options.ownedReadTools && !options.ownedReadTools.has(name)) {
    return { block: true, rule: "RH-COORD-UNKNOWN-TOOL", reason: `Tool '${name}' is no longer Radian's confined implementation (another extension replaced it); it is disabled in managed sessions.` };
  }
  if (state === "dashboard" && (READ_TOOLS.has(name) || options.radianTools.has(name)) && !DASHBOARD_TOOLS.has(name)) {
    return { block: true, rule: "RH-NO-PROJECT", reason: `No project is selected. '${name}' acts on a project: select one with /projects (or create one with /new-project).` };
  }
  if (READ_TOOLS.has(name) || options.radianTools.has(name)) return { block: false };
  if (name === "bash") {
    return { block: true, rule: "RH-COORD-SHELL", reason: "The Radian coordinator does not run shell commands. Use read, grep, find, or ls to inspect files, radian_git_inspect for Git status/log/diff/show, and a scout or developer assignment for anything else." };
  }
  if (name === "edit" || name === "write") {
    // Pi's write/edit resolve links at write time, so a pre-check here cannot
    // stop a link swapped in afterwards. Planning drafts go only through
    // radian_write_artifact, which opens without following any link.
    const raw = typeof event.input.path === "string" ? event.input.path : typeof event.input.file_path === "string" ? event.input.file_path : "";
    const planning = "Write planning drafts with radian_write_artifact (whole-file, link-safe).";
    if (!raw) return { block: true, rule: "RH-COORD-PATH", reason: `Write target is missing. ${planning}` };
    const lexical = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw);
    const resolved = canonicalPath(lexical);
    const inPlanning = [lexical, ...(resolved.ok ? [resolved.value] : [])].some((p) => options.planningRoots.some((root) => isWithin(p, root)));
    if (inPlanning) return { block: true, rule: "RH-COORD-PATH", reason: `Pi's ${name} tool is disabled for the Radian coordinator. ${planning}` };
    return { block: true, rule: "RH-COORD-PRODUCTION-WRITE", reason: `The Radian coordinator does not edit production files. ${planning} Dispatch a developer assignment after approval for production changes.` };
  }
  return { block: true, rule: "RH-COORD-UNKNOWN-TOOL", reason: `Tool '${name}' is not covered by Radian's coordinator guard and is disabled in managed sessions.` };
}
