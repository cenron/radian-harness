// Namespace-safe file and directory mutation below a trusted, canonical anchor
// (a workspace or project root). Used wherever Radian creates directories or
// replaces/removes files that a link substitution could otherwise redirect:
// installation, project bootstrap, and private workspace state.
//
// Guarantees:
// - Content opens use macOS O_NOFOLLOW_ANY, so the kernel refuses a path in
//   which any component is a symbolic link at open time.
// - Name-space operations (mkdir, rename, unlink, rmdir) never re-resolve a
//   parent path after validation. The parent is validated with a link-refusing
//   open whose device/inode is recorded; a short-lived child helper
//   (safe-dir-main.ts) starts in that directory, refuses unless its working
//   directory is exactly that inode, and operates on single names relative to
//   it. A parent replaced by a link before the helper starts is therefore
//   detected before anything changes, and a refusal leaves outside files and
//   directory namespace unchanged. If the directory is moved while the helper
//   runs, directories it created are removed again and the operation reports
//   failure.
// - Without kernel O_NOFOLLOW_ANY support (non-macOS or a failed self-test)
//   every operation is refused; there is no check-then-act fallback.
//
// Limits: a concurrent writer can still change files *inside* the validated
// directories (which belong to the user); that is ordinary concurrent
// editing, not an escape. Each name-space step starts one Node process.

import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { safeRelative } from "../contracts/paths.ts";
import { confinedAccessSupported } from "./confined-fs.ts";

const O_NOFOLLOW_ANY = 0x20000000;
const NOFOLLOW = O_NOFOLLOW_ANY | constants.O_NONBLOCK;
const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "safe-dir-main.ts");

export type SafeOp =
  | { op: "mkdir"; name: string; mode: number }
  | { op: "rename"; from: string; to: string }
  | { op: "unlink"; name: string }
  | { op: "rmdir"; name: string }
  | { op: "spawn"; file: string; argv: string[]; env: Record<string, string>; input?: string };

export interface SpawnOutput {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface SafeDirHooks {
  /** Test seam: runs after the parent directory was validated and immediately before the helper acts on it. */
  beforeMutate?: (dir: string, ops: readonly SafeOp[]) => void;
}

function errnoBlocker(error: unknown, what: string): Outcome<never> {
  switch ((error as NodeJS.ErrnoException).code) {
    case "ELOOP":
      return refuse("PATH_OUTSIDE_SCOPE", `${what}: the path contains a symbolic link; Radian does not follow links here`);
    case "ENOTDIR":
      return refuse("PATH_OUTSIDE_SCOPE", `${what}: a parent is not a directory`);
    case "ENOENT":
      return refuse("PATH_INVALID", `${what}: the path does not exist`);
    case "EEXIST":
      return refuse("PATH_INVALID", `${what}: the path already exists`);
    default:
      return refuse("PATH_INVALID", `${what}: the path cannot be used safely`);
  }
}

function anchorOk(anchor: string): Outcome<true> {
  if (!confinedAccessSupported()) return refuse("CONTAINMENT_UNAVAILABLE", "safe file operations need kernel-enforced no-link path resolution (macOS O_NOFOLLOW_ANY)", "Make the change yourself; Radian does not fall back to a check-then-write.");
  if (!path.isAbsolute(anchor) || path.resolve(anchor) !== anchor) return refuse("PATH_INVALID", "the anchor must be an absolute, normalized path");
  return success(true);
}

/** Validate a directory without following links; returns its exact identity. */
export function verifiedDirIdentity(dir: string): Outcome<{ dev: string; ino: string }> {
  let fd: number;
  try {
    fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW);
  } catch (error) {
    return errnoBlocker(error, "directory");
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    return success({ dev: String(st.dev), ino: String(st.ino) });
  } finally {
    closeSync(fd);
  }
}

/**
 * Perform single-name operations (or a program run) inside `dir` only if it is
 * still the directory that was validated — and, when `expected` is given, the
 * exact directory identity recorded earlier (for example when it was created).
 */
export function opsInVerifiedDir(dir: string, ops: readonly SafeOp[], hooks: SafeDirHooks = {}, expected?: { dev: string; ino: string }): Outcome<true> {
  const ran = runInVerifiedDir(dir, ops, hooks, expected);
  return ran.ok ? success(true) : ran;
}

