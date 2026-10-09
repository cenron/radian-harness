import { existsSync } from "node:fs";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RadianError } from "#core/errors.ts";
import { loadConfig } from "#core/config.ts";
import { readJsonFile, writeJsonFile } from "#core/utils/json.ts";
import { isWorkspaceRoot, listProjects, projectPaths, type Project } from "#io/workspace.ts";
import type { View } from "#pi/state.ts";
import type { ModelCarry } from "#pi/session/model-carry.ts";

// Each project keeps its own Pi session, tagged with this custom entry. Pi stays one
// process at the workspace root; selecting a project replaces the session.
const PROJECT_TAG = "radian-project";

/** Which project a Pi session belongs to, and switching between project sessions. */
export class ProjectSession {
  private readonly harnessRoot: string;
  private readonly carry: ModelCarry;

  constructor(harnessRoot: string, carry: ModelCarry) {
    this.harnessRoot = harnessRoot;
    this.carry = carry;
  }

  /** What this session shows: undefined outside a workspace, else the dashboard or its project. */
  resolveView(ctx: ExtensionContext): View | undefined {
    if (!isWorkspaceRoot(ctx.cwd)) return undefined;
    const config = loadConfig({ harnessRoot: this.harnessRoot, workspaceRoot: ctx.cwd });
    const tagged = this.taggedProject(ctx);
    const project = listProjects(ctx.cwd).find((candidate) => candidate.name === tagged);
    if (project) this.rememberSession(ctx, project);
    return { workspaceRoot: ctx.cwd, config, project };
  }

  /** Switches to the project's latest session, or starts one tagged with the project. */
  async openProject(
    ctx: ExtensionCommandContext,
    input: { workspaceRoot: string; project: Project },
  ): Promise<void> {
    this.assertIdle(ctx);
    const notice = `Project ${input.project.name} selected.`;
    const withSession = async (next: ExtensionCommandContext) => next.ui.notify(notice, "info");
    const reference = readJsonFile<{ sessionFile?: string }>(
      projectPaths(input.workspaceRoot, input.project.name).sessionFile,
      {},
    );

    this.carry.save(ctx);
    if (reference.sessionFile && existsSync(reference.sessionFile)) {
      await ctx.switchSession(reference.sessionFile, { withSession });
      return;
    }

    await ctx.newSession({
      setup: async (sessionManager) => {
        sessionManager.appendCustomEntry(PROJECT_TAG, { project: input.project.name });
      },
      withSession,
    });
  }

  /** Starts an untagged session: the workspace dashboard. */
  async openDashboard(ctx: ExtensionCommandContext): Promise<void> {
    this.assertIdle(ctx);
    this.carry.save(ctx);

    await ctx.newSession({
      withSession: async (next) =>
        next.ui.notify("Workspace dashboard. /projects lists projects.", "info"),
    });
  }

  private taggedProject(ctx: ExtensionContext): string | undefined {
    const tag = ctx.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === PROJECT_TAG)
      .at(-1);
    return (tag as { data?: { project?: string } } | undefined)?.data?.project;
  }

  /** Follows the project's latest session, including one reached through Pi's own /resume. */
  private rememberSession(ctx: ExtensionContext, project: Project): void {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    writeJsonFile(projectPaths(ctx.cwd, project.name).sessionFile, { sessionFile });
  }

  private assertIdle(ctx: ExtensionContext): void {
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      throw new RadianError(
        "busy",
        "Pi is still working; wait for the turn to finish, then switch.",
      );
    }
  }
}
