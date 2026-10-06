// Controlled change delivery. Workers deliver files in their worktree or a patch
// file; Radian (not the worker) builds the commit with plumbing commands, a
// temporary index, and no hooks, filters, or attribute-driven helpers. Every
// changed path must lie inside the assignment's write roots, and the delivery is
// bound to the exact base and attempt identity. Nothing from the candidate runs.

import { lstatSync, readlinkSync } from "node:fs";
import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { safeRelative } from "../contracts/paths.ts";
import { succeeded } from "../util/proc.ts";
import { type GitContext, git, gitOk, gitText, splitNul } from "./exec.ts";
import { type Repository, resolveCommit } from "./repository.ts";

export interface CommitIdentity {
  name: string;
  email: string;
}

export interface Delivery {
  assignment: string;
  attempt: string;
  base: string;
  commit: string;
  tree: string;
  paths: string[];
  ref: string;
}

export interface DeliveryScope {
  /** Repository-relative directories or files the assignment may change ("" = whole tree). */
  writeRoots: readonly string[];
}

export function inScope(relative: string, scope: DeliveryScope): boolean {
  if (!safeRelative(relative)) return false;
  return scope.writeRoots.some((root) => root === "" || relative === root || relative.startsWith(root.endsWith("/") ? root : root + "/"));
}

export function safeSymlinkTarget(linkPath: string, target: string): boolean {
  if (target === "" || path.isAbsolute(target) || target.includes("\0")) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(linkPath), target));
  return !(resolved === ".." || resolved.startsWith("../"));
}

function identityEnv(identity: CommitIdentity): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

function zeroOid(repo: Repository): string {
  return "0".repeat(repo.objectFormat === "sha256" ? 64 : 40);
}

const ID_SEGMENT = /^[a-z][a-z0-9-]{0,15}_[A-Za-z0-9-]{6,64}$/;

export interface ChangedPath {
  path: string;
  deleted: boolean;
}

/** Parse `git status --porcelain=v2 -z --no-renames` output into changed paths. */
export function parseStatus(buffer: Buffer): Outcome<ChangedPath[]> {
  const out: ChangedPath[] = [];
  for (const record of splitNul(buffer)) {
    const kind = record[0];
    if (kind === "?") {
      out.push({ path: record.slice(2), deleted: false });
    } else if (kind === "1") {
      const parts = record.split(" ");
      const xy = parts[1] ?? "..";
      const modes = [parts[3], parts[4], parts[5]];
      if (modes.includes("160000")) return refuse("PATCH_OUT_OF_SCOPE", "submodule changes are not deliverable");
      out.push({ path: parts.slice(8).join(" "), deleted: xy.includes("D") });
    } else if (kind === "2" || kind === "u") {
      return refuse("CONFLICT", "worktree has renames or unmerged entries; deliver plain file changes");
    } else if (kind === "!") {
      continue;
    } else {
      return refuse("GIT_FAILURE", "unrecognized status record");
    }
  }
  return success(out);
}

async function commitTree(repo: Repository, env: Record<string, string>, base: string, delivery: { assignment: string; attempt: string }, message: string, identity: CommitIdentity): Promise<Outcome<{ tree: string; commit: string; ref: string }>> {
  const tree = await gitText(repo.ctx, ["write-tree"], { env });
  const body = `${message}\n\nRadian-Assignment: ${delivery.assignment}\nRadian-Attempt: ${delivery.attempt}\n`;
  const commit = await gitText(repo.ctx, ["commit-tree", tree, "-p", base, "-F", "-"], { env: { ...env, ...identityEnv(identity) }, input: body });
  const ref = `refs/radian/deliveries/${delivery.assignment}/${delivery.attempt}`;
  const created = await git(repo.ctx, ["update-ref", "--create-reflog", ref, commit, zeroOid(repo)]);
  if (!succeeded(created)) return refuse("GIT_FAILURE", "delivery ref already exists or could not be created");
  return success({ tree, commit, ref });
}

