import type { WorkerRecord } from "#core/worker.ts";
import type { Project } from "#io/workspace.ts";
import type { ProjectStatus } from "#pi/status/project-status.ts";

export function projectReport(status: ProjectStatus): string {
  const { project } = status;
  return [
    `Project ${project.name} at ${project.path} (target ${project.target})`,
    `Mode: ${status.mode.toUpperCase()}`,
    workersReport(status.workers),
  ].join("\n");
}

export function dashboardReport(projects: readonly Project[]): string {
  if (projects.length === 0) return "No projects yet. Create one with /projects create <name>.";
  const lines = projects.map(
    (project) => `- ${project.name}: ${project.path} (target ${project.target})`,
  );
  return [
    "No project selected. Projects:",
    ...lines,
    "Select one with /projects select <name>.",
  ].join("\n");
}

export function workersReport(workers: readonly WorkerRecord[]): string {
  if (workers.length === 0) return "No workers.";
  return ["Workers:", ...workers.map((worker) => `- ${workerLine(worker)}`)].join("\n");
}

function workerLine(worker: WorkerRecord): string {
  const agent = worker.agentStatus ? ` (agent ${worker.agentStatus})` : "";
  const last = worker.lastStatus ? ` — ${worker.lastStatus}` : "";
  return `${worker.name} [${worker.state}${agent}] ${worker.role}: ${worker.title} · ${worker.runtime} ${worker.model} · worktree ${worker.worktree}${last}`;
}
