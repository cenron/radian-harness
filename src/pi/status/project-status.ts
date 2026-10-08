import type { Mode } from "#core/roles.ts";
import type { WorkerRecord } from "#core/worker.ts";
import { listWorkers } from "#io/worker-store.ts";
import { projectPaths, readMode, type Project } from "#io/workspace.ts";

export interface ProjectStatus {
  project: Project;
  mode: Mode;
  workers: readonly WorkerRecord[];
  maxWorkers: number;
}

/** Reads what the footer and the status report show for a project: its mode and its workers. */
export function projectStatusOf(
  workspaceRoot: string,
  project: Project,
  harness: { startMode: Mode; maxWorkers: number },
): ProjectStatus {
  return {
    project,
    mode: readMode(workspaceRoot, project.name, harness.startMode),
    workers: listWorkers(projectPaths(workspaceRoot, project.name).workersFile),
    maxWorkers: harness.maxWorkers,
  };
}
