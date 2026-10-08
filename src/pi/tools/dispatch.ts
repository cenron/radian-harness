import { Type } from "typebox";
import { ROLES, parseRole } from "#core/roles.ts";
import { isWaitingForUser } from "#workers/delivery.ts";
import { dispatchWorker } from "#workers/dispatch.ts";
import { tool } from "#pi/tools/tool.ts";
import type { ToolDependencies } from "#pi/tools/types.ts";

/** `radian_dispatch`: starts a worker in its own pane and worktree, and says what happens next. */
export function dispatchTool({ state }: ToolDependencies) {
  return tool({
    name: "radian_dispatch",
    description:
      "Start a worker in its own Herdr pane and git worktree. Developer, tester, and reviewer need Build mode; a scout may run in Plan mode. The task must be self-contained: the worker sees only its brief.",
    parameters: Type.Object({
      role: Type.Union(ROLES.map((role) => Type.Literal(role))),
      title: Type.String({ description: "Short title for the pane, e.g. Add login form" }),
      task: Type.String({ description: "Everything the worker needs to know" }),
      profile: Type.Optional(
        Type.String({ description: "Profile name; omit for the role default" }),
      ),
      fromWorker: Type.Optional(Type.String({ description: "Start from this worker's branch" })),
    }),
    run: async (params) => {
      const view = state.requireProject();
      const request = { ...params, role: parseRole(params.role) };
      const worker = await dispatchWorker(state.workerEnvOf(), request, state.currentMode(view));
      const started = `Started ${worker.name} (${worker.runtime} ${worker.model}, effort ${worker.effort}) in pane ${worker.pane} on branch ${worker.branch}.`;
      if (isWaitingForUser(worker)) {
        return `${started} Its agent is asking a startup question (for example, whether to trust the worktree folder). Ask the user to answer it in pane ${worker.pane}; Radian types in the task once the agent is ready.`;
      }
      if (worker.isTaskPending) {
        return `${started} Radian types in the task as soon as the agent is ready. Its status updates arrive as messages.`;
      }
      return `${started} Its status updates arrive as messages.`;
    },
  });
}
