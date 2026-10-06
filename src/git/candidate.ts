// Exact candidate assembly. Developer and tester deliveries made against the
// same base are combined with `git merge-tree --write-tree` (no checkout, no
// hooks, attribute-driven helpers neutralized) into one single-parent candidate
// commit on that base. Conflicts become a blocker for a developer repair
// assignment; the coordinator does not resolve production semantics.

import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { safeRelative } from "../contracts/paths.ts";
import type { CandidateRef } from "../contracts/records.ts";
import { succeeded } from "../util/proc.ts";
import type { CommitIdentity, Delivery } from "./delivery.ts";
import { git, gitText, splitNul } from "./exec.ts";
import type { Repository } from "./repository.ts";

export interface AssembledCandidate extends CandidateRef {
  ref: string;
  deliveries: string[];
}

const TASK_SEGMENT = /^[a-z][a-z0-9-]{0,15}_[A-Za-z0-9-]{6,64}$/;

function zeroOid(repo: Repository): string {
  return "0".repeat(repo.objectFormat === "sha256" ? 64 : 40);
}

export async function assembleCandidate(input: {
  repo: Repository;
  /** Commit every delivery was made against (the merge base). */
  base: string;
  /**
   * Protected-target commit the candidate is built on. Defaults to `base`. Repair
   * rounds deliver against the previous candidate but the new candidate is a
   * single commit on the unchanged target so integration stays a fast-forward.
   */
  targetBase?: string;
  task: string;
  round: number;
  deliveries: readonly Delivery[];
  identity: CommitIdentity;
  message: string;
}): Promise<Outcome<AssembledCandidate>> {
  const { repo } = input;
  if (!TASK_SEGMENT.test(input.task) || !Number.isInteger(input.round) || input.round < 1) return refuse("IDENTITY_MISMATCH", "candidate identity is malformed");
  if (input.deliveries.length === 0) return refuse("CANDIDATE_MISMATCH", "no deliveries to assemble");
  for (const delivery of input.deliveries) {
    if (delivery.base !== input.base) return refuse("PATCH_BASE_MISMATCH", "a delivery was made against a different base");
    const parent = await gitText(repo.ctx, ["rev-parse", "--verify", `${delivery.commit}^1`]);
    const tree = await gitText(repo.ctx, ["rev-parse", "--verify", `${delivery.commit}^{tree}`]);
    if (parent !== input.base || tree !== delivery.tree) return refuse("CANDIDATE_MISMATCH", "delivery commit does not match its recorded identity");
  }
  let tree = input.deliveries[0]!.tree;
  let accumulated = input.deliveries[0]!.commit;
  for (const next of input.deliveries.slice(1)) {
    const merged = await git(repo.ctx, ["merge-tree", "--write-tree", "--no-messages", "--name-only", `--merge-base=${input.base}`, accumulated, next.commit]);
    if (merged.code === 1) {
      const lines = merged.stdout.toString("utf8").split("\n").slice(1).filter((l) => l.trim() !== "");
      return refuse("CONFLICT", "deliveries conflict; route to a fresh developer repair assignment", "Create a developer repair assignment with the conflicting paths.", { paths: lines.slice(0, 20).join(",").slice(0, 500) });
    }
    if (!succeeded(merged)) return refuse("GIT_FAILURE", "candidate assembly failed");
    tree = merged.stdout.toString("utf8").split("\n")[0]!.trim();
    accumulated = await gitText(repo.ctx, ["commit-tree", tree, "-p", input.base, "-m", "radian: intermediate assembly"], {
      env: { GIT_AUTHOR_NAME: input.identity.name, GIT_AUTHOR_EMAIL: input.identity.email, GIT_COMMITTER_NAME: input.identity.name, GIT_COMMITTER_EMAIL: input.identity.email },
    });
  }
  const parent = input.targetBase ?? input.base;
  if (input.targetBase && input.targetBase !== input.base) {
    const ancestor = await git(repo.ctx, ["merge-base", "--is-ancestor", input.targetBase, input.base]);
    if (!succeeded(ancestor)) return refuse("TARGET_DRIFT", "the repair base does not descend from the target base");
  }
  const body = [input.message, "", `Radian-Task: ${input.task}`, `Radian-Round: ${input.round}`, ...input.deliveries.map((d) => `Radian-Delivery: ${d.commit}`), ""].join("\n");
  const commit = await gitText(repo.ctx, ["commit-tree", tree, "-p", parent, "-F", "-"], {
    input: body,
    env: { GIT_AUTHOR_NAME: input.identity.name, GIT_AUTHOR_EMAIL: input.identity.email, GIT_COMMITTER_NAME: input.identity.name, GIT_COMMITTER_EMAIL: input.identity.email },
  });
  const existing = await git(repo.ctx, ["for-each-ref", "--format=%(refname)", `refs/radian/candidates/${input.task}/`]);
  const count = succeeded(existing) ? existing.stdout.toString("utf8").split("\n").filter(Boolean).length : 0;
  const ref = `refs/radian/candidates/${input.task}/r${input.round}-${count + 1}`;
  const created = await git(repo.ctx, ["update-ref", ref, commit, zeroOid(repo)]);
  if (!succeeded(created)) return refuse("GIT_FAILURE", "candidate ref could not be created");
  return success({ commit, tree, base: parent, ref, deliveries: input.deliveries.map((d) => d.commit) });
}

