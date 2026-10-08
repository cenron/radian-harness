import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listProjects } from "#io/workspace.ts";
import { listWorkers } from "#io/worker-store.ts";
import { workersFileOf } from "#workers/worker-env.ts";
import type { State } from "#pi/state.ts";
import { projectStatusLine, workerWidgetLines, type Paint } from "#pi/status/footer.ts";
import { projectStatusOf, type ProjectStatus } from "#pi/status/project-status.ts";
import { dashboardReport, projectReport, workersReport } from "#pi/status/reports.ts";

const STATUS_KEY = "radian";
const WIDGET_MARGIN = 2;

/** What Radian shows about the selected project: Pi's footer and widget, and the text reports. */
export class StatusView {
  private readonly state: State;

  constructor(state: State) {
    this.state = state;
  }

  /** Redraws the footer and the worker widget from the files on disk. */
  refresh(ctx: ExtensionContext): void {
    const view = this.state.view;
    if (!view || !ctx.hasUI) return;
    if (!view.project) return this.showDashboard(ctx, listProjects(view.workspaceRoot).length);
    this.showProject(ctx, projectStatusOf(view.workspaceRoot, view.project, view.config.harness));
  }

  clear(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(STATUS_KEY, undefined);
  }

  /** What /radian status and radian_status show: the selected project, or the dashboard. */
  report(): string {
    const view = this.state.requireView();
    if (!view.project) return dashboardReport(listProjects(view.workspaceRoot));
    return projectReport(projectStatusOf(view.workspaceRoot, view.project, view.config.harness));
  }

  /** What /radian workers and radian_workers show: the selected project's workers. */
  workersReport(): string {
    return workersReport(listWorkers(workersFileOf(this.state.workerEnvOf())));
  }

  private showDashboard(ctx: ExtensionContext, projectCount: number): void {
    ctx.ui.setStatus(STATUS_KEY, `Radian · workspace · ${projectCount} project(s)`);
    ctx.ui.setWidget(STATUS_KEY, undefined);
  }

  private showProject(ctx: ExtensionContext, status: ProjectStatus): void {
    ctx.ui.setStatus(STATUS_KEY, projectStatusLine(status));
    const paint: Paint =
      ctx.mode === "tui" ? (color, text) => ctx.ui.theme.fg(color, text) : (_color, text) => text;
    // Pi's own pane width, less the widget's indent, so summaries wrap instead of running off.
    const width = (process.stdout.columns ?? Number.POSITIVE_INFINITY) - WIDGET_MARGIN;
    const lines = workerWidgetLines(status.workers, paint, width);
    ctx.ui.setWidget(STATUS_KEY, lines.length > 0 ? lines : undefined);
  }
}
