import path from "node:path";
import { renderBrief } from "../core/brief.ts";
import { placeNextPane } from "../core/layout.ts";
import { RadianError, errorMessage } from "../core/errors.ts";
import { selectProfile, type Profile } from "../core/profiles.ts";
import { assertRoleAllowedInMode, type Mode, type Role } from "../core/roles.ts";
import { SCRUBBED_ENV, runtimeArgs } from "../core/runtime-args.ts";
import {
  countsTowardLimit,
  hasOpenPane,
  nextWorkerName,
  paneLabel,
  workerBranch,
  type WorkerRecord,
} from "../core/worker.ts";
import { addWorktree } from "../io/git.ts";
import { renamePane, splitPane, startAgent } from "../io/herdr.ts";
import { writeBrief, type WorkerFiles } from "../io/status-files.ts";
import { readWorkerTools } from "../io/worker-tools.ts";
import { findWorker, listWorkers, removeWorker, saveWorker } from "../io/worker-store.ts";
import { projectPaths } from "../io/workspace.ts";
import { deliverWhenReady, markWaiting } from "./delivery.ts";
import { filesOf, workersFileOf, type WorkerEnv } from "./worker-env.ts";

export interface DispatchRequest {
  role: Role;
  title: string;
  task: string;
  profile?: string;
  /** Start from this worker's branch instead of the target, e.g. to review a developer's work. */
  fromWorker?: string;
}

export async function dispatchWorker(
  env: WorkerEnv,
  request: DispatchRequest,
  mode: Mode,
): Promise<WorkerRecord> {
  assertRoleAllowedInMode(request.role, mode);
  const paneId = requireHerdrPane(env);
  const workers = listWorkers(workersFileOf(env));
  assertCapacity(workers, env.config.harness.maxWorkers);
  const profile = selectProfile(env.config.dispatch, request.role, request.profile);
  const baseBranch = request.fromWorker
    ? findWorker(workersFileOf(env), request.fromWorker).branch
    : env.project.target;
  const worker = newRecord(env, { request, profile, baseBranch, existing: workers });
  // Saved before the first await: Pi may run two dispatches at once, and the second must
  // see this name and count this worker toward the limit.
  saveWorker(workersFileOf(env), worker);
  try {
    await addWorktree(env.project.path, {
      path: worker.worktree,
      branch: worker.branch,
      from: baseBranch,
    });
  } catch (error) {
    removeWorker(workersFileOf(env), worker.name);
    throw error;
  }
  const files = filesOf(env, worker);
  writeBrief(files, briefFor(worker, { task: request.task, target: env.project.target, files }));
  return launchWorker(env, { worker, profile, files, piPane: paneId });
}

async function launchWorker(
  env: WorkerEnv,
  launch: {
    worker: WorkerRecord;
    profile: Profile;
    files: WorkerFiles;
    piPane: string;
  },
): Promise<WorkerRecord> {
  let worker = launch.worker;
  try {
    const opened = await openPaneInTurn(env, worker, launch.piPane);
    worker = opened.worker;
    const pane = opened.pane;
    await renamePane(env.herdr, pane, paneLabel(worker.role, worker.title));
    const args = runtimeArgs({
      profile: launch.profile,
      role: worker.role,
      workerDir: path.dirname(launch.files.brief),
      extraTools: readWorkerTools(env.project.path),
    });
    const start = { name: worker.name, kind: launch.profile.runtime, pane, args };
    if ((await startAgent(env.herdr, start)) === "waiting") return markWaiting(env, worker);
    const delivered = (await deliverWhenReady(env, worker)).worker;
    // Not ready yet: the watcher takes over and types the task in once the agent is.
    if (delivered.state === "starting") return update(env, { ...delivered, isTaskPending: true });
    return delivered;
  } catch (error) {
    update(env, {
      ...worker,
      state: "failed",
      lastStatus: `launch failed: ${errorMessage(error)}`,
    });
    throw error;
  }
}

function newRecord(
  env: WorkerEnv,
  input: {
    request: DispatchRequest;
    profile: Profile;
    baseBranch: string;
    existing: WorkerRecord[];
  },
): WorkerRecord {
  const { request, profile } = input;
  const name = nextWorkerName(
    env.project.name,
    request.role,
    input.existing.map((worker) => worker.name),
  );
  return {
    name,
    project: env.project.name,
    role: request.role,
    title: request.title,
    profile: profile.name,
    runtime: profile.runtime,
    model: profile.model,
    effort: profile.effort,
    branch: workerBranch(name),
    baseBranch: input.baseBranch,
    worktree: projectPaths(env.workspaceRoot, env.project.name).worktree(name),
    state: "starting",
    statusLinesSeen: 0,
    createdAt: new Date().toISOString(),
  };
}

// Pi runs parallel dispatches in one process. Opening panes one at a time lets each new pane
// see the panes opened just before it, so the grid stays in order.
let paneOpening: Promise<unknown> = Promise.resolve();

function openPaneInTurn(
  env: WorkerEnv,
  worker: WorkerRecord,
  piPane: string,
): Promise<{ worker: WorkerRecord; pane: string }> {
  const opened = paneOpening.then(() => openPane(env, worker, piPane));
  // The caller still gets the failure; the queue only moves on to the next dispatch.
  paneOpening = opened.catch(() => undefined);
  return opened;
}

/** Opens the worker's pane at the next place in the grid beside Pi. */
async function openPane(
  env: WorkerEnv,
  worker: WorkerRecord,
  piPane: string,
): Promise<{ worker: WorkerRecord; pane: string }> {
  const gridPanes = listWorkers(workersFileOf(env)).filter(
    (other) => other.name !== worker.name && hasOpenPane(other) && other.paneSlot !== undefined,
  );
  const placement = placeNextPane(gridPanes.map((other) => other.paneSlot ?? 0));
  const parent = gridPanes.find((other) => other.paneSlot === placement.parentSlot);
  const pane = await splitPane(env.herdr, {
    from: parent?.pane ?? piPane,
    direction: placement.direction,
    cwd: worker.worktree,
    blankedEnv: SCRUBBED_ENV,
  });
  return { worker: update(env, { ...worker, pane, paneSlot: placement.slot }), pane };
}

function requireHerdrPane(env: WorkerEnv): string {
  if (!env.paneId) {
    throw new RadianError(
      "no_herdr",
      "Workers open in Herdr panes; start Pi inside Herdr to dispatch.",
    );
  }
  return env.paneId;
}

function assertCapacity(workers: readonly WorkerRecord[], maxWorkers: number): void {
  const running = workers.filter(countsTowardLimit).length;
  if (running >= maxWorkers) {
    throw new RadianError(
      "worker_limit",
      `${running} of ${maxWorkers} workers are already running. Wait for one to finish, or stop one.`,
    );
  }
}

function briefFor(
  worker: WorkerRecord,
  input: { task: string; target: string; files: WorkerFiles },
) {
  return renderBrief({
    workerName: worker.name,
    role: worker.role,
    runtime: worker.runtime,
    title: worker.title,
    task: input.task,
    branch: worker.branch,
    baseBranch: worker.baseBranch,
    targetBranch: input.target,
    worktree: worker.worktree,
    statusPath: input.files.status,
    reportPath: input.files.report,
  });
}

function update(env: WorkerEnv, worker: WorkerRecord): WorkerRecord {
  saveWorker(workersFileOf(env), worker);
  return worker;
}
