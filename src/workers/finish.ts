import { rmSync } from "node:fs";
import path from "node:path";
import { RadianError } from "../core/errors.ts";
import { FILE_LIST_LIMIT, listSome } from "../core/text.ts";
import type { WorkerRecord } from "../core/worker.ts";
import {
  branchExists,
  branchSummary,
  countOwnCommits,
  currentBranch,
  deleteBranch,
  mergeBranch,
  removeWorktree,
  uncommittedFiles,
} from "../io/git.ts";
import { closePane, getPane, promptAgent } from "../io/herdr.ts";
import { readReport } from "../io/status-files.ts";
import { removeWorker, saveWorker } from "../io/worker-store.ts";
import { filesOf, workersFileOf, type WorkerEnv } from "./worker-env.ts";

const REPORT_PREVIEW_CHARS = 1500;

/** What the user sees before approving a merge or discard. */
export async function describeWorker(env: WorkerEnv, worker: WorkerRecord): Promise<string> {
  const summary = await branchSummary(env.project.path, {
    base: env.project.target,
    branch: worker.branch,
  });
  const report = readReport(filesOf(env, worker).report);
  return [
    `${worker.name} (${worker.role}: ${worker.title})`,
    `Branch ${worker.branch} → ${env.project.target}: ${summary.commitCount} commit(s)`,
    summary.diffStat || "No file changes.",
    `Last status: ${worker.lastStatus ?? "none"}`,
    ...(report ? ["", "Report:", report.slice(0, REPORT_PREVIEW_CHARS)] : []),
  ].join("\n");
}

/** Merges into the target branch, then closes the pane and removes the worktree and branch. */
export async function mergeWorker(env: WorkerEnv, worker: WorkerRecord): Promise<string> {
  await assertReadyToMerge(env);
  const kind = await mergeBranch(env.project.path, worker.branch);
  await removeWorkerCompletely(env, worker);
  const how = kind === "fast-forward" ? "fast-forward" : "merge commit";
  return `Merged ${worker.branch} into ${env.project.target} (${how}); pane, worktree, and branch removed.`;
}

/** Throws unmerged work away. Callers confirm with the user first. */
export async function discardWorker(env: WorkerEnv, worker: WorkerRecord): Promise<string> {
  await removeWorkerCompletely(env, worker);
  return `Discarded ${worker.name}; pane, worktree, and branch removed.`;
}

/** Closes the pane but keeps the worktree and branch so the work can still be merged. */
export async function stopWorker(env: WorkerEnv, worker: WorkerRecord): Promise<string> {
  await closePaneIfOpen(env, worker);
  saveWorker(workersFileOf(env), { ...worker, state: "stopped" });
  return `Stopped ${worker.name}; its worktree and branch ${worker.branch} are kept.`;
}

/**
 * A done worker with no commits of its own has nothing to merge or lose: a scout or reviewer,
 * a developer that changed nothing, or one whose work already reached the target through
 * another worker. It is closed and its report returned. Undefined means the worker stays.
 */
export async function closeIfNothingToMerge(
  env: WorkerEnv,
  worker: WorkerRecord,
): Promise<string | undefined> {
  if (worker.state !== "done") return undefined;
  if ((await countOwnCommits(env.project.path, worker.branch)) > 0) return undefined;
  const report = readReport(filesOf(env, worker).report) ?? "";
  await removeWorkerCompletely(env, worker);
  return report;
}

export async function sendToWorker(
  env: WorkerEnv,
  worker: WorkerRecord,
  text: string,
): Promise<string> {
  if (!worker.pane || !(await getPane(env.herdr, worker.pane))) {
    throw new RadianError("worker_closed", `${worker.name} has no open pane to send to.`);
  }
  await promptAgent(env.herdr, worker.pane, text);
  saveWorker(workersFileOf(env), { ...worker, state: "working" });
  return `Sent to ${worker.name}.`;
}

/** The project checkout must be on its target branch and clean before anything is merged. */
export async function assertReadyToMerge(env: WorkerEnv): Promise<void> {
  const branch = await currentBranch(env.project.path);
  if (branch !== env.project.target) {
    throw new RadianError(
      "wrong_branch",
      `${env.project.path} is on ${branch || "a detached HEAD"}; check out ${env.project.target} before merging.`,
    );
  }
  const dirty = await uncommittedFiles(env.project.path);
  if (dirty.length > 0) {
    throw new RadianError(
      "dirty_checkout",
      `${env.project.path} has uncommitted changes: ${listSome(dirty, FILE_LIST_LIMIT)}. Commit, stash, or discard them before merging.`,
    );
  }
}

async function removeWorkerCompletely(env: WorkerEnv, worker: WorkerRecord): Promise<void> {
  await closePaneIfOpen(env, worker);
  await removeWorktree(env.project.path, worker.worktree);
  if (await branchExists(env.project.path, worker.branch)) {
    await deleteBranch(env.project.path, worker.branch);
  }
  rmSync(path.dirname(filesOf(env, worker).brief), { recursive: true, force: true });
  removeWorker(workersFileOf(env), worker.name);
}

async function closePaneIfOpen(env: WorkerEnv, worker: WorkerRecord): Promise<void> {
  if (worker.pane && (await getPane(env.herdr, worker.pane)))
    await closePane(env.herdr, worker.pane);
}
