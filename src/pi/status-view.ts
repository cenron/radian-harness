import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Mode } from "../core/roles.ts";
import { countsTowardLimit, type WorkerRecord, type WorkerState } from "../core/worker.ts";
import { listWorkers } from "../io/worker-store.ts";
import { listProjects, projectPaths, readMode, type Project } from "../io/workspace.ts";
import { requireView, type RadianState } from "./state.ts";

const STATUS_KEY = "radian";
const STATE_ORDER: readonly WorkerState[] = [
  "starting",
  "working",
  "question",
  "blocked",
  "done",
  "failed",
  "exited",
  "stopped",
];
const STATE_LABELS: Partial<Record<WorkerState, string>> = { question: "asking" };
const SUMMARY_LENGTH = 80;
const MIN_SUMMARY_LENGTH = 12;
const WIDGET_MARGIN = 2;

export type WidgetColor = "accent" | "warning" | "success" | "error" | "muted";
/** Colors text for the terminal; tests pass a plain or tagging function instead. */
export type Paint = (color: WidgetColor, text: string) => string;

const STATE_STYLE: Record<WorkerState, { icon: string; color: WidgetColor }> = {
  starting: { icon: "◌", color: "accent" },
  working: { icon: "●", color: "accent" },
  question: { icon: "?", color: "warning" },
  blocked: { icon: "!", color: "warning" },
  done: { icon: "✓", color: "success" },
  failed: { icon: "✗", color: "error" },
  exited: { icon: "✗", color: "error" },
  stopped: { icon: "■", color: "muted" },
};

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
  ctx.ui.setStatus(STATUS_KEY, projectStatusLine(status));
  const paint: Paint =
    ctx.mode === "tui" ? (color, text) => ctx.ui.theme.fg(color, text) : (_color, text) => text;
  // Pi's own pane width, less the widget's indent, so each worker stays on one line.
  const width = (process.stdout.columns ?? Number.POSITIVE_INFINITY) - WIDGET_MARGIN;
  const lines = workerWidgetLines(status.workers, paint, width);
  ctx.ui.setWidget(STATUS_KEY, lines.length > 0 ? lines : undefined);
}

function showDashboardStatus(ctx: ExtensionContext, projectCount: number): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, `Radian · workspace · ${projectCount} project(s)`);
  ctx.ui.setWidget(STATUS_KEY, undefined);
}

/**
 * The footer: every open worker by state, and how many of the limit's slots are in use. A done
 * worker frees its slot while it waits for a merge, so the two numbers differ on purpose.
 */
export function projectStatusLine(status: ProjectStatus): string {
  const inUse = status.workers.filter(countsTowardLimit).length;
  const slots = `${inUse}/${status.maxWorkers} slots in use`;
  const prefix = `Radian · ${status.project.name} · ${status.mode.toUpperCase()}`;
  if (status.workers.length === 0) return `${prefix} · no workers · ${slots}`;
  const byState = STATE_ORDER.map((state) => ({
    label: STATE_LABELS[state] ?? state,
    count: status.workers.filter((worker) => worker.state === state).length,
  }))
    .filter((group) => group.count > 0)
    .map((group) => `${group.count} ${group.label}`);
  const count = status.workers.length;
  return `${prefix} · ${count} worker${count === 1 ? "" : "s"}: ${byState.join(", ")} · ${slots}`;
}

/**
 * The worker list under Pi, for people: one aligned line per worker with a colored state,
 * its title, and a trimmed summary. Paths and model IDs stay in the radian_workers report.
 */
export function workerWidgetLines(
  workers: readonly WorkerRecord[],
  paint: Paint,
  width = Number.POSITIVE_INFINITY,
): string[] {
  const names = workers.map(shortName);
  const labels = workers.map((worker) => STATE_LABELS[worker.state] ?? worker.state);
  const nameWidth = Math.max(0, ...names.map((name) => name.length));
  const labelWidth = Math.max(0, ...labels.map((label) => label.length));
  return workers.map((worker, index) => {
    const style = STATE_STYLE[worker.state];
    const name = (names[index] ?? "").padEnd(nameWidth);
    const label = (labels[index] ?? "").padEnd(labelWidth);
    const head = `${style.icon} ${name}  ${label}`;
    const summary = summaryOf(worker, width - `${head}  ${worker.title} — `.length);
    const detail = summary ? ` — ${paint("muted", summary)}` : "";
    return `${paint(style.color, head)}  ${worker.title}${detail}`;
  });
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
  return `${worker.name} [${worker.state}${agent}] ${worker.role}: ${worker.title} · ${worker.runtime} ${worker.model} · worktree ${worker.worktree}${last}`;
}

function shortName(worker: WorkerRecord): string {
  const prefix = `${worker.project}-`;
  return worker.name.startsWith(prefix) ? worker.name.slice(prefix.length) : worker.name;
}

/**
 * The last status without its kind (the state shows it) and with long paths cut to their last
 * two parts, shortened to fit `room` columns; left out when there is no useful room.
 */
function summaryOf(worker: WorkerRecord, room: number): string {
  const text = (worker.lastStatus ?? "")
    .replace(/^(working|question|blocked|done|failed|waiting):\s*/, "")
    .replace(/\/(?:[^\s/]+\/)+([^\s/]+\/[^\s/]+)/g, "…/$1");
  const limit = Math.min(SUMMARY_LENGTH, room - 1);
  if (limit < MIN_SUMMARY_LENGTH) return "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
