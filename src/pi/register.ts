import {
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  loadProjectContextFiles,
} from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../core/errors.ts";
import { listProjects, projectPaths } from "../io/workspace.ts";
import { calmResolver, readCalm } from "./calm.ts";
import { guardToolCall } from "./guard.ts";
import { modeEditorFactory } from "./mode-editor.ts";
import { createConfinedReadTools, READ_TOOL_NAMES, type ReadScope } from "./read-tools.ts";
import { type RadianDeps, State } from "./state.ts";
import { clearStatus, refreshStatus } from "./status-view.ts";
import { RADIAN_TOOL_NAMES, registerTools } from "./tools.ts";
import { startWatcher } from "./watcher.ts";
import { ProjectSession } from "./project-session.ts";
import { registerCommands } from "#pi/commands/index.ts";
import { toggleMode } from "#pi/commands/radian.ts";

export class RegisterRadian {
  state: State;
  session: ProjectSession;

  constructor(pi: ExtensionAPI, deps: RadianDeps) {
    this.state = new State(pi, deps);
    this.session = new ProjectSession(pi);
  }

  initialize(): void {
    const pi = this.state.pi;

    for (const tool of createConfinedReadTools(() => this.readScope(), process.cwd()))
      pi.registerTool(tool);

    registerTools(this.state);
    registerCommands({ state: this.state, session: this.session });
    pi.registerToolRenderer(calmResolver(() => this.state.isCalm));

    pi.on("session_start", (_event, ctx) => this.startSession(ctx));
    pi.on("session_shutdown", (_event, ctx) => this.endSession(ctx));
    pi.on("tool_call", (event) => (this.state.view ? guardToolCall(event.toolName) : undefined));
    pi.on("before_agent_start", (event) => {
      this.describeForModel(event.systemPromptOptions);
      return undefined;
    });
  }

  async startSession(ctx: ExtensionContext): Promise<void> {
    try {
      this.state.view = this.session.resolveView(ctx, this.state.deps.harnessRoot);
    } catch (error) {
      ctx.ui.notify(`Radian is inactive: ${errorMessage(error)}`, "error");
      return;
    }

    const view = this.state.view;
    if (!view) return;

    await this.session.restoreCarriedModel(ctx);
    this.state.isCalm = readCalm(view.workspaceRoot, view.config.harness.calm);

    const projectTools = view.project ? RADIAN_TOOL_NAMES : ["radian_status"];
    this.state.pi.setActiveTools([...projectTools, ...READ_TOOL_NAMES]);

    if (!view.project) return refreshStatus(ctx, this.state);

    if (ctx.mode === "tui")
      ctx.ui.setEditorComponent(modeEditorFactory(() => toggleMode(this.state, ctx)));

    this.state.stopWatcher = startWatcher(this.state, ctx);
    refreshStatus(ctx, this.state);
  }

  endSession(ctx: ExtensionContext): void {
    this.state.stopWatcher?.();
    this.state.stopWatcher = undefined;
    if (!this.state.view) return;
    if (ctx.mode === "tui") ctx.ui.setEditorComponent(undefined);
    clearStatus(ctx);
  }

  /** Points the model at the selected project: its root, its context files, and Radian's rules. */
  describeForModel(options: BuildSystemPromptOptions): void {
    const view = this.state.view;
    if (!view) return;
    this.state.skillRoots = (options.skills ?? []).map((skill) => skill.baseDir);
    options.sections ??= {};
    if (!view.project) {
      const names = listProjects(view.workspaceRoot).map((project) => project.name);
      options.sections.radian = `Radian workspace dashboard; no project is selected. Projects: ${names.join(", ") || "none"}. The user selects one with /projects select <name> or creates one with /projects create <name>.`;
      return;
    }
    const project = view.project;
    options.cwd = project.path;
    options.contextFiles = loadProjectContextFiles({ cwd: project.path, agentDir: getAgentDir() });
    options.sections.radian = [
      `Radian project ${project.name} at ${project.path}; workers merge into ${project.target}.`,
      `Mode: ${this.state.currentMode({ ...view, project }).toUpperCase()}.`,
      "You coordinate and never edit files or run commands yourself; follow the radian-coordinator skill.",
    ].join(" ");
  }

  /**
   * The selected project, plus its workers' worktrees and files (brief, status, report), so Pi can
   * review a worker's work before offering a merge. All of it is read-only for Pi.
   */
  readScope(): ReadScope {
    const view = this.state.view;
    if (!view?.project) {
      return { root: view?.workspaceRoot ?? process.cwd(), extraRoots: this.state.skillRoots };
    }
    const paths = projectPaths(view.workspaceRoot, view.project.name);
    return {
      root: view.project.path,
      extraRoots: [...this.state.skillRoots, paths.worktreesDir, paths.workersDir],
    };
  }
}