async function checkSymlinks(repo: Repository, tree: string, paths: readonly string[]): Promise<Outcome<true>> {
  if (paths.length === 0) return success(true);
  const listing = await gitOk(repo.ctx, ["ls-tree", "-z", tree, "--", ...paths]);
  for (const record of splitNul(listing)) {
    const tab = record.indexOf("\t");
    const [mode, , oid] = record.slice(0, tab).split(" ");
    const file = record.slice(tab + 1);
    if (mode === "160000") return refuse("PATCH_OUT_OF_SCOPE", "submodule entries are not deliverable");
    if (mode === "120000" && oid) {
      const target = (await gitOk(repo.ctx, ["cat-file", "blob", oid])).toString("utf8");
      if (!safeSymlinkTarget(file, target)) return refuse("PATCH_OUT_OF_SCOPE", "delivered symlink points outside the repository");
    }
  }
  return success(true);
}

export interface WorktreeDeliveryInput {
  repo: Repository;
  worktreePath: string;
  expectedBase: string;
  scope: DeliveryScope;
  assignment: string;
  attempt: string;
  message: string;
  identity: CommitIdentity;
  /** Private scratch directory for the temporary index. */
  scratchDir: string;
}

export async function deliverFromWorktree(input: WorktreeDeliveryInput): Promise<Outcome<Delivery>> {
  const { repo } = input;
  if (!ID_SEGMENT.test(input.assignment) || !ID_SEGMENT.test(input.attempt)) return refuse("IDENTITY_MISMATCH", "delivery identity is malformed");
  const wt: GitContext = { ...repo.ctx, cwd: input.worktreePath };
  let head: string;
  try {
    head = await gitText(wt, ["rev-parse", "--verify", "HEAD^{commit}"]);
  } catch {
    return refuse("GIT_FAILURE", "worktree HEAD is unreadable");
  }
  if (head !== input.expectedBase) return refuse("PATCH_BASE_MISMATCH", "worktree is not at the assignment's base commit");
  const status = await git(wt, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none"]);
  if (!succeeded(status)) return refuse("GIT_FAILURE", "cannot read worktree status");
  const changed = parseStatus(status.stdout);
  if (!changed.ok) return changed;
  for (const c of changed.value) {
    if (!inScope(c.path, input.scope)) return refuse("PATCH_OUT_OF_SCOPE", "a changed path is outside the assignment's write scope", "Ask the coordinator for a scope decision.", { path: c.path.slice(0, 200) });
  }

  const env = { GIT_INDEX_FILE: path.join(input.scratchDir, `delivery-${input.attempt}.index`) };
  await gitOk(repo.ctx, ["read-tree", input.expectedBase], { env });
  const lines: string[] = [];
  const files: Array<{ path: string; mode: string }> = [];
  for (const c of changed.value) {
    const absolute = path.join(input.worktreePath, c.path);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      lines.push(`0 ${zeroOid(repo)}\t${c.path}`);
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      if (!safeSymlinkTarget(c.path, target)) return refuse("PATCH_OUT_OF_SCOPE", "a symlink points outside the repository", undefined, { path: c.path.slice(0, 200) });
      const oid = await gitText(repo.ctx, ["hash-object", "-w", "--stdin"], { input: target });
      lines.push(`120000 ${oid}\t${c.path}`);
    } else if (stat.isFile()) {
      files.push({ path: c.path, mode: stat.mode & 0o111 ? "100755" : "100644" });
    } else {
      return refuse("PATCH_OUT_OF_SCOPE", "only regular files and safe symlinks are deliverable", undefined, { path: c.path.slice(0, 200) });
    }
  }
  if (files.length > 0) {
    const oids = (await gitText(repo.ctx, ["hash-object", "-w", "--no-filters", "--stdin-paths"], { input: files.map((f) => path.join(input.worktreePath, f.path)).join("\n") + "\n" })).split("\n");
    if (oids.length !== files.length) return refuse("GIT_FAILURE", "object hashing returned an unexpected count");
    files.forEach((f, i) => lines.push(`${f.mode} ${oids[i]}\t${f.path}`));
  }
  if (lines.length > 0) await gitOk(repo.ctx, ["update-index", "-z", "--index-info"], { env, input: lines.join("\0") + "\0" });
  const made = await commitTree(repo, env, input.expectedBase, input, input.message, input.identity);
  if (!made.ok) return made;
  return success({ assignment: input.assignment, attempt: input.attempt, base: input.expectedBase, commit: made.value.commit, tree: made.value.tree, paths: changed.value.map((c) => c.path), ref: made.value.ref });
}

