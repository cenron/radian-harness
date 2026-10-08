import { Type } from "typebox";
import { assertWorkerToolName } from "#core/runtime-args.ts";
import { addWorkerTool, readWorkerTools } from "#io/worker-tools.ts";
import { approveWorkerTool } from "#pi/dialogs.ts";
import type { State } from "#pi/state.ts";
import { tool, type ToolContext } from "#pi/tools/tool.ts";
import type { ToolDependencies } from "#pi/tools/types.ts";

/** `radian_allow_tool`: adds an MCP tool for the project's new workers once the user approves. */
export function allowToolTool({ state }: ToolDependencies) {
  return tool({
    name: "radian_allow_tool",
    description:
      "Ask the user to approve an MCP tool (mcp__<server> or mcp__<server>__<tool>) for this project's workers, for example when a worker reports the tool was denied. Only the user's approval adds it, and it applies to workers dispatched afterwards.",
    parameters: Type.Object({
      tool: Type.String({ description: "e.g. mcp__godot__run_project, or mcp__godot for all" }),
      reason: Type.String({ description: "Why the workers need it, for the user" }),
    }),
    run: async (params, ctx) => allowWorkerTool(state, ctx, params),
  });
}

async function allowWorkerTool(
  state: State,
  ctx: ToolContext,
  request: { tool: string; reason: string },
): Promise<string> {
  assertWorkerToolName(request.tool);
  const { project } = state.requireProject();
  if (readWorkerTools(project.path).includes(request.tool)) {
    return `${request.tool} is already allowed for workers in ${project.name}.`;
  }
  const isApproved = await approveWorkerTool(ctx, { project: project.name, ...request });
  if (!isApproved) return `${request.tool} not allowed: the user said no.`;
  addWorkerTool(project.path, request.tool);
  return `Allowed ${request.tool} for new workers in ${project.name}. Workers already running keep their tools; dispatch a new worker to use it.`;
}
