import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Mode } from "../core/roles.ts";
import { countsTowardLimit, type WorkerRecord } from "../core/worker.ts";
import { listWorkers } from "../io/worker-store.ts";
import { listProjects, projectPaths, readMode, type Project } from "../io/workspace.ts";
import { requireView, type RadianState } from "./state.ts";

const STATUS_KEY = "radian";

export interface ProjectStatus {
  project: Project;
  mode: Mode;
  workers: readonly WorkerRecord[];
  maxWorkers: number;
}

export function refreshStatus(ctx: ExtensionContext, state: RadianState): void {
  const view = state.view;
  if (!view) return;
  if (!view.project) {
    showDashboardStatus(ctx, listProjects(view.workspaceRoot).length);
    return;
  }
  showProjectStatus(ctx, projectStatusOf(view.workspaceRoot, view.project, view.config.harness));
}

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

function showProjectStatus(ctx: ExtensionContext, status: ProjectStatus): void {
  if (!ctx.hasUI) return;
  const running = status.workers.filter(countsTowardLimit).length;
  ctx.ui.setStatus(
    STATUS_KEY,
    `Radian · ${status.project.name} · ${status.mode.toUpperCase()} · ${running}/${status.maxWorkers} workers`,
  );
  ctx.ui.setWidget(
    STATUS_KEY,
    status.workers.length > 0 ? status.workers.map(workerLine) : undefined,
  );
}

function showDashboardStatus(ctx: ExtensionContext, projectCount: number): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, `Radian · workspace · ${projectCount} project(s)`);
  ctx.ui.setWidget(STATUS_KEY, undefined);
}

export function clearStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, undefined);
  ctx.ui.setWidget(STATUS_KEY, undefined);
}

/** What /radian status and radian_status show: the selected project, or the dashboard. */
export function statusReport(state: RadianState): string {
  const view = requireView(state);
  if (!view.project) return dashboardReport(listProjects(view.workspaceRoot));
  return projectReport(projectStatusOf(view.workspaceRoot, view.project, view.config.harness));
}

export function projectReport(status: ProjectStatus): string {
  const { project } = status;
  return [
    `Project ${project.name} at ${project.path} (target ${project.target})`,
    `Mode: ${status.mode.toUpperCase()}`,
    workersReport(status.workers),
  ].join("\n");
}

export function dashboardReport(projects: readonly Project[]): string {
  if (projects.length === 0) return "No projects yet. Create one with /new-project <name>.";
  const lines = projects.map(
    (project) => `- ${project.name}: ${project.path} (target ${project.target})`,
  );
  return ["No project selected. Projects:", ...lines, "Select one with /projects <name>."].join(
    "\n",
  );
}

export function workersReport(workers: readonly WorkerRecord[]): string {
  if (workers.length === 0) return "No workers.";
  return ["Workers:", ...workers.map((worker) => `- ${workerLine(worker)}`)].join("\n");
}

function workerLine(worker: WorkerRecord): string {
  const agent = worker.agentStatus ? ` (agent ${worker.agentStatus})` : "";
  const last = worker.lastStatus ? ` — ${worker.lastStatus}` : "";
  return `${worker.name} [${worker.state}${agent}] ${worker.role}: ${worker.title} · ${worker.runtime} ${worker.model}${last}`;
}
