import { readFileSync } from "node:fs";
import path from "node:path";
import { firstPrompt } from "../core/brief.ts";
import { RadianError } from "../core/errors.ts";
import type { Role } from "../core/constants.ts";
import { readScreen } from "../core/runtime-args.ts";
import type { WorkerRecord } from "../core/worker.ts";
import { promptAgent, readPaneText } from "../io/herdr.ts";
import { replaceWorker } from "../io/worker-store.ts";
import { filesOf, workersFileOf, type WorkerEnv } from "./worker-env.ts";

const WAITING_PREFIX = "waiting:";

/**
 * Types the task in once the agent shows its input, and never while it shows a startup
 * prompt: the Enter that submits the task would answer the prompt for the user.
 */
export async function deliverWhenReady(
  env: WorkerEnv,
  worker: WorkerRecord,
): Promise<{ worker: WorkerRecord; isAwaitingUser: boolean }> {
  const pane = requirePane(worker);
  const screen = readScreen(worker.runtime, await readPaneText(env.herdr, pane));
  if (screen === "ready") return { worker: await deliverTask(env, worker), isAwaitingUser: false };
  if (screen === "asking" && !isWaitingForUser(worker)) {
    return { worker: markWaiting(env, worker), isAwaitingUser: true };
  }
  return { worker, isAwaitingUser: false };
}

/** Records that the agent asks the user something before it can take the task. */
export function markWaiting(env: WorkerEnv, worker: WorkerRecord): WorkerRecord {
  const pane = requirePane(worker);
  return save(env, {
    ...worker,
    isTaskPending: true,
    lastStatus: `${WAITING_PREFIX} answer the prompt in pane ${pane} (for example, trusting the worktree folder); Radian then types in the task`,
  });
}

async function deliverTask(env: WorkerEnv, worker: WorkerRecord): Promise<WorkerRecord> {
  const rolePrompt = readRolePrompt(env.harnessRoot, worker.role);
  await promptAgent(
    env.herdr,
    requirePane(worker),
    firstPrompt(rolePrompt, filesOf(env, worker).brief),
  );
  const { lastStatus: _waitingNote, ...rest } = worker;
  return save(env, { ...rest, state: "working", isTaskPending: false });
}

/** The agent is showing a startup prompt that the user has to answer in its pane. */
export function isWaitingForUser(worker: WorkerRecord): boolean {
  return worker.lastStatus?.startsWith(WAITING_PREFIX) ?? false;
}

function requirePane(worker: WorkerRecord): string {
  if (!worker.pane) throw new RadianError("no_pane", `${worker.name} has no pane to type into.`);
  return worker.pane;
}

function readRolePrompt(harnessRoot: string, role: Role): string {
  return readFileSync(path.join(harnessRoot, "roles", `${role}.md`), "utf8");
}

function save(env: WorkerEnv, worker: WorkerRecord): WorkerRecord {
  replaceWorker(workersFileOf(env), worker);
  return worker;
}
