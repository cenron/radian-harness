import { latestStatus, type StatusEntry } from "../core/status.ts";
import { hasOpenPane, type WorkerRecord, type WorkerState } from "../core/worker.ts";
import { showsStartupPrompt } from "../core/runtime-args.ts";
import { getPane, readPaneText, type PaneInfo } from "../io/herdr.ts";
import { readStatusEntries } from "../io/status-files.ts";
import { saveWorker } from "../io/worker-store.ts";
import { deliverTask } from "./dispatch.ts";
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
}

const FINISHED_STATES: readonly WorkerState[] = ["done", "failed"];

/**
 * Reads new status lines from disk and the pane's state from Herdr, and saves the result.
 * Progress is counted in lines already seen, so a restart never reports a line twice.
 */
export async function pollWorker(env: WorkerEnv, worker: WorkerRecord): Promise<WorkerChange> {
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
  if (JSON.stringify(next) !== JSON.stringify(worker)) saveWorker(workersFileOf(env), next);
  // The user answered the agent's startup prompt, so the task can be typed in now.
  if (next.isTaskPending && (await isReadyForTask(env, next, pane))) {
    return { worker: await deliverTask(env, next), entries, hasExited, isClosed: false };
  }
  const report = await closeFinishedReader(env, next);
  if (report === undefined) return { worker: next, entries, hasExited, isClosed: false };
  return { worker: next, entries, hasExited, isClosed: true, report };
}

/** The user has answered the startup prompt: the agent is idle and the prompt is gone. */
async function isReadyForTask(
  env: WorkerEnv,
  worker: WorkerRecord,
  pane: PaneInfo | undefined,
): Promise<boolean> {
  if (!worker.pane || pane?.agentStatus !== "idle") return false;
  return !showsStartupPrompt(await readPaneText(env.herdr, worker.pane));
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
