import { type CommandDefinition, type CommandDependencies } from "#pi/commands/types.ts";
import { refreshStatus, statusReport, workersReport } from "#pi/status-view.ts";
import { RadianError } from "#core/errors.ts";
import { type Mode, parseMode } from "#core/roles.ts";
import { listWorkers } from "#io/worker-store.ts";
import { workersFileOf } from "#workers/worker-env.ts";
import { discardWithApproval, mergeWithApproval } from "#pi/dialogs.ts";
import { stopWorker } from "#workers/finish.ts";
import { readWorkerTools, removeWorkerTool } from "#io/worker-tools.ts";
import type { State } from "#pi/state.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeMode } from "#io/workspace.ts";
import { setCalm } from "#pi/commands/calm.ts";

const RADIAN_USAGE =
  "Usage: /radian status | mode plan|build | calm on|off | workers | merge <worker> | stop <worker> | discard <worker> | tools [remove <tool>]";

/**
 * `/radian`: reports on and controls the selected project.
 *
 * - `/radian` or `/radian status`: the project, its mode, and its workers.
 * - `/radian mode plan|build`: set the mode; Build lets workers change code.
 * - `/radian calm on|off`: collapse the successful tool output or show it.
 * - `/radian workers`: list the project's workers.
 * - `/radian merge <worker>`: merge a worker's work after the user approves.
 * - `/radian discard <worker>`: after the user approves, remove a worker's pane, worktree, branch.
 * - `/radian stop <worker>`: close a worker's pane, keeping its worktree and branch.
 * - `/radian tools [remove <tool>]`: list the MCP tools approved for workers, or remove one.
 */
export function radianCommand({ state }: CommandDependencies): CommandDefinition {
  return {
    name: "radian",
    description:
      "Radian: status, mode plan|build, calm on|off, workers, merge|stop|discard <worker>, tools [remove <tool>]",
    action: async (args, ctx) => {
      const [subcommand = "status", argument] = args;

      switch (subcommand) {
        case "status":
          return statusReport(state);

        case "mode":
          if (!argument) throw new RadianError("usage", RADIAN_USAGE);
          return setMode(state, ctx, parseMode(argument));

        case "calm":
          if (argument !== "on" && argument !== "off") throw new RadianError("usage", RADIAN_USAGE);
          return setCalm(state, argument === "on");

        case "tools":
          return workerToolsCommand(state, args.slice(1));

        case "workers":
          return workersReport(listWorkers(workersFileOf(state.workerEnvOf())));

        case "merge":
        case "discard":
        case "stop": {
          if (!argument) throw new RadianError("usage", RADIAN_USAGE);
          const { env, worker } = state.namedWorker(argument);

          if (subcommand === "merge") return mergeWithApproval(ctx, env, worker);
          if (subcommand === "discard") return discardWithApproval(ctx, env, worker);
          return stopWorker(env, worker);
        }

        default:
          throw new RadianError("usage", RADIAN_USAGE);
      }
    },
  };
}

/** Lists the MCP tools approved for the project's workers, or removes one. */
function workerToolsCommand(state: State, args: string[]): string {
  const { project } = state.requireProject();
  const [action, tool] = args;

  if (action === "remove" && tool) {
    removeWorkerTool(project.path, tool);
    return `Removed ${tool} for new workers in ${project.name}.`;
  }

  if (action !== undefined) throw new RadianError("usage", "Usage: /radian tools [remove <tool>]");

  const tools = readWorkerTools(project.path);
  if (tools.length === 0) return `No extra tools are approved for workers in ${project.name}.`;

  return [
    `Tools approved for workers in ${project.name}:`,
    ...tools.map((name) => `- ${name}`),
  ].join("\n");
}

/** Shift+Tab in the editor: switches the selected project between Plan and Build. */
export function toggleMode(state: State, ctx: ExtensionContext): void {
  const next = state.currentMode(state.requireProject()) === "plan" ? "build" : "plan";
  ctx.ui.notify(setMode(state, ctx, next), "info");
}

function setMode(state: State, ctx: ExtensionContext, mode: Mode): string {
  const view = state.requireProject();

  writeMode(view.workspaceRoot, view.project.name, mode);
  refreshStatus(ctx, state);

  return `Mode: ${mode.toUpperCase()}${mode === "build" ? " (workers may now change code)" : ""}.`;
}
