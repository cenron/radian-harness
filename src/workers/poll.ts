import { latestStatus, type StatusEntry } from "../core/status.ts";
import { hasOpenPane, type WorkerRecord, type WorkerState } from "../core/worker.ts";
import { getPane } from "../io/herdr.ts";
import { readStatusEntries } from "../io/status-files.ts";
import { saveWorker } from "../io/worker-store.ts";
import { filesOf, workersFileOf, type WorkerEnv } from "./worker-env.ts";

export interface WorkerChange {
  worker: WorkerRecord;
  /** Status lines written since the last poll. */
  entries: StatusEntry[];
  /** The pane closed during this poll. */
  hasExited: boolean;
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
  return { worker: next, entries, hasExited };
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
