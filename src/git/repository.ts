// Canonical repository discovery and protected-target configuration. Radian
// never assumes the protected target is `main`; the target ref is explicit
// configuration, and discovery only reports candidates for the user to choose.

import { realpathSync } from "node:fs";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { succeeded } from "../util/proc.ts";
import { type GitContext, git, gitText, locateGit } from "./exec.ts";

export interface Repository {
  ctx: GitContext;
  /** Canonical top-level of the main working tree. */
  root: string;
  /** Canonical shared Git directory (common dir) — protected from workers. */
  commonDir: string;
  objectFormat: "sha1" | "sha256";
}

export const REF_PATTERN = /^refs\/heads\/[A-Za-z0-9._][A-Za-z0-9._/-]{0,200}$/;

export async function openRepository(path: string, gitPath = locateGit()): Promise<Outcome<Repository>> {
  if (!gitPath) return refuse("GIT_FAILURE", "git executable not found");
  const probe: GitContext = { gitPath, cwd: path };
  try {
    const top = realpathSync(await gitText(probe, ["rev-parse", "--show-toplevel"]));
    const common = realpathSync(await gitText({ gitPath, cwd: top }, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    const format = await gitText({ gitPath, cwd: top }, ["rev-parse", "--show-object-format"]);
    if (format !== "sha1" && format !== "sha256") return refuse("GIT_FAILURE", "unsupported object format");
    const isBare = await gitText({ gitPath, cwd: top }, ["rev-parse", "--is-bare-repository"]);
    if (isBare !== "false") return refuse("GIT_FAILURE", "bare repositories are not supported as projects");
    return success({ ctx: { gitPath, cwd: top, objectFormat: format }, root: top, commonDir: common, objectFormat: format });
  } catch {
    return refuse("GIT_FAILURE", "path is not inside a Git working tree");
  }
}

export async function resolveCommit(repo: Repository, rev: string): Promise<Outcome<string>> {
  if (rev.startsWith("-")) return refuse("GIT_FAILURE", "revision must not look like an option");
  const result = await git(repo.ctx, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]);
  if (!succeeded(result)) return refuse("GIT_FAILURE", "revision does not resolve to a commit");
  return success(result.stdout.toString("utf8").trim());
}

export interface ProtectedTarget {
  ref: string;
}

export function validateTarget(target: ProtectedTarget): Outcome<ProtectedTarget> {
  if (!REF_PATTERN.test(target.ref) || target.ref.includes("..") || target.ref.endsWith(".lock") || target.ref.endsWith("/")) {
    return refuse("CONFIG_INVALID", "protected target must be an explicit refs/heads/<branch> name");
  }
  return success(target);
}

/** Candidate target branches for the user to choose from; never auto-selected. */
export async function suggestTargets(repo: Repository): Promise<string[]> {
  const out = new Set<string>();
  const head = await git(repo.ctx, ["symbolic-ref", "--quiet", "HEAD"]);
  if (succeeded(head)) out.add(head.stdout.toString("utf8").trim());
  const remoteHead = await git(repo.ctx, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (succeeded(remoteHead)) out.add(remoteHead.stdout.toString("utf8").trim().replace(/^refs\/remotes\/origin\//, "refs/heads/"));
  return [...out].filter((ref) => REF_PATTERN.test(ref));
}

export interface WorktreeListing {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  locked: boolean;
}

export async function listWorktrees(repo: Repository): Promise<WorktreeListing[]> {
  const out = await git(repo.ctx, ["worktree", "list", "--porcelain", "-z"]);
  if (!succeeded(out)) return [];
  const entries: WorktreeListing[] = [];
  let current: WorktreeListing | undefined;
  for (const field of out.stdout.toString("utf8").split("\0")) {
    if (field === "") {
      if (current) entries.push(current);
      current = undefined;
      continue;
    }
    const [key, ...rest] = field.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") current = { path: value, detached: false, locked: false };
    else if (current && key === "HEAD") current.head = value;
    else if (current && key === "branch") current.branch = value;
    else if (current && key === "detached") current.detached = true;
    else if (current && key === "locked") current.locked = true;
  }
  if (current) entries.push(current);
  return entries;
}

/** Working-tree cleanliness, including untracked files, without running filters or hooks. */
export async function isClean(ctx: GitContext): Promise<Outcome<boolean>> {
  const status = await git(ctx, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
  if (!succeeded(status)) return refuse("GIT_FAILURE", "cannot read working-tree status");
  return success(status.stdout.length === 0);
}
