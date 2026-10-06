// Coordinator tool guard for managed sessions (both Plan and Build). Pi stays a
// coordinator: it may read and search, write approved planning artifacts under
// the planning roots, run a narrow set of read-only commands, and call Radian's
// registered tools. Production edits, arbitrary shell, MCP/codemode, and
// unknown tools are blocked with a stable rule and a safe alternative. This is
// a mistake/prompt-injection guard inside the Pi process, not an OS boundary.

import path from "node:path";
import { canonicalPath, isWithin } from "../contracts/paths.ts";
import type { HostToolCallEvent } from "./pi-host.ts";

export interface GuardDecision {
  block: boolean;
  rule?: "RH-COORD-PRODUCTION-WRITE" | "RH-COORD-SHELL" | "RH-COORD-UNKNOWN-TOOL" | "RH-COORD-PATH";
  reason?: string;
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const READ_ONLY_COMMANDS = new Set(["ls", "cat", "head", "tail", "wc", "grep", "rg", "pwd", "tree", "stat", "file"]);
const GIT_READ_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "blame"]);
const SHELL_META = /[;&|<>`$(){}\\\n\r*?!]/;

export function readOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "" || SHELL_META.test(trimmed)) return false;
  const words = trimmed.split(/\s+/);
  const program = words[0]!;
  if (words.some((w) => /^--?(output|exec|delete|in-place|write)/.test(w) || w === "-i" || w === "-o")) return false;
  if (program === "git") return GIT_READ_SUBCOMMANDS.has(words[1] ?? "") && !words.includes("--output");
  return READ_ONLY_COMMANDS.has(program);
}

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
    const command = typeof event.input.command === "string" ? event.input.command : "";
    if (readOnlyCommand(command)) return { block: false };
    return { block: true, rule: "RH-COORD-SHELL", reason: "The Radian coordinator only runs simple read-only commands. Use a scout or developer assignment for anything else." };
  }
  if (name === "edit" || name === "write") {
    const raw = typeof event.input.path === "string" ? event.input.path : typeof event.input.file_path === "string" ? event.input.file_path : "";
    if (!raw) return { block: true, rule: "RH-COORD-PATH", reason: "Write target is missing." };
    const resolved = canonicalPath(path.isAbsolute(raw) ? raw : path.resolve(cwd, raw));
    if (!resolved.ok) return { block: true, rule: "RH-COORD-PATH", reason: "Write target cannot be resolved safely." };
    if (options.planningRoots.some((root) => isWithin(resolved.value, root))) return { block: false };
    return { block: true, rule: "RH-COORD-PRODUCTION-WRITE", reason: "The Radian coordinator does not edit production files. Write planning artifacts under the planning directory, or dispatch a developer assignment after approval." };
  }
  return { block: true, rule: "RH-COORD-UNKNOWN-TOOL", reason: `Tool '${name}' is not covered by Radian's coordinator guard and is disabled in managed sessions.` };
}