/** Confirm a commit is exactly the recorded candidate (tree and single parent). */
export async function verifyCandidate(repo: Repository, candidate: CandidateRef): Promise<Outcome<true>> {
  try {
    const tree = await gitText(repo.ctx, ["rev-parse", "--verify", `${candidate.commit}^{tree}`]);
    const parents = (await gitText(repo.ctx, ["rev-list", "--parents", "-n", "1", candidate.commit])).split(" ").slice(1);
    if (tree !== candidate.tree || parents.length !== 1 || parents[0] !== candidate.base) return refuse("CANDIDATE_MISMATCH", "commit does not match the recorded candidate");
    return success(true);
  } catch {
    return refuse("CANDIDATE_MISMATCH", "candidate commit is unavailable");
  }
}

/**
 * Output roots for an exact-candidate check must hold no tracked content in the
 * candidate, so making them writable cannot change source, tests, or config.
 */
export async function validateCheckOutputRoots(repo: Repository, commit: string, roots: readonly string[]): Promise<Outcome<true>> {
  for (const root of roots) {
    if (!safeRelative(root) || root.split("/")[0] === ".git") return refuse("PATH_INVALID", "check output roots must be repository-relative directories");
    const listed = await git(repo.ctx, ["ls-tree", "-r", "-z", "--name-only", commit, "--", root]);
    if (!succeeded(listed)) return refuse("GIT_FAILURE", "candidate tree could not be listed");
    if (listed.stdout.length > 0) return refuse("PATH_OUTSIDE_SCOPE", `check output root '${root}' contains tracked candidate files`, "Declare an untracked build/output directory instead.");
  }
  return success(true);
}

/**
 * After a contained check, confirm its checkout still holds exactly the
 * candidate: HEAD and tree match, nothing tracked changed, and untracked or
 * ignored content exists only under the declared output roots. Uses controlled
 * Git only (no hooks, filters, textconv, or fsmonitor); never runs candidate code.
 */
export async function verifyCheckout(repo: Repository, worktreePath: string, candidate: CandidateRef, outputRoots: readonly string[]): Promise<Outcome<true>> {
  const ctx = { ...repo.ctx, cwd: worktreePath };
  const head = await git(ctx, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]);
  const tree = await git(ctx, ["rev-parse", "--verify", "--end-of-options", "HEAD^{tree}"]);
  if (!succeeded(head) || !succeeded(tree)) return refuse("CANDIDATE_MISMATCH", "the check checkout's revision cannot be read");
  if (head.stdout.toString("utf8").trim() !== candidate.commit || tree.stdout.toString("utf8").trim() !== candidate.tree) {
    return refuse("CANDIDATE_MISMATCH", "the check checkout is not at the exact candidate");
  }
  const status = await git(ctx, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored=matching", "--no-renames", "--ignore-submodules=dirty"]);
  if (!succeeded(status)) return refuse("CANDIDATE_MISMATCH", "the check checkout's status cannot be read");
  const inOutput = (p: string) => outputRoots.some((root) => p === root || p.startsWith(`${root}/`));
  let changed = 0;
  for (const record of splitNul(status.stdout)) {
    if (record.startsWith("? ") || record.startsWith("! ")) {
      if (!inOutput(record.slice(2).replace(/\/$/, ""))) changed += 1;
    } else {
      changed += 1;
    }
  }
  if (changed > 0) return refuse("CANDIDATE_MISMATCH", `the check checkout changed outside its declared output roots (${changed} path(s)); its results are not evidence for the candidate`);
  return success(true);
}