export interface PatchDeliveryInput {
  repo: Repository;
  patchFile: string;
  expectedBase: string;
  scope: DeliveryScope;
  assignment: string;
  attempt: string;
  message: string;
  identity: CommitIdentity;
  scratchDir: string;
}

/** Parse `git apply --numstat -z` output (renames list old and new paths). */
export function parseNumstat(buffer: Buffer): string[] {
  const fields = buffer.toString("utf8").split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]!;
    if (field === "") continue;
    const parts = field.split("\t");
    if (parts.length === 3 && parts[2] === "") {
      // rename/copy: the next two fields are the old and new paths
      paths.push(fields[i + 1] ?? "", fields[i + 2] ?? "");
      i += 2;
    } else if (parts.length >= 3) {
      paths.push(parts.slice(2).join("\t"));
    }
  }
  return paths.filter((p) => p !== "");
}

export async function deliverPatch(input: PatchDeliveryInput): Promise<Outcome<Delivery>> {
  const { repo } = input;
  if (!ID_SEGMENT.test(input.assignment) || !ID_SEGMENT.test(input.attempt)) return refuse("IDENTITY_MISMATCH", "delivery identity is malformed");
  try {
    const stat = lstatSync(input.patchFile);
    if (!stat.isFile()) return refuse("RESULT_INVALID", "patch must be a regular file");
  } catch {
    return refuse("RESULT_INVALID", "patch file is missing");
  }
  const base = await resolveCommit(repo, input.expectedBase);
  if (!base.ok || base.value !== input.expectedBase) return refuse("PATCH_BASE_MISMATCH", "base commit is unknown");
  const numstat = await git(repo.ctx, ["apply", "--numstat", "-z", "--", input.patchFile]);
  if (!succeeded(numstat)) return refuse("PATCH_BASE_MISMATCH", "patch cannot be parsed");
  const paths = parseNumstat(numstat.stdout);
  for (const p of paths) {
    if (!inScope(p, input.scope)) return refuse("PATCH_OUT_OF_SCOPE", "patch touches a path outside the assignment's write scope", undefined, { path: p.slice(0, 200) });
  }
  const env = { GIT_INDEX_FILE: path.join(input.scratchDir, `patch-${input.attempt}.index`) };
  await gitOk(repo.ctx, ["read-tree", input.expectedBase], { env });
  const applied = await git(repo.ctx, ["apply", "--cached", "--whitespace=nowarn", "--", input.patchFile], { env });
  if (!succeeded(applied)) return refuse("PATCH_BASE_MISMATCH", "patch does not apply to the assignment's base");
  const tree = await gitText(repo.ctx, ["write-tree"], { env });
  const symlinks = await checkSymlinks(repo, tree, paths);
  if (!symlinks.ok) return symlinks;
  const made = await commitTree(repo, env, input.expectedBase, input, input.message, input.identity);
  if (!made.ok) return made;
  return success({ assignment: input.assignment, attempt: input.attempt, base: input.expectedBase, commit: made.value.commit, tree: made.value.tree, paths, ref: made.value.ref });
}
