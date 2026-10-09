import type { WorkerRecord } from "../core/worker.ts";
import type { RadianConfig } from "#core/types.ts";
import type { HerdrRunner } from "../io/herdr.ts";
import { workerFiles, type WorkerFiles } from "../io/status-files.ts";
import { projectPaths, type Project } from "../io/workspace.ts";

/** Everything worker operations need about the selected project and the host. */
export interface WorkerEnv {
  workspaceRoot: string;
  project: Project;
  config: RadianConfig;
  harnessRoot: string;
  herdr: HerdrRunner;
  /** The Herdr pane Pi runs in; worker panes open beside it. */
  paneId: string | undefined;
}

export function workersFileOf(env: WorkerEnv): string {
  return projectPaths(env.workspaceRoot, env.project.name).workersFile;
}

export function filesOf(env: WorkerEnv, worker: Pick<WorkerRecord, "name">): WorkerFiles {
  return workerFiles(projectPaths(env.workspaceRoot, env.project.name).workerDir(worker.name));
}
