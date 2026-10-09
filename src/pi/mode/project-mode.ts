import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeMode } from "#io/workspace.ts";
import { errorMessage } from "#core/utils/errors.ts";
import type { State } from "#pi/state.ts";
import type { StatusView } from "#pi/status/status-view.ts";
import type { Mode } from "#core/types.ts";

/** Starts a fresh session from the plan; only a command may replace the session. */
export const BUILD_FRESH_COMMAND = "/radian build --fresh";

export const BUILD_CHOICES = {
  here: "Build here",
  fresh: "Clear context and build from the plan",
  compact: "Compact and build",
} as const;

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

  /**
   * Moves to `next`. Leaving Plan after writing a plan this session asks how to carry the
   * context into Build: keep it, start fresh from the plan, or compact it.
   */
  async change(ctx: ExtensionContext, next: Mode): Promise<string | undefined> {
    const plan = this.state.lastPlan;
    const current = this.state.currentMode(this.state.requireProject());
    if (next !== "build" || current !== "plan" || !plan || !ctx.hasUI) return this.set(ctx, next);
    const choice = await ctx.ui.select(
      `Start building from ${plan}?`,
      Object.values(BUILD_CHOICES),
    );
    if (choice === BUILD_CHOICES.here) return this.set(ctx, "build");
    if (choice === BUILD_CHOICES.compact) return this.compactAndBuild(ctx, plan);
    if (choice === BUILD_CHOICES.fresh) {
      this.state.pi.sendUserMessage(BUILD_FRESH_COMMAND, { expandPromptTemplates: true });
      return undefined;
    }
    return "Still in Plan mode.";
  }

  /** Shift+Tab in the editor: switches between Plan and Build. */
  async toggle(ctx: ExtensionContext): Promise<void> {
    try {
      const current = this.state.currentMode(this.state.requireProject());
      const message = await this.change(ctx, current === "plan" ? "build" : "plan");
      if (message) ctx.ui.notify(message, "info");
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
    }
  }

  private compactAndBuild(ctx: ExtensionContext, plan: string): string {
    const message = this.set(ctx, "build");
    ctx.compact({
      customInstructions: `Keep the plan in ${plan} and the decisions behind it; drop the exploration that led there.`,
    });
    return `${message} Compacting the planning conversation.`;
  }
}
