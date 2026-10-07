import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { commitFile, git, makeRepository, makeTempDir } from "../../helpers/git-fixtures.ts";
import {
  addWorktree,
  branchExists,
  branchSummary,
  currentBranch,
  deleteBranch,
  gitCommonDir,
  initRepository,
  isClean,
  isRepository,
  mergeBranch,
  removeWorktree,
  runReadOnlyGit,
} from "../../../src/io/git.ts";

function repoWithWorktree() {
  const repo = makeRepository();
  const worktree = path.join(makeTempDir(), "wt");
  return { repo, worktree };
}

test("initRepository creates a repository with one commit on the branch", async () => {
  const directory = makeTempDir();
  await initRepository(directory, "trunk");
  assert.equal(await isRepository(directory), true);
  assert.equal(await currentBranch(directory), "trunk");
  assert.equal(git(directory, "rev-list", "--count", "HEAD"), "1");
});

test("isRepository is false for a plain directory", async () => {
  assert.equal(await isRepository(makeTempDir()), false);
});

test("addWorktree cuts a branch and removeWorktree plus deleteBranch clean up", async () => {
  const { repo, worktree } = repoWithWorktree();
  await addWorktree(repo, { path: worktree, branch: "radian/w1", from: "main" });
  assert.equal(await currentBranch(worktree), "radian/w1");
  assert.equal(await branchExists(repo, "radian/w1"), true);
  writeFileSync(path.join(worktree, "scratch.txt"), "untracked");
  await removeWorktree(repo, worktree);
  await deleteBranch(repo, "radian/w1");
  assert.equal(existsSync(worktree), false);
  assert.equal(await branchExists(repo, "radian/w1"), false);
});

test("removeWorktree tolerates a worktree directory that is already gone", async () => {
  const { repo, worktree } = repoWithWorktree();
  await addWorktree(repo, { path: worktree, branch: "radian/w1", from: "main" });
  git(repo, "worktree", "remove", "--force", worktree);
  await removeWorktree(repo, worktree);
  assert.equal(git(repo, "worktree", "list").split("\n").length, 1);
});

test("gitCommonDir is the main repository's .git", async () => {
  const { repo, worktree } = repoWithWorktree();
  await addWorktree(repo, { path: worktree, branch: "radian/w1", from: "main" });
  assert.equal(await gitCommonDir(worktree), path.join(repo, ".git"));
});

test("isClean ignores nothing: untracked files make a checkout dirty", async () => {
  const repo = makeRepository();
  assert.equal(await isClean(repo), true);
  writeFileSync(path.join(repo, "new.txt"), "x");
  assert.equal(await isClean(repo), false);
});

test("branchSummary counts commits and shows a diff stat", async () => {
  const { repo, worktree } = repoWithWorktree();
  await addWorktree(repo, { path: worktree, branch: "radian/w1", from: "main" });
  commitFile(worktree, "a.txt", "a\n", "add a");
  commitFile(worktree, "b.txt", "b\n", "add b");
  const summary = await branchSummary(repo, { base: "main", branch: "radian/w1" });
  assert.equal(summary.commitCount, 2);
  assert.match(summary.diffStat, /2 files changed/);
});

test("mergeBranch fast-forwards when possible", async () => {
  const { repo, worktree } = repoWithWorktree();
  await addWorktree(repo, { path: worktree, branch: "radian/w1", from: "main" });
  commitFile(worktree, "a.txt", "a\n", "add a");
  assert.equal(await mergeBranch(repo, "radian/w1"), "fast-forward");
  assert.equal(git(repo, "log", "-1", "--format=%s"), "add a");
});

test("mergeBranch creates a merge commit when main moved on", async () => {
  const { repo, worktree } = repoWithWorktree();
  await addWorktree(repo, { path: worktree, branch: "radian/w1", from: "main" });
  commitFile(worktree, "a.txt", "a\n", "add a");
  commitFile(repo, "b.txt", "b\n", "add b on main");
  assert.equal(await mergeBranch(repo, "radian/w1"), "merge-commit");
  assert.equal(git(repo, "rev-list", "--count", "--merges", "HEAD"), "1");
});

test("mergeBranch aborts and throws on a conflict, leaving main untouched", async () => {
  const { repo, worktree } = repoWithWorktree();
  await addWorktree(repo, { path: worktree, branch: "radian/w1", from: "main" });
  commitFile(worktree, "README.md", "theirs\n", "edit on branch");
  commitFile(repo, "README.md", "ours\n", "edit on main");
  const head = git(repo, "rev-parse", "HEAD");
  await assert.rejects(mergeBranch(repo, "radian/w1"), /conflict/i);
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
  assert.equal(await isClean(repo), true);
});

test("runReadOnlyGit allows status, log, diff, and show only", async () => {
  const repo = makeRepository();
  assert.match(await runReadOnlyGit(repo, ["log", "--oneline"]), /initial/);
  await assert.rejects(runReadOnlyGit(repo, ["commit", "-m", "x"]), /read-only/);
  await assert.rejects(runReadOnlyGit(repo, ["diff", "--output=/tmp/x"]), /not allowed/);
  await assert.rejects(runReadOnlyGit(repo, []), /read-only/);
});
