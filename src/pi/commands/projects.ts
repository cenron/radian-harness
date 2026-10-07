import type { CommandDefinition, CommandDependencies } from "#pi/commands/types.ts";
import {
  addProject,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  projectPaths,
} from "#io/workspace.ts";
import { chooseDeleteAction, chooseProject } from "#pi/dialogs.ts";
import { dashboardReport } from "#pi/status-view.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { RadianError } from "#core/errors.ts";
import { listWorkers } from "#io/worker-store.ts";
import { hasOpenPane } from "#core/worker.ts";
import { getPane } from "#io/herdr.ts";
import type { State } from "#pi/state.ts";

const PROJECTS_USAGE =
  "Usage: /projects [list] | select [name] | create <name> [--branch <branch>] | add <path> --target refs/heads/<branch> | delete <name>";

/**
 * `/projects`: manages the workspace's projects.
 *
 * - `/projects` or `/projects list`: list the projects.
 * - `/projects select [name]`: switch to a project; without a name, pick one from a list.
 * - `/projects create <name> [--branch <branch>]`: create a git repository and select it.
 * - `/projects add <path> --target refs/heads/<branch>`: register an existing repository.
 * - `/projects delete <name>`: remove a project, keeping or deleting its files.
 */
export function projectCommand(deps: CommandDependencies): CommandDefinition {
  return {
    name: "projects",
    description:
      "List, select, create, add, or delete projects: /projects [list] | select [name] | create <name> [--branch <branch>] | add <path> --target refs/heads/<branch> | delete <name>",

    async action(args, ctx) {
      const [subcommand = "list", ...rest] = args;

      switch (subcommand) {
        case "list":
          return listProjectsReport(deps);
        case "select":
          return selectProject(deps, rest[0], ctx);
        case "create":
          return newProject(rest, deps, ctx);
        case "add":
          return registerProject(rest, deps, ctx);
        case "delete":
          return removeProject(rest[0], deps, ctx);
        default:
          throw new RadianError("usage", PROJECTS_USAGE);
      }
    },
  };
}

/** `/projects list`: the workspace's projects, or how to create the first one. */
function listProjectsReport({ state }: CommandDependencies): string {
  const view = state.requireView();
  return dashboardReport(listProjects(view.workspaceRoot));
}

/** `/projects select [name]`: switches to the project's own session, or offers a picker. */
async function selectProject(
  { state, session }: CommandDependencies,
  name: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const view = state.requireView();
  const projects = listProjects(view.workspaceRoot);
  const chosen =
    name ?? (ctx.hasUI && projects.length > 0 ? await chooseProject(ctx, projects) : undefined);

  if (!chosen) return dashboardReport(projects);
  if (view.project?.name === chosen) {
    return `Project ${chosen} is already selected.`;
  }

  const project = getProject(view.workspaceRoot, chosen);
  await session.openProject(ctx, {
    workspaceRoot: view.workspaceRoot,
    project,
  });
}

/**
 * `/projects create <name> [--branch <branch>]`: makes a new repository on `branch` (default
 * `main`) and selects it.
 */
async function newProject(
  args: string[],
  { state, session }: CommandDependencies,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const view = state.requireView();
  const { positional, optionValue: branch } = parseOptions(args, "--branch");

  if (!positional)
    throw new RadianError("usage", "Usage: /projects create <name> [--branch <branch>]");

  const project = await createProject(view.workspaceRoot, {
    name: positional,
    branch: branch ?? "main",
  });

  await session.openProject(ctx, { workspaceRoot: view.workspaceRoot, project });
  return undefined;
}

/**
 * `/projects add <path> --target refs/heads/<branch>`: registers an existing repository and selects
 * it; workers merge into `target`.
 */
async function registerProject(
  args: string[],
  { state, session }: CommandDependencies,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const view = state.requireView();
  const { positional, optionValue: target } = parseOptions(args, "--target");

  if (!positional || !target) {
    throw new RadianError("usage", "Usage: /projects add <path> --target refs/heads/<branch>");
  }

  const project = await addProject(view.workspaceRoot, { path: positional, target });
  await session.openProject(ctx, { workspaceRoot: view.workspaceRoot, project });
  return undefined;
}

/**
 * `/projects delete <name>`: refused while workers run; otherwise asks to keep or delete the files.
 * Deleting the selected project returns Pi to the dashboard.
 */
async function removeProject(
  name: string | undefined,
  { state, session }: CommandDependencies,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const view = state.requireView();

  if (!name) throw new RadianError("usage", "Usage: /projects delete <name>");

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

  await session.openDashboard(ctx);
  return undefined;
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

/** Records can be stale after a restart, so each open pane is checked with Herdr. */
async function assertNoLiveWorkers(state: State, projectName: string): Promise<void> {
  const view = state.requireView();
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
