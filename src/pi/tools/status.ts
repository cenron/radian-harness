import { Type } from "typebox";
import { tool } from "#pi/tools/tool.ts";
import type { ToolDependencies } from "#pi/tools/types.ts";

/** `radian_status`: the project, its mode, and its workers; on the dashboard, the projects. */
export function statusTool({ status }: ToolDependencies) {
  return tool({
    name: "radian_status",
    description:
      "Show the selected project, its mode, and its workers; on the dashboard, list projects.",
    parameters: Type.Object({}),
    run: async () => status.report(),
  });
}
