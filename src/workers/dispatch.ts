import { readFileSync } from "node:fs";
import path from "node:path";
import { firstPrompt, renderBrief } from "../core/brief.ts";
import { RadianError, errorMessage } from "../core/errors.ts";
import { selectProfile, type Profile } from "../core/profiles.ts";
import { assertRoleAllowedInMode, type Mode, type Role } from "../core/roles.ts";
import { SCRUBBED_ENV, runtimeArgs, showsStartupPrompt } from "../core/runtime-args.ts";
import {
  countsTowardLimit,
  nextWorkerName,
  paneLabel,
  workerBranch,
  type WorkerRecord,
} from "../core/worker.ts";
import { addWorktree, gitCommonDir } from "../io/git.ts";
import { promptAgent, readPaneText, renamePane, splitPane, startAgent } from "../io/herdr.ts";
import { writeBrief, type WorkerFiles } from "../io/status-files.ts";
import { findWorker, listWorkers, saveWorker } from "../io/worker-store.ts";
import { projectPaths } from "../io/workspace.ts";
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
  await addWorktree(env.project.path, {
    path: worker.worktree,
    branch: worker.branch,
    from: baseBranch,
  });
  const files = filesOf(env, worker);
  writeBrief(files, briefFor(worker, { task: request.task, target: env.project.target, files }));
  saveWorker(workersFileOf(env), worker);
  return launchWorker(env, { worker, profile, files, paneId });
}

async function launchWorker(
  env: WorkerEnv,
  launch: { worker: WorkerRecord; profile: Profile; files: WorkerFiles; paneId: string },
): Promise<WorkerRecord> {
  let worker = launch.worker;
  try {
    const pane = await splitPane(env.herdr, {
      from: launch.paneId,
      cwd: worker.worktree,
      blankedEnv: SCRUBBED_ENV,
    });
    worker = update(env, { ...worker, pane });
    await renamePane(env.herdr, pane, paneLabel(worker.role, worker.title));
    const args = runtimeArgs({
      profile: launch.profile,
      role: worker.role,
      workerDir: path.dirname(launch.files.brief),
      gitCommonDir: await gitCommonDir(env.project.path),
    });
    const start = { name: worker.name, kind: launch.profile.runtime, pane, args };
    const isWaiting =
      (await startAgent(env.herdr, start)) === "waiting" ||
      showsStartupPrompt(await readPaneText(env.herdr, pane));
    if (!isWaiting) return await deliverTask(env, worker);
    return update(env, {
      ...worker,
      isTaskPending: true,
      lastStatus: `waiting: answer the prompt in pane ${pane} (for example, trusting the worktree folder); Radian then types in the task`,
    });
  } catch (error) {
    update(env, {
      ...worker,
      state: "failed",
      lastStatus: `launch failed: ${errorMessage(error)}`,
    });
    throw error;
  }
}

/** Types the role prompt and the brief into the worker's session. */
export async function deliverTask(env: WorkerEnv, worker: WorkerRecord): Promise<WorkerRecord> {
  const rolePrompt = readRolePrompt(env.harnessRoot, worker.role);
  if (!worker.pane) throw new RadianError("no_pane", `${worker.name} has no pane to type into.`);
  await promptAgent(env.herdr, worker.pane, firstPrompt(rolePrompt, filesOf(env, worker).brief));
  const { lastStatus: _waitingNote, ...rest } = worker;
  return update(env, { ...rest, state: "working", isTaskPending: false });
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

function readRolePrompt(harnessRoot: string, role: Role): string {
  return readFileSync(path.join(harnessRoot, "roles", `${role}.md`), "utf8");
}

function update(env: WorkerEnv, worker: WorkerRecord): WorkerRecord {
  saveWorker(workersFileOf(env), worker);
  return worker;
}
