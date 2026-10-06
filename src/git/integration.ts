// Controlled fast-forward integration of the exact approved, verified, reviewed
// candidate. Nothing from the candidate executes here. The target must still be
// at the candidate's base, any checkout of the target must be clean, and the ref
// update is compare-and-swap. Drift, dirt, or evidence gaps refuse; nothing is
// stashed, rebased, squashed, reset, or cherry-picked.

import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import type { CandidateRef, CheckEvidence, TargetRef } from "../contracts/records.ts";
import { succeeded } from "../util/proc.ts";
import { verifyCandidate } from "./candidate.ts";
import { git } from "./exec.ts";
import { type ProtectedTarget, type Repository, isClean, listWorktrees, resolveCommit, validateTarget } from "./repository.ts";

export interface IntegrationEvidence {
  requiredChecks: readonly string[];
  checks: readonly CheckEvidence[];
  review: { candidate: string; blockingFindings: number; outcome: "completed" | "blocked" | "failed" | "cancelled" };
}

export interface IntegrationRequest {
  repo: Repository;
  target: ProtectedTarget;
  candidate: CandidateRef;
  evidence: IntegrationEvidence;
  /** Re-validates the human integration approval against the current target. */
  approval: (current: TargetRef) => Outcome<unknown>;
}

export function evidenceCovers(candidate: string, evidence: IntegrationEvidence): Outcome<true> {
  for (const id of evidence.requiredChecks) {
    const matching = evidence.checks.filter((c) => c.id === id && c.candidate === candidate);
    if (matching.length === 0) return refuse("CANDIDATE_MISMATCH", `required check '${id}' has no evidence for this exact candidate`);
    if (matching.some((c) => c.outcome !== "passed")) return refuse("CANDIDATE_MISMATCH", `required check '${id}' did not pass on this candidate`);
  }
  if (evidence.review.candidate !== candidate) return refuse("CANDIDATE_MISMATCH", "review covered a different candidate revision");
  if (evidence.review.outcome !== "completed" || evidence.review.blockingFindings > 0) return refuse("CANDIDATE_MISMATCH", "review did not complete without blocking findings");
  return success(true);
}

export async function integrateCandidate(request: IntegrationRequest): Promise<Outcome<{ from: string; to: string; checkout?: string }>> {
  const { repo, candidate } = request;
  const target = validateTarget(request.target);
  if (!target.ok) return target;
  const exact = await verifyCandidate(repo, candidate);
  if (!exact.ok) return exact;
  const evidence = evidenceCovers(candidate.commit, request.evidence);
  if (!evidence.ok) return evidence;

  const head = await resolveCommit(repo, target.value.ref);
  if (!head.ok) return refuse("TARGET_DRIFT", "protected target does not resolve");
  if (head.value !== candidate.base) {
    return refuse("TARGET_DRIFT", "target moved since the candidate was assembled", "Reassemble and reverify on the new target, then request renewed approval.");
  }
  const approval = request.approval({ ref: target.value.ref, commit: head.value });
  if (!approval.ok) return approval;

  const checkouts = (await listWorktrees(repo)).filter((w) => w.branch === target.value.ref);
  if (checkouts.length > 1) return refuse("OWNERSHIP_AMBIGUOUS", "target branch is checked out in more than one worktree");
  const checkout = checkouts[0];
  if (checkout) {
    if (checkout.locked) return refuse("TARGET_DIRTY", "target checkout is locked");
    const clean = await isClean({ ...repo.ctx, cwd: checkout.path });
    if (!clean.ok) return clean;
    if (!clean.value) return refuse("TARGET_DIRTY", "target checkout has local changes or untracked files", "Preserve or commit those changes yourself, then retry; Radian never stashes or discards them.");
    // Two-tree read-tree updates index and files only if no local change would be lost.
    const updated = await git({ ...repo.ctx, cwd: checkout.path }, ["read-tree", "-m", "-u", head.value, candidate.commit]);
    if (!succeeded(updated)) return refuse("TARGET_DIRTY", "checkout could not be fast-forwarded safely");
  }
  const moved = await git(repo.ctx, ["update-ref", "-m", "radian: integrate approved candidate", target.value.ref, candidate.commit, head.value]);
  if (!succeeded(moved)) {
    if (checkout) {
      // Restore the checkout's files to the unchanged target; the ref did not move.
      await git({ ...repo.ctx, cwd: checkout.path }, ["read-tree", "-m", "-u", candidate.commit, head.value]);
    }
    return refuse("TARGET_DRIFT", "target changed during integration; nothing was integrated");
  }
  const after = await resolveCommit(repo, target.value.ref);
  if (!after.ok || after.value !== candidate.commit) return refuse("TARGET_DRIFT", "post-integration target does not match the candidate");
  if (checkout) {
    const clean = await isClean({ ...repo.ctx, cwd: checkout.path });
    if (!clean.ok || !clean.value) return refuse("TARGET_DIRTY", "target checkout is not clean after integration; inspect it before continuing");
    return success({ from: head.value, to: candidate.commit, checkout: checkout.path });
  }
  return success({ from: head.value, to: candidate.commit });
}
