// Confined model-facing read tools. In a Radian workspace, Radian replaces
// Pi's `read`, `ls`, `grep`, and `find` (same names, Pi's supported tool
// override) so the coordinator can only read the scope captured when the call
// started: the selected project's root, or — on the dashboard — the workspace
// root without Radian's private state. Absolute, relative, traversal, and
// linked paths are resolved against that scope and refused outside it.
//
// - `read` and `ls` are implemented here. `read` opens with macOS
//   O_NOFOLLOW_ANY, so no component of the path may be a link at open time.
// - `grep` and `find` delegate to Pi's own ripgrep/fd implementations only
//   after the search path is validated as a link-free directory or file inside
//   the scope; neither tool follows links during traversal. They are not
//   offered on the dashboard (which would otherwise search private state).
// The scope is fixed per call: a later change of selection cannot redirect it.

import { closeSync, constants, fstatSync, openSync, readdirSync } from "node:fs";
import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { isWithin } from "../contracts/paths.ts";
import { readFileConfinedBytes, verifiedDirIdentity } from "../util/safe-dir.ts";

export interface ReadScope {
  kind: "project" | "dashboard";
  /** Canonical root every path must stay inside. */
  root: string;
  /** Absolute directories inside the root that are never readable (private state). */
  deny: readonly string[];
  /** Canonical directories of loaded skills, readable for their instructions. */
  skillRoots: readonly string[];
}

export const READ_TOOL_NAMES = ["read", "ls", "grep", "find"] as const;

const O_NOFOLLOW_ANY = 0x20000000;
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const MAX_ENTRIES = 500;

/** Resolve a model-supplied path inside the scope (or a loaded skill directory for reads). */
export function resolveInScope(scope: ReadScope, input: unknown, options: { allowSkills?: boolean } = {}): Outcome<{ abs: string; anchor: string; relative: string }> {
  const raw = typeof input === "string" && input.trim() !== "" ? input.trim().replace(/^@/, "") : ".";
  if (raw.includes("\0")) return refuse("PATH_INVALID", "the path is invalid");
  const abs = path.resolve(scope.root, raw);
  const anchors = [scope.root, ...(options.allowSkills ? scope.skillRoots : [])];
  const anchor = anchors.find((a) => abs === a || isWithin(abs, a));
  if (!anchor) return refuse("PATH_OUTSIDE_SCOPE", scope.kind === "project" ? "the path is outside the selected project" : "the path is outside the workspace");
  if (scope.deny.some((d) => abs === d || isWithin(abs, d))) return refuse("PATH_OUTSIDE_SCOPE", "Radian's private workspace state is not readable");
  return success({ abs, anchor, relative: path.relative(anchor, abs).split(path.sep).join("/") });
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: undefined };
}

export function readInScope(scope: ReadScope, params: Record<string, unknown>): Outcome<string> {
  const resolved = resolveInScope(scope, params.path, { allowSkills: true });
  if (!resolved.ok) return resolved;
  if (resolved.value.relative === "") return refuse("PATH_INVALID", "the path is a directory; use ls");
  const bytes = readFileConfinedBytes(resolved.value.anchor, resolved.value.relative);
  if (!bytes.ok) return bytes;
  if (bytes.value === undefined) return refuse("PATH_INVALID", "the file does not exist");
  if (bytes.value.subarray(0, 8192).includes(0)) return success(`[binary file, ${bytes.value.length} bytes; not shown]`);
  const lines = bytes.value.toString("utf8").split("\n");
  const offset = typeof params.offset === "number" && params.offset > 1 ? Math.floor(params.offset) : 1;
  const limit = typeof params.limit === "number" && params.limit > 0 ? Math.min(Math.floor(params.limit), MAX_LINES) : MAX_LINES;
  const selected: string[] = [];
  let size = 0;
  let last = offset - 1;
  for (let i = offset - 1; i < lines.length && selected.length < limit; i += 1) {
    const line = lines[i]!;
    if (size + line.length + 1 > MAX_BYTES && selected.length > 0) break;
    selected.push(line);
    size += line.length + 1;
    last = i + 1;
  }
  const more = last < lines.length && !(last === lines.length - 1 && lines[lines.length - 1] === "");
  return success(selected.join("\n") + (more ? `\n\n[Showing lines ${offset}-${last} of ${lines.length}. Use offset=${last + 1} to continue.]` : ""));
}

export function lsInScope(scope: ReadScope, params: Record<string, unknown>): Outcome<string> {
  const resolved = resolveInScope(scope, params.path);
  if (!resolved.ok) return resolved;
  const dir = verifiedDirIdentity(resolved.value.abs);
  if (!dir.ok) return dir;
  let entries;
  try {
    entries = readdirSync(resolved.value.abs, { withFileTypes: true });
  } catch {
    return refuse("PATH_INVALID", "the directory cannot be listed");
  }
  const limit = typeof params.limit === "number" && params.limit > 0 ? Math.min(Math.floor(params.limit), MAX_ENTRIES) : MAX_ENTRIES;
  const names = entries
    .filter((e) => !scope.deny.some((d) => path.join(resolved.value.abs, e.name) === d))
    .map((e) => (e.isSymbolicLink() ? `${e.name}@ (link, not followed)` : e.isDirectory() ? `${e.name}/` : e.name))
    .sort((a, b) => a.localeCompare(b));
  const shown = names.slice(0, limit);
  return success((shown.join("\n") || "(empty directory)") + (names.length > shown.length ? `\n\n[${names.length - shown.length} more entries; raise limit]` : ""));
}

