import { Type } from "typebox";
import { runReadOnlyGit } from "#io/git.ts";
import { tool } from "#pi/tools/tool.ts";
import type { ToolDependencies } from "#pi/tools/types.ts";

const MAX_GIT_OUTPUT_CHARS = 50_000;

/** `radian_git`: read-only git (status, log, diff, show) in the selected project. */
export function gitTool({ state }: ToolDependencies) {
  return tool({
    name: "radian_git",
    description: "Run a read-only git command (status, log, diff, show) in the selected project.",
    parameters: Type.Object({
      args: Type.Array(Type.String(), { description: 'e.g. ["log", "--oneline", "-10"]' }),
    }),
    run: async ({ args }) => {
      const output = await runReadOnlyGit(state.requireProject().project.path, args);
      return output.length > MAX_GIT_OUTPUT_CHARS
        ? `${output.slice(0, MAX_GIT_OUTPUT_CHARS)}\n[truncated; narrow the command]`
        : output || "(no output)";
    },
  });
}
