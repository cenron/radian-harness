import { Type } from "typebox";
import { sendToWorker, stopWorker } from "#workers/finish.ts";
import { discardWithApproval, mergeWithApproval } from "#pi/dialogs.ts";
import { tool } from "#pi/tools/tool.ts";
import type { ToolDependencies } from "#pi/tools/types.ts";

const workerParameter = Type.String({ description: "Worker name, e.g. demo-developer-1" });

/** `radian_workers`: the selected project's workers with their state and last status. */
export function workersTool({ status }: ToolDependencies) {
  return tool({
    name: "radian_workers",
    description: "List the selected project's workers with their state and last status.",
    parameters: Type.Object({}),
    run: async () => status.workersReport(),
  });
}

/** `radian_send`: types a message into a worker's session, for example an answer. */
export function sendTool({ state }: ToolDependencies) {
  return tool({
    name: "radian_send",
    description: "Type a message into a worker's session, for example to answer its question.",
    parameters: Type.Object({ worker: workerParameter, text: Type.String() }),
    run: async ({ worker, text }) => {
      const named = state.namedWorker(worker);
      return sendToWorker(named.env, named.worker, text);
    },
  });
}

/** `radian_stop`: closes a worker's pane and keeps its worktree and branch. */
export function stopTool({ state }: ToolDependencies) {
  return tool({
    name: "radian_stop",
    description: "Close a worker's pane. Its worktree and branch are kept.",
    parameters: Type.Object({ worker: workerParameter }),
    run: async ({ worker }) => {
      const named = state.namedWorker(worker);
      return stopWorker(named.env, named.worker);
    },
  });
}

/** `radian_merge`: merges a worker's branch only after the user approves in a dialog. */
export function mergeTool({ state }: ToolDependencies) {
  return tool({
    name: "radian_merge",
    description:
      "Ask the user to approve merging a worker's branch into the target branch. Only the user's approval merges; report exactly what this tool returns.",
    parameters: Type.Object({ worker: workerParameter }),
    run: async ({ worker }, ctx) => {
      const named = state.namedWorker(worker);
      return mergeWithApproval(ctx, named.env, named.worker);
    },
  });
}

/** `radian_discard`: removes a worker's pane, worktree, and branch only after the user approves. */
export function discardTool({ state }: ToolDependencies) {
  return tool({
    name: "radian_discard",
    description:
      "Ask the user to approve throwing a worker's work away: its pane, worktree, and branch are removed without merging. Use it for failed launches, rejected changes, or the losing side of a conflict. Only the user's approval discards; report exactly what this tool returns.",
    parameters: Type.Object({ worker: workerParameter }),
    run: async ({ worker }, ctx) => {
      const named = state.namedWorker(worker);
      return discardWithApproval(ctx, named.env, named.worker);
    },
  });
}
