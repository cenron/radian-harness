import { RadianError } from "./errors.ts";
import type { Role, Runtime } from "./constants.ts";

export type WorkerState =
  "starting" | "working" | "question" | "blocked" | "done" | "failed" | "exited" | "stopped";

export interface WorkerRecord {
  name: string;
  project: string;
  role: Role;
  title: string;
  profile: string;
  runtime: Runtime;
  model: string;
  effort: string;
  branch: string;
  /** The branch the worktree was cut from: the project's target or another worker's branch. */
  baseBranch: string;
  worktree: string;
  pane?: string;
  /** The worker's place in the pane grid beside the coordinator (see placeNextPane). */
  paneSlot?: number;
  /** The agent stopped at a startup prompt; the task is typed in once it is ready. */
  isTaskPending?: boolean;
  /** Herdr's last view of the agent in the pane (idle, working, blocked, ...). */
  agentStatus?: string;
  state: WorkerState;
  lastStatus?: string;
  /** Status lines already reported to Pi, so a restart never repeats them. */
  statusLinesSeen: number;
  createdAt: string;
}

const RUNNING_STATES: readonly WorkerState[] = ["starting", "working", "question", "blocked"];
const CLOSED_STATES: readonly WorkerState[] = ["exited", "stopped"];
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TITLE_LENGTH = 40;

export function nextWorkerName(
  project: string,
  role: Role,
  existingNames: readonly string[],
): string {
  const prefix = `${project}-${role}-`;
  const numbers = existingNames
    .filter((name) => name.startsWith(prefix))
    .map((name) => Number(name.slice(prefix.length)))
    .filter((number) => Number.isInteger(number));
  return `${prefix}${Math.max(0, ...numbers) + 1}`;
}

export function workerBranch(workerName: string): string {
  return `radian/${workerName}`;
}

export function paneLabel(role: Role, title: string): string {
  return `${role} ${title.trim().slice(0, TITLE_LENGTH)}`;
}

export function assertProjectName(name: string): void {
  if (!PROJECT_NAME.test(name)) {
    throw new RadianError(
      "invalid_project_name",
      `Project names use lowercase letters, digits, "-" and "_", and start with a letter or digit: "${name}".`,
    );
  }
}

export function countsTowardLimit(worker: Pick<WorkerRecord, "state">): boolean {
  return RUNNING_STATES.includes(worker.state);
}

export function hasOpenPane(worker: Pick<WorkerRecord, "state" | "pane">): boolean {
  return worker.pane !== undefined && !CLOSED_STATES.includes(worker.state);
}
