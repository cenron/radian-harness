import { allowToolTool } from "#pi/tools/allow-tool.ts";
import { dispatchTool } from "#pi/tools/dispatch.ts";
import { gitTool } from "#pi/tools/git.ts";
import { statusTool } from "#pi/tools/status.ts";
import type { ToolDependencies } from "#pi/tools/types.ts";
import { discardTool, mergeTool, sendTool, stopTool, workersTool } from "#pi/tools/workers.ts";
import { writeDocTool } from "#pi/tools/write-doc.ts";

/** The tools Pi gets for a selected project; on the dashboard it gets only `radian_status`. */
export const RADIAN_TOOL_NAMES = [
  "radian_status",
  "radian_write_doc",
  "radian_git",
  "radian_dispatch",
  "radian_workers",
  "radian_send",
  "radian_stop",
  "radian_merge",
  "radian_discard",
  "radian_allow_tool",
];

/** Registers Radian's coordinator tools with Pi. */
export function registerTools(deps: ToolDependencies): void {
  for (const definition of createTools(deps)) deps.state.pi.registerTool(definition);
}

function createTools(deps: ToolDependencies) {
  return [
    statusTool(deps),
    writeDocTool(deps),
    gitTool(deps),
    dispatchTool(deps),
    workersTool(deps),
    sendTool(deps),
    stopTool(deps),
    mergeTool(deps),
    discardTool(deps),
    allowToolTool(deps),
  ];
}
