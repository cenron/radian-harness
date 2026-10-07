import {
  getAgentDir,
  loadProjectContextFiles,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../core/errors.ts";
import { listProjects, projectPaths } from "../io/workspace.ts";
import { resolveView, restoreCarriedModel } from "./activation.ts";
import { calmResolver, readCalm } from "./calm.ts";
import { registerCommands, toggleMode } from "./commands.ts";
import { guardToolCall } from "./guard.ts";
import { modeEditorFactory } from "./mode-editor.ts";
import { READ_TOOL_NAMES, createConfinedReadTools, type ReadScope } from "./read-tools.ts";
import { currentMode, type RadianDeps, type RadianState } from "./state.ts";
import { clearStatus, refreshStatus } from "./status-view.ts";
import { RADIAN_TOOL_NAMES, registerTools } from "./tools.ts";
import { startWatcher } from "./watcher.ts";

export function registerRadian(pi: ExtensionAPI, deps: RadianDeps): void {
  const state: RadianState = {
    pi,
    deps,
    view: undefined,
    skillRoots: [],
    isCalm: false,
    stopWatcher: undefined,
  };
  for (const tool of createConfinedReadTools(() => readScope(state), process.cwd()))
    pi.registerTool(tool);
  registerTools(state);
  registerCommands(state);
  pi.registerToolRenderer(calmResolver(() => state.isCalm));
  pi.on("session_start", (_event, ctx) => startSession(state, ctx));
  pi.on("session_shutdown", (_event, ctx) => endSession(state, ctx));
  pi.on("tool_call", (event) => (state.view ? guardToolCall(event.toolName) : undefined));
  pi.on("before_agent_start", (event) => {
    describeForModel(state, event.systemPromptOptions);
    return undefined;
  });
}

async function startSession(state: RadianState, ctx: ExtensionContext): Promise<void> {
  try {
    state.view = resolveView(ctx, state.deps.harnessRoot);
  } catch (error) {
    ctx.ui.notify(`Radian is inactive: ${errorMessage(error)}`, "error");
    return;
  }
  const view = state.view;
  if (!view) return;
  await restoreCarriedModel(state.pi, ctx);
  state.isCalm = readCalm(view.workspaceRoot, view.config.harness.calm);
  const projectTools = view.project ? RADIAN_TOOL_NAMES : ["radian_status"];
  state.pi.setActiveTools([...projectTools, ...READ_TOOL_NAMES]);
  if (view.project) {
    if (ctx.mode === "tui")
      ctx.ui.setEditorComponent(modeEditorFactory(() => toggleMode(state, ctx)));
    state.stopWatcher = startWatcher(state, ctx);
  }
  refreshStatus(ctx, state);
}

function endSession(state: RadianState, ctx: ExtensionContext): void {
  state.stopWatcher?.();
  state.stopWatcher = undefined;
  if (!state.view) return;
  if (ctx.mode === "tui") ctx.ui.setEditorComponent(undefined);
  clearStatus(ctx);
}

/** Points the model at the selected project: its root, its context files, and Radian's rules. */
function describeForModel(state: RadianState, options: BuildSystemPromptOptions): void {
  const view = state.view;
  if (!view) return;
  state.skillRoots = (options.skills ?? []).map((skill) => skill.baseDir);
  options.sections ??= {};
  if (!view.project) {
    const names = listProjects(view.workspaceRoot).map((project) => project.name);
    options.sections.radian = `Radian workspace dashboard; no project is selected. Projects: ${names.join(", ") || "none"}. The user selects one with /projects <name> or creates one with /new-project <name>.`;
    return;
  }
  const project = view.project;
  options.cwd = project.path;
  options.contextFiles = loadProjectContextFiles({ cwd: project.path, agentDir: getAgentDir() });
  options.sections.radian = [
    `Radian project ${project.name} at ${project.path}; workers merge into ${project.target}.`,
    `Mode: ${currentMode({ ...view, project }).toUpperCase()}.`,
    "You coordinate and never edit files or run commands yourself; follow the radian-coordinator skill.",
  ].join(" ");
}

/**
 * The selected project, plus its workers' worktrees and files (brief, status, report), so Pi can
 * review a worker's work before offering a merge. All of it is read-only for Pi.
 */
function readScope(state: RadianState): ReadScope {
  const view = state.view;
  if (!view?.project) {
    return { root: view?.workspaceRoot ?? process.cwd(), extraRoots: state.skillRoots };
  }
  const paths = projectPaths(view.workspaceRoot, view.project.name);
  return {
    root: view.project.path,
    extraRoots: [...state.skillRoots, paths.worktreesDir, paths.workersDir],
  };
}
