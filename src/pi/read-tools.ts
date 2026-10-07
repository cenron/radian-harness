import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { RadianError } from "../core/errors.ts";

export interface ReadScope {
  root: string;
  /** Directories outside the project that may still be read, such as loaded skills. */
  extraRoots: readonly string[];
}

export const READ_TOOL_NAMES = ["read", "ls", "grep", "find"] as const;

const CREATORS = {
  read: createReadToolDefinition,
  ls: createLsToolDefinition,
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
};

/**
 * Pi resolves its own read tools against the workspace root, so Radian replaces them
 * with the same tools rooted at the selected project and refuses paths that leave it.
 */
export function createConfinedReadTools(
  scopeNow: () => ReadScope,
  templateRoot: string,
): ToolDefinition[] {
  return READ_TOOL_NAMES.map((name) => {
    const template = CREATORS[name](templateRoot) as unknown as ToolDefinition;
    return {
      ...template,
      async execute(toolCallId, params, ...context) {
        const scope = scopeNow();
        const input = params as { path?: string };
        const confined = { ...input, path: confinePath(scope, input.path) };
        const tool = CREATORS[name](scope.root) as unknown as ToolDefinition;
        return tool.execute(toolCallId, confined, ...context);
      },
    };
  });
}

/** An absolute path inside the scope; links are resolved first so they cannot lead outside. */
export function confinePath(scope: ReadScope, input: string | undefined): string {
  const raw = (input ?? "").trim().replace(/^@/, "") || ".";
  const absolute = path.resolve(scope.root, raw);
  const real = realPathOfNearestExisting(absolute);
  const roots = [scope.root, ...scope.extraRoots].map(realPathOfNearestExisting);
  if (!roots.some((root) => real === root || real.startsWith(root + path.sep))) {
    throw new RadianError("outside_project", `${raw} is outside the selected project.`);
  }
  return absolute;
}

function realPathOfNearestExisting(target: string): string {
  let current = target;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return target;
    current = parent;
  }
  return path.join(realpathSync(current), path.relative(current, target));
}
