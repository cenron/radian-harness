import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeMode } from "#io/workspace.ts";
import type { State } from "#pi/state.ts";
import type { StatusView } from "#pi/status/status-view.ts";
import type { Mode } from "#core/types.ts";

/** The selected project's Plan/Build mode, set by `/radian mode` and toggled by Shift+Tab. */
export class ProjectMode {
  private readonly state: State;
  private readonly status: StatusView;

  constructor(state: State, status: StatusView) {
    this.state = state;
    this.status = status;
  }

  /** Saves the mode, redraws the footer, and returns the message for the user. */
  set(ctx: ExtensionContext, mode: Mode): string {
    const view = this.state.requireProject();
    writeMode(view.workspaceRoot, view.project.name, mode);
    this.status.refresh(ctx);
    return `Mode: ${mode.toUpperCase()}${mode === "build" ? " (workers may now change code)" : ""}.`;
  }

  /** Shift+Tab in the editor: switches between Plan and Build. */
  toggle(ctx: ExtensionContext): void {
    const current = this.state.currentMode(this.state.requireProject());
    ctx.ui.notify(this.set(ctx, current === "plan" ? "build" : "plan"), "info");
  }
}