/** A link-free directory or regular file inside the scope, for delegated searches. */
export function validateSearchPath(scope: ReadScope, input: unknown): Outcome<string> {
  const resolved = resolveInScope(scope, input);
  if (!resolved.ok) return resolved;
  let fd: number;
  try {
    fd = openSync(resolved.value.abs, constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ELOOP" ? refuse("PATH_OUTSIDE_SCOPE", "the path contains a symbolic link; Radian does not follow links here") : refuse("PATH_INVALID", "the path does not exist");
  }
  try {
    const st = fstatSync(fd);
    if (!st.isDirectory() && !st.isFile()) return refuse("PATH_INVALID", "the path is not a file or directory");
  } finally {
    closeSync(fd);
  }
  return success(resolved.value.abs);
}

/** Tool definitions Pi supplies for delegation (grep/find); absent in fake hosts. */
export interface DelegateTools {
  grep?: (root: string) => { execute: (...args: unknown[]) => Promise<unknown> };
  find?: (root: string) => { execute: (...args: unknown[]) => Promise<unknown> };
}

export type ScopeProvider = () => Outcome<ReadScope>;

/**
 * Build Radian's override definitions. `scopeAt` captures the scope when a
 * call starts; the call then uses only that scope.
 */
export function readToolDefinitions(T: { Object(p: Record<string, unknown>): unknown; String(o?: Record<string, unknown>): unknown; Number(o?: Record<string, unknown>): unknown; Boolean(o?: Record<string, unknown>): unknown; Optional(s: unknown): unknown }, scopeAt: ScopeProvider, delegates: DelegateTools) {
  const fail = (b: { code: string; message: string }) => {
    throw new Error(`BLOCKED ${b.code}: ${b.message}`);
  };
  return [
    {
      name: "read",
      label: "read (Radian-confined)",
      description: "Read a text file inside the selected project (or, with no project selected, the workspace). Paths may be relative to the project root. Links are not followed; private Radian state and other projects are not readable.",
      parameters: T.Object({ path: T.String({ description: "File path, relative to the project root" }), offset: T.Optional(T.Number({ description: "First line (1-indexed)" })), limit: T.Optional(T.Number({ description: "Maximum lines" })) }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const scope = scopeAt();
        if (!scope.ok) return fail(scope.blocker);
        const out = readInScope(scope.value, params);
        return out.ok ? text(out.value) : fail(out.blocker);
      },
    },
    {
      name: "ls",
      label: "ls (Radian-confined)",
      description: "List a directory inside the selected project (or, with no project selected, the workspace). Links are shown, never followed.",
      parameters: T.Object({ path: T.Optional(T.String({ description: "Directory, relative to the project root (default: root)" })), limit: T.Optional(T.Number()) }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        const scope = scopeAt();
        if (!scope.ok) return fail(scope.blocker);
        const out = lsInScope(scope.value, params);
        return out.ok ? text(out.value) : fail(out.blocker);
      },
    },
    ...(["grep", "find"] as const).map((name) => ({
      name,
      label: `${name} (Radian-confined)`,
      description: name === "grep" ? "Search file contents inside the selected project (respects .gitignore; links are not followed)." : "Find files by glob pattern inside the selected project (respects .gitignore; links are not followed).",
      parameters:
        name === "grep"
          ? T.Object({ pattern: T.String(), path: T.Optional(T.String()), glob: T.Optional(T.String()), ignoreCase: T.Optional(T.Boolean()), literal: T.Optional(T.Boolean()), context: T.Optional(T.Number()), limit: T.Optional(T.Number()) })
          : T.Object({ pattern: T.String(), path: T.Optional(T.String()), limit: T.Optional(T.Number()) }),
      execute: async (id: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: unknown) => {
        const scope = scopeAt();
        if (!scope.ok) return fail(scope.blocker);
        if (scope.value.kind !== "project") return fail({ code: "NO_PROJECT_SELECTED", message: `${name} searches a selected project; select one with /projects` });
        const searchPath = validateSearchPath(scope.value, params.path);
        if (!searchPath.ok) return fail(searchPath.blocker);
        const factory = delegates[name];
        if (!factory) return fail({ code: "CAPABILITY_MISSING", message: `${name} is unavailable in this host` });
        const rooted = Object.create(ctx as object, { cwd: { value: scope.value.root } }) as unknown;
        return factory(scope.value.root).execute(id, { ...params, path: searchPath.value }, signal, onUpdate, rooted);
      },
    })),
  ];
}
