// Coordinator tool guard for managed sessions (both Plan and Build). Pi stays a
// coordinator: it may read and search and call Radian's registered tools
// (planning drafts through radian_write_artifact, Git through the fixed
// read-only radian_git_inspect). Pi's own write/edit, every shell command,
// MCP/codemode, and unknown tools are blocked with a stable rule and a safe
// alternative. This is a mistake/prompt-injection guard inside the Pi process,
// not an OS boundary.
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
  rule?: "RH-COORD-PRODUCTION-WRITE" | "RH-COORD-SHELL" | "RH-COORD-UNKNOWN-TOOL" | "RH-COORD-PATH";
  reason?: string;
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

export interface GuardOptions {
  projectRoot: string;
  /** Canonical directories where approved planning artifacts may be written. */
  planningRoots: readonly string[];
  /** Radian's own registered tool names. */
  radianTools: ReadonlySet<string>;
}

export function guardToolCall(event: HostToolCallEvent, options: GuardOptions, cwd: string): GuardDecision {
  const name = event.toolName;
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
