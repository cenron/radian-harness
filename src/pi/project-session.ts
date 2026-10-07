import { existsSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { RadianError } from "../core/errors.ts";
import { loadConfig } from "../io/config.ts";
import { readJsonFile, writeJsonFile } from "../io/json-file.ts";
import { isWorkspaceRoot, listProjects, projectPaths, type Project } from "../io/workspace.ts";
import type { View } from "./state.ts";

// Each project keeps its own Pi session, tagged with this custom entry. Pi stays one
// process at the workspace root; selecting a project replaces the session.
const PROJECT_TAG = "radian-project";

// Pi rebuilds the extension on every session replacement, so the user's model and
// thinking level are carried across the switch in process-wide state.
const CARRY_KEY = Symbol.for("radian.carried-model");
const MODEL_RETRIES = 50;
const MODEL_RETRY_DELAY_MS = 20;

interface CarriedModel {
  model: ExtensionContext["model"];
  thinking: ReturnType<ExtensionAPI["getThinkingLevel"]>;
}

export class ProjectSession {
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  resolveView(ctx: ExtensionContext, harnessRoot: string): View | undefined {
    if (!isWorkspaceRoot(ctx.cwd)) return undefined;
    const config = loadConfig({ harnessRoot, workspaceRoot: ctx.cwd });
    const tagged = this.sessionProject(ctx);
    const project = listProjects(ctx.cwd).find((candidate) => candidate.name === tagged);
    if (project) this.rememberSession(ctx, project);
    return { workspaceRoot: ctx.cwd, config, project };
  }

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

    this.carryModel(ctx);
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

  async openDashboard(ctx: ExtensionCommandContext): Promise<void> {
    this.assertIdle(ctx);
    this.carryModel(ctx);

    await ctx.newSession({
      withSession: async (next) =>
        next.ui.notify("Workspace dashboard. /projects lists projects.", "info"),
    });
  }

  /** Re-applies the model and thinking level the user had before a project switch. */
  async restoreCarriedModel(ctx: ExtensionContext): Promise<void> {
    const store = globalThis as Record<symbol, CarriedModel | undefined>;
    const carried = store[CARRY_KEY];
    store[CARRY_KEY] = undefined;

    if (!carried) return;

    this.pi.setThinkingLevel(carried.thinking);
    if (!carried.model || this.isSameModel(ctx.model, carried.model)) return;
    // The model's provider may not be usable for a moment after the runtime is replaced.
    for (let attempt = 0; attempt < MODEL_RETRIES; attempt += 1) {
      if (await this.pi.setModel(carried.model)) return;
      await new Promise((resolve) => setTimeout(resolve, MODEL_RETRY_DELAY_MS));
    }
    ctx.ui.notify("Radian could not restore your previous model; check /model.", "warning");
  }

  private sessionProject(ctx: ExtensionContext): string | undefined {
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

  private carryModel(ctx: ExtensionContext): void {
    const store = globalThis as Record<symbol, CarriedModel | undefined>;
    store[CARRY_KEY] = { model: ctx.model, thinking: this.pi.getThinkingLevel() };
  }

  private assertIdle(ctx: ExtensionContext): void {
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      throw new RadianError(
        "busy",
        "Pi is still working; wait for the turn to finish, then switch.",
      );
    }
  }

  private isSameModel(
    current: ExtensionContext["model"],
    wanted: ExtensionContext["model"],
  ): boolean {
    return current?.provider === wanted?.provider && current?.id === wanted?.id;
  }
}
