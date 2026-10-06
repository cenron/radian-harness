// Confined file access below a trusted, canonical anchor directory (for
// example the project root). Used for coordinator planning-artifact writes and
// for reading approved artifacts.
//
// Guarantee: the final open is performed with macOS O_NOFOLLOW_ANY, so the
// kernel refuses (ELOOP) if any component of the path — anchor, every parent,
// or the destination — is a symbolic link at the moment of the open. A parent
// or destination replaced by a link after validation therefore cannot redirect
// the write; this does not rely on a check-then-write. The opened destination
// must be a regular file with a single link owned by this user, which refuses
// hard links to files elsewhere; only then is it truncated and written, so a
// refused write changes nothing.
//
// Missing parent directories are created through util/safe-dir.ts: each mkdir
// runs in a helper whose working directory must be exactly the parent inode
// validated by a link-refusing open, and acts on a single name relative to it.
// A parent replaced by a link before that mkdir is detected and nothing is
// created anywhere (W06/F01: earlier versions used a path-based mkdir that
// could create an empty directory at the link's target).
//
// Limits: content replacement is in place (truncate, then write), not an
// atomic rename. Without kernel O_NOFOLLOW_ANY support (non-macOS, or a failed
// self-test) every confined operation is refused rather than downgraded.

import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { ensureDirConfined } from "./safe-dir.ts";
import os from "node:os";
import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { safeRelative } from "../contracts/paths.ts";

/**
 * macOS <sys/fcntl.h>: fail with ELOOP if any path component, including the
 * last, is a symbolic link. (Combining it with O_NOFOLLOW is EINVAL.)
 * O_NONBLOCK keeps a FIFO from blocking the open; non-regular files are refused.
 */
const O_NOFOLLOW_ANY = 0x20000000;
const NOFOLLOW = O_NOFOLLOW_ANY | constants.O_NONBLOCK;

let supported: boolean | undefined;

/** One-time self-test that the kernel enforces O_NOFOLLOW_ANY for this process. */
export function confinedAccessSupported(): boolean {
  if (supported !== undefined) return supported;
  if (process.platform !== "darwin") return (supported = false);
  let dir: string | undefined;
  try {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "radian-nofollow-")));
    mkdirSync(path.join(dir, "real"));
    writeFileSync(path.join(dir, "real", "f"), "");
    symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
    symlinkSync(path.join(dir, "real", "f"), path.join(dir, "file-link"));
    closeSync(openSync(path.join(dir, "real", "f"), constants.O_RDONLY | NOFOLLOW));
    const refusesLink = (file: string): boolean => {
      try {
        closeSync(openSync(file, constants.O_RDONLY | NOFOLLOW));
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ELOOP";
      }
    };
    supported = refusesLink(path.join(dir, "link", "f")) && refusesLink(path.join(dir, "file-link"));
  } catch {
    supported = false;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  return supported;
}

function openNoFollow(file: string, flags: number, mode?: number): Outcome<number> {
  try {
    return success(openSync(file, flags | NOFOLLOW, mode));
  } catch (error) {
    switch ((error as NodeJS.ErrnoException).code) {
      case "ELOOP":
        return refuse("PATH_OUTSIDE_SCOPE", "the path contains a symbolic link; Radian does not follow links here");
      case "ENOTDIR":
        return refuse("PATH_OUTSIDE_SCOPE", "a parent of the path is not a directory");
      case "ENOENT":
        return refuse("PATH_INVALID", "the path does not exist");
      default:
        return refuse("PATH_INVALID", "the path cannot be opened safely");
    }
  }
}

function checkAnchor(anchor: string): Outcome<true> {
  if (!confinedAccessSupported()) {
    return refuse("CONTAINMENT_UNAVAILABLE", "confined file access needs kernel-enforced no-link path resolution (macOS O_NOFOLLOW_ANY)", "Write or review the file yourself; Radian does not fall back to a check-then-write.");
  }
  if (!path.isAbsolute(anchor)) return refuse("PATH_INVALID", "the anchor must be absolute");
  let real: string;
  try {
    real = realpathSync(anchor);
  } catch {
    return refuse("PATH_INVALID", "the anchor cannot be resolved");
  }
  if (real !== anchor) return refuse("PATH_OUTSIDE_SCOPE", "the anchor is not canonical (it contains a link)");
  const fd = openNoFollow(anchor, constants.O_RDONLY | constants.O_DIRECTORY);
  if (!fd.ok) return fd;
  closeSync(fd.value);
  return success(true);
}

export interface ConfinedHooks {
  /** Test seam: runs after parent validation and immediately before the destination open. */
  beforeOpen?: () => void;
}

/**
 * Create or replace `anchor/relative` without following any link. Missing
 * parents are created (mode 0700) one level at a time inside verified parents.
 */
export function writeConfined(anchor: string, relative: string, content: string | Buffer, hooks: ConfinedHooks = {}): Outcome<string> {
  const anchored = checkAnchor(anchor);
  if (!anchored.ok) return anchored;
  if (!safeRelative(relative)) return refuse("PATH_INVALID", "the path must be relative, without '.', '..', or empty components");
  const parts = relative.split("/");
  let dir = anchor;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    let stat;
    try {
      stat = lstatSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return refuse("PATH_INVALID", "a parent directory cannot be inspected");
      // Never a path-based mkdir: the verified-directory helper creates the single missing name.
      const made = ensureDirConfined(anchor, path.relative(anchor, dir).split(path.sep).join("/"), 0o700);
      if (!made.ok) return made;
      try {
        stat = lstatSync(dir);
      } catch {
        return refuse("PATH_INVALID", "a parent directory disappeared");
      }
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return refuse("PATH_OUTSIDE_SCOPE", "a parent of the destination is a link or not a directory");
    const verified = openNoFollow(dir, constants.O_RDONLY | constants.O_DIRECTORY);
    if (!verified.ok) return verified;
    closeSync(verified.value);
  }
  hooks.beforeOpen?.();
  const opened = openNoFollow(path.join(anchor, relative), constants.O_WRONLY | constants.O_CREAT, 0o600);
  if (!opened.ok) return opened;
  const fd = opened.value;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return refuse("PATH_OUTSIDE_SCOPE", "the destination is not a regular file");
    if (stat.nlink !== 1) return refuse("PATH_OUTSIDE_SCOPE", "the destination has other hard links; it may be a file elsewhere");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return refuse("PATH_OUTSIDE_SCOPE", "the destination is owned by another user");
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    fsyncSync(fd);
    return success(path.join(anchor, relative));
  } finally {
    closeSync(fd);
  }
}

/** Read `anchor/relative` as UTF-8 without following any link; regular files only. */
export function readConfined(anchor: string, relative: string): Outcome<string> {
  const anchored = checkAnchor(anchor);
  if (!anchored.ok) return anchored;
  if (!safeRelative(relative)) return refuse("PATH_INVALID", "the path must be relative, without '.', '..', or empty components");
  const opened = openNoFollow(path.join(anchor, relative), constants.O_RDONLY);
  if (!opened.ok) return opened;
  try {
    if (!fstatSync(opened.value).isFile()) return refuse("PATH_OUTSIDE_SCOPE", "the path is not a regular file");
    return success(readFileSync(opened.value, "utf8"));
  } finally {
    closeSync(opened.value);
  }
}