export function runInVerifiedDir(dir: string, ops: readonly SafeOp[], hooks: SafeDirHooks = {}, expected?: { dev: string; ino: string }): Outcome<SpawnOutput[]> {
  if (!confinedAccessSupported()) return refuse("CONTAINMENT_UNAVAILABLE", "safe file operations need kernel-enforced no-link path resolution (macOS O_NOFOLLOW_ANY)");
  const id = verifiedDirIdentity(dir);
  if (!id.ok) return id;
  if (expected && (expected.dev !== id.value.dev || expected.ino !== id.value.ino)) return refuse("PATH_OUTSIDE_SCOPE", "the directory is not the one Radian created or validated earlier; nothing was changed");
  hooks.beforeMutate?.(dir, ops);
  const result = spawnSync(process.execPath, [HELPER, id.value.dev, id.value.ino, dir, JSON.stringify(ops)], { cwd: dir, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 20_000 });
  if (result.error) {
    return (result.error as NodeJS.ErrnoException).code === "ENOENT" ? refuse("PATH_OUTSIDE_SCOPE", "the directory changed before it could be used; nothing was changed") : refuse("PATH_INVALID", "the safe file helper could not start");
  }
  let parsed: { ok?: boolean; code?: string; errno?: string; outputs?: SpawnOutput[] } = {};
  try {
    parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as typeof parsed;
  } catch {
    parsed = {};
  }
  if (result.status === 0 && parsed.ok === true) return success(parsed.outputs ?? []);
  if (parsed.code === "spawn-failed") return refuse("GIT_FAILURE", `a controlled command failed: ${(parsed.outputs?.at(-1)?.stderr ?? "").trim().split("\n")[0] ?? ""}`.trim());
  if (parsed.code === "substituted") return refuse("PATH_OUTSIDE_SCOPE", "the directory was replaced (for example by a link) after validation; nothing was changed");
  if (parsed.code === "moved") return refuse("PATH_OUTSIDE_SCOPE", "the directory moved during the operation; created directories were removed");
  if (parsed.code === "op-failed") return errnoBlocker({ code: parsed.errno }, "file operation");
  return refuse("PATH_INVALID", "the safe file operation did not complete");
}

/** Create `anchor/relativeDir` (and missing parents) without following or creating through links. */
export function ensureDirConfined(anchor: string, relativeDir: string, mode = 0o700, hooks: SafeDirHooks = {}): Outcome<string> {
  const ok = anchorOk(anchor);
  if (!ok.ok) return ok;
  const top = verifiedDirIdentity(anchor);
  if (!top.ok) return top;
  if (relativeDir === "" || relativeDir === ".") return success(anchor);
  if (!safeRelative(relativeDir)) return refuse("PATH_INVALID", "the directory must be relative, without '.', '..', or empty components");
  let dir = anchor;
  for (const part of relativeDir.split("/")) {
    const next = path.join(dir, part);
    const existing = verifiedDirIdentity(next);
    if (!existing.ok) {
      if (existing.blocker.code !== "PATH_INVALID" || !/does not exist/.test(existing.blocker.message)) return existing;
      const made = opsInVerifiedDir(dir, [{ op: "mkdir", name: part, mode }], hooks);
      if (!made.ok && !/already exists/.test(made.blocker.message)) return made;
      const after = verifiedDirIdentity(next);
      if (!after.ok) return after;
    }
    dir = next;
  }
  return success(dir);
}

/** Read `anchor/relative` without following links; undefined when absent. */
export function readFileConfinedBytes(anchor: string, relative: string): Outcome<Buffer | undefined> {
  const ok = anchorOk(anchor);
  if (!ok.ok) return ok;
  if (!safeRelative(relative)) return refuse("PATH_INVALID", "the path must be relative, without '.', '..', or empty components");
  let fd: number;
  try {
    fd = openSync(path.join(anchor, relative), constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return success(undefined);
    return errnoBlocker(error, relative);
  }
  try {
    if (!fstatSync(fd).isFile()) return refuse("PATH_OUTSIDE_SCOPE", `${relative} is not a regular file`);
    return success(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
}

/**
 * Atomically create or replace `anchor/relative`: missing parents are created
 * safely, the content is written to a temporary file opened without following
 * links, and the rename happens inside the verified parent directory.
 */
export function writeFileAtomicConfined(anchor: string, relative: string, content: string | Buffer, options: { mode?: number; dirMode?: number; hooks?: SafeDirHooks } = {}): Outcome<string> {
  const ok = anchorOk(anchor);
  if (!ok.ok) return ok;
  if (!safeRelative(relative)) return refuse("PATH_INVALID", "the path must be relative, without '.', '..', or empty components");
  const parts = relative.split("/");
  const name = parts.pop()!;
  const parent = ensureDirConfined(anchor, parts.join("/"), options.dirMode ?? 0o700, options.hooks ?? {});
  if (!parent.ok) return parent;
  const existing = readFileConfinedBytes(anchor, relative);
  if (!existing.ok) return existing;
  const temp = `.${name}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number;
  try {
    fd = openSync(path.join(parent.value, temp), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, options.mode ?? 0o600);
  } catch (error) {
    return errnoBlocker(error, relative);
  }
  try {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const renamed = opsInVerifiedDir(parent.value, [{ op: "rename", from: temp, to: name }], options.hooks ?? {});
  if (!renamed.ok) {
    opsInVerifiedDir(parent.value, [{ op: "unlink", name: temp }]);
    return renamed;
  }
  return success(path.join(anchor, relative));
}

/** Remove the regular file `anchor/relative` without following links; absent is success. */
export function removeFileConfined(anchor: string, relative: string, hooks: SafeDirHooks = {}): Outcome<true> {
  const existing = readFileConfinedBytes(anchor, relative);
  if (!existing.ok) return existing;
  if (existing.value === undefined) return success(true);
  const parts = relative.split("/");
  const name = parts.pop()!;
  return opsInVerifiedDir(path.join(anchor, ...parts), [{ op: "unlink", name }], hooks);
}
