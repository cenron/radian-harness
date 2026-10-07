import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RadianError, errorMessage } from "../core/errors.ts";
import { parseMode, type Mode } from "../core/roles.ts";
import { hasOpenPane } from "../core/worker.ts";
import { getPane } from "../io/herdr.ts";
import { listWorkers } from "../io/worker-store.ts";
import {
  addProject,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  projectPaths,
  writeMode,
} from "../io/workspace.ts";
import { stopWorker } from "../workers/finish.ts";
import { workersFileOf } from "../workers/worker-env.ts";
import { openDashboard, openProject } from "./activation.ts";
import { writeCalm } from "./calm.ts";
import {
  chooseDeleteAction,
  chooseProject,
  discardWithApproval,
  mergeWithApproval,
} from "./dialogs.ts";
import {
  currentMode,
  namedWorker,
  requireProject,
  requireView,
  workerEnvOf,
  type RadianState,
} from "./state.ts";
import { dashboardReport, refreshStatus, statusReport, workersReport } from "./status-view.ts";

type CommandAction = (args: string[], ctx: ExtensionCommandContext) => Promise<string | undefined>;

const RADIAN_USAGE =
  "Usage: /radian status | mode plan|build | calm on|off | workers | merge <worker> | stop <worker> | discard <worker>";

export function registerCommands(state: RadianState): void {
  const commands: Record<string, { description: string; action: CommandAction }> = {
    projects: {
      description: "List the workspace's projects, or select one: /projects [name]",
      action: (args, ctx) => selectProject(state, args[0], ctx),
    },
    workspace: {
      description: "Return to the workspace dashboard",
      action: (_args, ctx) => showDashboard(state, ctx),
    },
    "new-project": {
      description: "Create a project: /new-project <name> [--branch <branch>]",
      action: (args, ctx) => newProject(state, args, ctx),
    },
    "add-project": {
      description:
        "Register an existing repository: /add-project <path> --target refs/heads/<branch>",
      action: (args, ctx) => registerProject(state, args, ctx),
    },
    "delete-project": {
      description:
        "Remove a project from the workspace, optionally deleting its files: /delete-project <name>",
      action: (args, ctx) => removeProject(state, args[0], ctx),
    },
    calm: {
      description: "Toggle Calm (collapse successful tool output), or set it: /calm [on|off]",
      action: async (args) => toggleCalm(state, args[0]),
    },
    radian: {
      description:
        "Radian: status, mode plan|build, calm on|off, workers, merge|stop|discard <worker>",
      action: (args, ctx) => radianCommand(state, args, ctx),
    },
  };
  for (const [name, command] of Object.entries(commands)) {
    state.pi.registerCommand(name, {
      description: command.description,
      handler: (args, ctx) => runCommand(ctx, () => command.action(splitArguments(args), ctx)),
    });
  }
}

function setMode(state: RadianState, ctx: ExtensionContext, mode: Mode): string {
  const view = requireProject(state);
  writeMode(view.workspaceRoot, view.project.name, mode);
  refreshStatus(ctx, state);
  return `Mode: ${mode.toUpperCase()}${mode === "build" ? " (workers may now change code)" : ""}.`;
}

export function toggleMode(state: RadianState, ctx: ExtensionContext): void {
  const next = currentMode(requireProject(state)) === "plan" ? "build" : "plan";
  ctx.ui.notify(setMode(state, ctx, next), "info");
}

async function selectProject(
  state: RadianState,
  name: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const view = requireView(state);
  const projects = listProjects(view.workspaceRoot);
  const chosen =
    name ?? (ctx.hasUI && projects.length > 0 ? await chooseProject(ctx, projects) : undefined);
  if (!chosen) return dashboardReport(projects);
  if (view.project?.name === chosen) return `Project ${chosen} is already selected.`;
  const project = getProject(view.workspaceRoot, chosen);
  await openProject(ctx, state.pi, { workspaceRoot: view.workspaceRoot, project });
  return undefined;
}

async function showDashboard(
  state: RadianState,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  if (!requireView(state).project) return "Already on the workspace dashboard.";
  await openDashboard(ctx, state.pi);
  return undefined;
}

