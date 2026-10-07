import { latestStatus, type StatusEntry } from "../core/status.ts";
import { hasOpenPane, type WorkerRecord, type WorkerState } from "../core/worker.ts";
import { canEditCode } from "../core/roles.ts";
import { commitAll } from "../io/git.ts";
import { getPane } from "../io/herdr.ts";
import { readStatusEntries } from "../io/status-files.ts";
import { replaceWorker } from "../io/worker-store.ts";
import { deliverWhenReady } from "./delivery.ts";
import { closeFinishedReader } from "./finish.ts";
import { filesOf, workersFileOf, type WorkerEnv } from "./worker-env.ts";

export interface WorkerChange {
  worker: WorkerRecord;
  /** Status lines written since the last poll. */
  entries: StatusEntry[];
  /** The pane closed during this poll. */
  hasExited: boolean;
  /** A finished scout or reviewer was closed: pane, worktree, branch, and record removed. */
  isClosed: boolean;
  /** The closed worker's report.md, or "" when it wrote none. */
  report?: string;
  /** The agent started asking the user something (such as folder trust) during this poll. */
  isAwaitingUser: boolean;
  /** Radian committed the worker's changes on its branch when it reported done. */
  hasRadianCommit: boolean;
}

const FINISHED_STATES: readonly WorkerState[] = ["done", "failed"];

/**
 * Reads new status lines from disk and the pane's state from Herdr, and saves the result.
 * Progress is counted in lines already seen, so a restart never reports a line twice.
 */
export async function pollWorker(env: WorkerEnv, worker: WorkerRecord): Promise<WorkerChange> {
  // Dispatch owns a worker until it has typed the task or handed it over as pending.
  if (worker.state === "starting" && !worker.isTaskPending) return changeOf(worker, [], false);
  const allEntries = readStatusEntries(filesOf(env, worker).status);
  const entries = allEntries.slice(worker.statusLinesSeen);
  const pane =
    hasOpenPane(worker) && worker.pane ? await getPane(env.herdr, worker.pane) : undefined;
  const hasExited = hasOpenPane(worker) && pane === undefined;
  const latest = latestStatus(entries);
  const next: WorkerRecord = {
    ...worker,
    statusLinesSeen: allEntries.length,
    state: nextState({ current: worker.state, latest: latest?.kind, hasExited }),
    agentStatus: pane?.agentStatus,
  };
  if (latest) next.lastStatus = `${latest.kind}: ${latest.text}`;
  if (JSON.stringify(next) !== JSON.stringify(worker)) replaceWorker(workersFileOf(env), next);
  const hasRadianCommit =
    next.state === "done" && worker.state !== "done" && (await commitFor(next, latest?.text));
  if (next.isTaskPending && pane) {
    const delivery = await deliverWhenReady(env, next);
    return {
      ...changeOf(delivery.worker, entries, hasExited),
      isAwaitingUser: delivery.isAwaitingUser,
    };
  }
  const report = await closeFinishedReader(env, next);
  const change = { ...changeOf(next, entries, hasExited), hasRadianCommit };
  return report === undefined ? change : { ...change, isClosed: true, report };
}

/** The coordinator commits a developer's or tester's changes once it reports done. */
async function commitFor(worker: WorkerRecord, doneText: string | undefined): Promise<boolean> {
  if (!canEditCode(worker.role)) return false;
  const summary = doneText ? `${doneText}\n\n` : "";
  const message = `${worker.title}\n\n${summary}Committed by Radian for ${worker.name} (${worker.role}, ${worker.runtime}).`;
  return commitAll(worker.worktree, message);
}

function changeOf(worker: WorkerRecord, entries: StatusEntry[], hasExited: boolean): WorkerChange {
  return {
    worker,
    entries,
    hasExited,
    isClosed: false,
    isAwaitingUser: false,
    hasRadianCommit: false,
  };
}

function nextState(input: {
  current: WorkerState;
  latest: StatusEntry["kind"] | undefined;
  hasExited: boolean;
}): WorkerState {
  const reported = input.latest && input.latest !== "note" ? input.latest : input.current;
  if (input.hasExited && !FINISHED_STATES.includes(reported)) return "exited";
  return reported;
}
