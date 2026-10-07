import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RadianError } from "../core/errors.ts";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const READ_ONLY_COMMANDS = ["status", "log", "diff", "show"];
// These options make read-only commands write files or run external programs.
const FORBIDDEN_OPTIONS = /^--(output|ext-diff|textconv)/;

export type MergeKind = "fast-forward" | "merge-commit";

export interface BranchSummary {
  commitCount: number;
  diffStat: string;
}

export async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: MAX_OUTPUT_BYTES });
    return stdout;
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim() || (error as Error).message;
    throw new RadianError("git_failed", `git ${args[0] ?? ""} failed: ${detail}`);
  }
}

export async function isRepository(directory: string): Promise<boolean> {
  try {
    return (await runGit(directory, ["rev-parse", "--show-toplevel"])).trim().length > 0;
  } catch (_error) {
    return false;
  }
}

/** A new repository with an empty first commit, so worker branches have something to start from. */
export async function initRepository(directory: string, branch: string): Promise<void> {
  await runGit(directory, ["init", "-q", "-b", branch]);
  await runGit(directory, ["commit", "-q", "--allow-empty", "-m", "Initial commit"]);
}

export async function currentBranch(repo: string): Promise<string> {
  return (await runGit(repo, ["branch", "--show-current"])).trim();
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await runGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch (_error) {
    return false;
  }
}

export async function isClean(repo: string): Promise<boolean> {
  return (await uncommittedFiles(repo)).length === 0;
}

/** Changed and untracked files, one short status line each, for example "M README.md". */
export async function uncommittedFiles(repo: string): Promise<string[]> {
  const status = await runGit(repo, ["status", "--porcelain"]);
  return status
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Commits every change in the checkout; false when there was nothing to commit. */
export async function commitAll(repo: string, message: string): Promise<boolean> {
  if (await isClean(repo)) return false;
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "-q", "-m", message]);
  return true;
}

export async function addWorktree(
  repo: string,
  worktree: { path: string; branch: string; from: string },
): Promise<void> {
  await runGit(repo, [
    "worktree",
    "add",
    "-q",
    "-b",
    worktree.branch,
    worktree.path,
    worktree.from,
  ]);
}

/** Removes the worktree even with untracked files; callers ask the user before unmerged work is lost. */
export async function removeWorktree(repo: string, worktreePath: string): Promise<void> {
  try {
    await runGit(repo, ["worktree", "remove", "--force", worktreePath]);
  } catch (_error) {
    // The directory may already be gone; pruning drops git's record of it.
    await runGit(repo, ["worktree", "prune"]);
  }
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await runGit(repo, ["branch", "-q", "-D", branch]);
}

export async function branchSummary(
  repo: string,
  range: { base: string; branch: string },
): Promise<BranchSummary> {
  const count = await runGit(repo, ["rev-list", "--count", `${range.base}..${range.branch}`]);
  const diffStat = await runGit(repo, ["diff", "--stat", `${range.base}...${range.branch}`]);
  return { commitCount: Number(count.trim()), diffStat: diffStat.trimEnd() };
}

/** Commits on this branch that no other branch has; robust when the branch's base is gone. */
export async function countOwnCommits(repo: string, branch: string): Promise<number> {
  const count = await runGit(repo, [
    "rev-list",
    "--count",
    branch,
    "--not",
    `--exclude=${branch}`,
    "--branches",
  ]);
  return Number(count.trim());
}

/** Merges into the checked-out branch; a conflicted merge is aborted so the checkout is unchanged. */
export async function mergeBranch(repo: string, branch: string): Promise<MergeKind> {
  try {
    await runGit(repo, ["merge", "-q", "--ff-only", branch]);
    return "fast-forward";
  } catch (_error) {
    // Not a fast-forward; fall through to a merge commit.
  }
  try {
    await runGit(repo, ["merge", "-q", "--no-edit", branch]);
    return "merge-commit";
  } catch (error) {
    await abortMerge(repo);
    throw new RadianError(
      "merge_conflict",
      `Merging ${branch} hit a conflict, so the merge was aborted. ${(error as Error).message}`,
    );
  }
}

export async function runReadOnlyGit(repo: string, args: readonly string[]): Promise<string> {
  const [command, ...rest] = args;
  if (!command || !READ_ONLY_COMMANDS.includes(command)) {
    throw new RadianError(
      "git_not_read_only",
      `Only read-only git commands are allowed: ${READ_ONLY_COMMANDS.join(", ")}.`,
    );
  }
  const forbidden = rest.find((arg) => FORBIDDEN_OPTIONS.test(arg));
  if (forbidden)
    throw new RadianError("git_option_forbidden", `The git option ${forbidden} is not allowed.`);
  const safety = command === "status" ? [] : ["--no-ext-diff", "--no-textconv"];
  return runGit(repo, ["--no-pager", command, ...safety, ...rest]);
}

async function abortMerge(repo: string): Promise<void> {
  try {
    await runGit(repo, ["merge", "--abort"]);
  } catch (_error) {
    // No merge in progress (for example an unknown branch): nothing to undo.
  }
}