async function newProject(
  state: RadianState,
  args: string[],
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const view = requireView(state);
  const { positional, optionValue: branch } = parseOptions(args, "--branch");
  if (!positional) throw new RadianError("usage", "Usage: /new-project <name> [--branch <branch>]");
  const project = await createProject(view.workspaceRoot, {
    name: positional,
    branch: branch ?? "main",
  });
  await openProject(ctx, state.pi, { workspaceRoot: view.workspaceRoot, project });
  return undefined;
}

async function registerProject(
  state: RadianState,
  args: string[],
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const view = requireView(state);
  const { positional, optionValue: target } = parseOptions(args, "--target");
  if (!positional || !target) {
    throw new RadianError("usage", "Usage: /add-project <path> --target refs/heads/<branch>");
  }
  const project = await addProject(view.workspaceRoot, { path: positional, target });
  await openProject(ctx, state.pi, { workspaceRoot: view.workspaceRoot, project });
  return undefined;
}

async function removeProject(
  state: RadianState,
  name: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const view = requireView(state);
  if (!name) throw new RadianError("usage", "Usage: /delete-project <name>");
  const project = getProject(view.workspaceRoot, name);
  await assertNoLiveWorkers(state, project.name);
  const choice = await chooseDeleteAction(ctx, project);
  if (!choice) return `Kept project ${name}.`;
  await deleteProject(view.workspaceRoot, { name, shouldDeleteFiles: choice === "delete-files" });
  const message =
    choice === "delete-files"
      ? `Deleted project ${name} and its files.`
      : `Removed project ${name}; its files are kept at ${project.path}.`;
  if (view.project?.name !== name) return message;
  ctx.ui.notify(message, "info");
  await openDashboard(ctx, state.pi);
  return undefined;
}

async function radianCommand(
  state: RadianState,
  args: string[],
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const [subcommand = "status", argument] = args;
  if (subcommand === "status") return statusReport(state);
  if (subcommand === "mode" && argument) return setMode(state, ctx, parseMode(argument));
  if (subcommand === "calm" && (argument === "on" || argument === "off"))
    return setCalm(state, argument === "on");
  if (subcommand === "workers")
    return workersReport(listWorkers(workersFileOf(workerEnvOf(state))));
  if (!argument || !["merge", "stop", "discard"].includes(subcommand)) {
    throw new RadianError("usage", RADIAN_USAGE);
  }
  const { env, worker } = namedWorker(state, argument);
  if (subcommand === "merge") return mergeWithApproval(ctx, env, worker);
  if (subcommand === "discard") return discardWithApproval(ctx, env, worker);
  return stopWorker(env, worker);
}

function toggleCalm(state: RadianState, setting: string | undefined): string {
  if (setting === undefined) return setCalm(state, !state.isCalm);
  if (setting === "on" || setting === "off") return setCalm(state, setting === "on");
  throw new RadianError("usage", "Usage: /calm [on|off]");
}

function setCalm(state: RadianState, isCalm: boolean): string {
  writeCalm(requireView(state).workspaceRoot, isCalm);
  state.isCalm = isCalm;
  return `Calm ${isCalm ? "on: successful tool output is collapsed" : "off"}.`;
}

/** Records can be stale after a restart, so each open pane is checked with Herdr. */
async function assertNoLiveWorkers(state: RadianState, projectName: string): Promise<void> {
  const view = requireView(state);
  const workers = listWorkers(projectPaths(view.workspaceRoot, projectName).workersFile);
  const live = [];
  for (const worker of workers.filter(hasOpenPane)) {
    if (worker.pane && (await getPane(state.deps.herdr, worker.pane))) live.push(worker.name);
  }
  if (live.length > 0) {
    throw new RadianError(
      "workers_live",
      `Project ${projectName} still has running workers: ${live.join(", ")}. Stop, merge, or discard them first.`,
    );
  }
}

async function runCommand(
  ctx: ExtensionContext,
  action: () => Promise<string | undefined>,
): Promise<void> {
  try {
    const message = await action();
    if (message) ctx.ui.notify(message, "info");
  } catch (error) {
    ctx.ui.notify(errorMessage(error), "error");
  }
}

function splitArguments(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}

function parseOptions(
  args: string[],
  option: string,
): { positional?: string; optionValue?: string } {
  const index = args.indexOf(option);
  const optionPositions = index === -1 ? [] : [index, index + 1];
  return {
    positional: args.find((_arg, position) => !optionPositions.includes(position)),
    optionValue: index === -1 ? undefined : args[index + 1],
  };
}
