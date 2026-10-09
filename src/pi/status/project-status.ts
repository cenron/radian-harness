import type { Mode } from "#core/types.ts";
import type { WorkerRecord } from "#core/worker.ts";
import { listWorkers } from "#io/worker-store.ts";
import { projectPaths, readAutoMerge, readMode, type Project } from "#io/workspace.ts";

export interface ProjectStatus {
  project: Project;
  mode: Mode;
  workers: readonly WorkerRecord[];
  maxWorkers: number;
  /** Seconds before an unanswered merge dialog merges; 0 or absent means it waits. */
  autoMergeSeconds?: number;
}

/** Reads what the footer and the status report show for a project: its mode and its workers. */
export function projectStatusOf(
  workspaceRoot: string,
  project: Project,
  harness: { startMode: Mode; maxWorkers: number; autoMergeSeconds: number },
): ProjectStatus {
  return {
    project,
    mode: readMode(workspaceRoot, project.name, harness.startMode),
    workers: listWorkers(projectPaths(workspaceRoot, project.name).workersFile),
    maxWorkers: harness.maxWorkers,
    autoMergeSeconds: readAutoMerge(workspaceRoot, project.name, harness.autoMergeSeconds),
  };
}
