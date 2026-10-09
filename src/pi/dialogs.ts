import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RadianError } from "../core/errors.ts";
import type { WorkerRecord } from "../core/worker.ts";
import type { Project } from "../io/workspace.ts";
import {
  assertReadyToMerge,
  describeWorker,
  discardWorker,
  mergeWorker,
} from "../workers/finish.ts";
import type { WorkerEnv } from "../workers/worker-env.ts";

export type DeleteChoice = "keep-files" | "delete-files";

const CANCEL = "Cancel";
// Pi resolves both Esc and a timeout as "no choice"; a no-choice answer this close to the end of
// the countdown is the timeout.
const TIMEOUT_MARGIN_MS = 250;
const KEEP_FILES = "Remove from workspace (keep files)";
const DELETE_FILES = "Delete project and files";

export async function chooseProject(
  ctx: ExtensionContext,
  projects: readonly Project[],
): Promise<string | undefined> {
  requireDialogs(ctx);
  return ctx.ui.select(
    "Select a project",
    projects.map((project) => project.name),
  );
}

export async function chooseDeleteAction(
  ctx: ExtensionContext,
  project: Project,
): Promise<DeleteChoice | undefined> {
  requireDialogs(ctx);
  const title = `Delete project ${project.name}? Its files are at ${project.path}.`;
  const choice = await ctx.ui.select(title, [CANCEL, KEEP_FILES, DELETE_FILES]);
  if (choice === KEEP_FILES) return "keep-files";
  if (choice === DELETE_FILES) return "delete-files";
  return undefined;
}

/**
 * The one approval before a merge; Cancel is first so Enter never merges by accident. With
 * `autoMergeSeconds` above 0 the dialog counts down and merges if nobody answers, so work can
 * land while the user is away; Esc still cancels.
 */
export async function mergeWithApproval(
  ctx: ExtensionContext,
  env: WorkerEnv,
  worker: WorkerRecord,
  autoMergeSeconds = 0,
): Promise<string> {
  // Checked again by mergeWorker; checking first means the user is never asked in vain.
  await assertReadyToMerge(env);
  const countdown =
    autoMergeSeconds > 0 ? `\n\nMerges on its own in ${autoMergeSeconds}s unless you cancel.` : "";
  const answer = await askWithCountdown(ctx, {
    title: `Merge into ${env.project.target}?\n\n${await describeWorker(env, worker)}${countdown}`,
    action: "Merge",
    timeoutMs: autoMergeSeconds * 1000,
  });
  if (answer === "cancelled") return `Merge of ${worker.name} cancelled by the user.`;
  const merged = await mergeWorker(env, worker);
  return answer === "timed-out"
    ? `${merged} Merged automatically after ${autoMergeSeconds}s with no answer.`
    : merged;
}

export async function discardWithApproval(
  ctx: ExtensionContext,
  env: WorkerEnv,
  worker: WorkerRecord,
): Promise<string> {
  const isApproved = await approve(ctx, {
    title: `Discard this work? It is deleted, not merged.\n\n${await describeWorker(env, worker)}`,
    action: "Discard",
  });
  return isApproved
    ? discardWorker(env, worker)
    : `Discard of ${worker.name} cancelled by the user.`;
}

/** Approval for one more tool for the project's workers; Cancel is first. */
export async function approveWorkerTool(
  ctx: ExtensionContext,
  request: { project: string; tool: string; reason: string },
): Promise<boolean> {
  return approve(ctx, {
    title: `Allow workers in ${request.project} to use ${request.tool}?\n\nReason: ${request.reason}\n\nIt applies to workers started from now on. Remove it any time with /radian tools remove ${request.tool}.`,
    action: "Allow",
  });
}

async function approve(
  ctx: ExtensionContext,
  dialog: { title: string; action: string },
): Promise<boolean> {
  requireDialogs(ctx);
  return (await ctx.ui.select(dialog.title, [CANCEL, dialog.action])) === dialog.action;
}

/** Like `approve`, but with `timeoutMs` above 0 an unanswered dialog counts as approval. */
async function askWithCountdown(
  ctx: ExtensionContext,
  dialog: { title: string; action: string; timeoutMs: number },
): Promise<"approved" | "cancelled" | "timed-out"> {
  if (dialog.timeoutMs <= 0) return (await approve(ctx, dialog)) ? "approved" : "cancelled";
  requireDialogs(ctx);
  const started = Date.now();
  const choice = await ctx.ui.select(dialog.title, [CANCEL, dialog.action], {
    timeout: dialog.timeoutMs,
  });
  if (choice === dialog.action) return "approved";
  const isTimeout =
    choice === undefined && Date.now() - started >= dialog.timeoutMs - TIMEOUT_MARGIN_MS;
  return isTimeout ? "timed-out" : "cancelled";
}

function requireDialogs(ctx: ExtensionContext): void {
  if (!ctx.hasUI)
    throw new RadianError("no_ui", "This needs an interactive Pi session to ask you.");
}
