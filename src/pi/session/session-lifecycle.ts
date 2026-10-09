import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "#core/utils/errors.ts";
import { readCalm } from "#pi/calm.ts";
import { modeEditorFactory } from "#pi/mode/mode-editor.ts";
import type { ProjectMode } from "#pi/mode/project-mode.ts";
import type { ModelCarry } from "#pi/session/model-carry.ts";
import type { ProjectSession } from "#pi/session/project-session.ts";
import type { State } from "#pi/state.ts";
import type { StatusView } from "#pi/status/status-view.ts";
import { RADIAN_TOOL_NAMES } from "#pi/tools/index.ts";
import { READ_TOOL_NAMES } from "#pi/tools/read-tools.ts";
import type { Watcher } from "#pi/watcher/watcher.ts";

export interface SessionLifecycleDependencies {
  state: State;
  session: ProjectSession;
  carry: ModelCarry;
  status: StatusView;
  watcher: Watcher;
  mode: ProjectMode;
}

/** What Radian does when Pi starts or ends a session: the dashboard, or a selected project. */
export class SessionLifecycle {
  private readonly deps: SessionLifecycleDependencies;

  constructor(deps: SessionLifecycleDependencies) {
    this.deps = deps;
  }

  async start(ctx: ExtensionContext): Promise<void> {
    const { state, session, carry, status, watcher, mode } = this.deps;
    try {
      state.view = session.resolveView(ctx);
    } catch (error) {
      ctx.ui.notify(`Radian is inactive: ${errorMessage(error)}`, "error");
      return;
    }

    const view = state.view;
    if (!view) return;

    await carry.restore(ctx);
    state.isCalm = readCalm(view.workspaceRoot, view.config.harness.calm);

    const projectTools = view.project ? RADIAN_TOOL_NAMES : ["radian_status"];
    state.pi.setActiveTools([...projectTools, ...READ_TOOL_NAMES]);

    if (!view.project) return status.refresh(ctx);

    if (ctx.mode === "tui") ctx.ui.setEditorComponent(modeEditorFactory(() => mode.toggle(ctx)));

    watcher.start(ctx);
    status.refresh(ctx);
  }

  end(ctx: ExtensionContext): void {
    this.deps.watcher.stop();
    if (!this.deps.state.view) return;
    if (ctx.mode === "tui") ctx.ui.setEditorComponent(undefined);
    this.deps.status.clear(ctx);
  }
}
