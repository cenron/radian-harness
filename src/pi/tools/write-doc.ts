import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { RadianError } from "#core/errors.ts";
import type { State } from "#pi/state.ts";
import { tool } from "#pi/tools/tool.ts";
import type { ToolDependencies } from "#pi/tools/types.ts";

const PLANNING_DIR = path.join(".radian", "planning");

/** `radian_write_doc`: Pi's only way to write a file, confined to the project's planning folder. */
export function writeDocTool({ state }: ToolDependencies) {
  return tool({
    name: "radian_write_doc",
    description:
      "Write a planning document under the project's .radian/planning/ folder (not tracked by git).",
    parameters: Type.Object({
      path: Type.String({
        description: "Path relative to .radian/planning/, e.g. login-plan.md",
      }),
      content: Type.String(),
    }),
    run: async ({ path: relative, content }) => writeDoc(state, relative, content),
  });
}

function writeDoc(state: State, relative: string, content: string): string {
  const normalized = path.normalize(relative);
  if (path.isAbsolute(normalized) || normalized.startsWith("..") || normalized === ".") {
    throw new RadianError(
      "invalid_path",
      `${relative} must be a relative path inside .radian/planning/.`,
    );
  }
  const file = path.join(state.requireProject().project.path, PLANNING_DIR, normalized);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  state.lastPlan = path.join(PLANNING_DIR, normalized);
  return `Wrote ${state.lastPlan}.`;
}
