// Workspace layout conventions. All Radian-owned runtime state lives under the
// workspace's `.radian/` directory, outside every project checkout:
//
//   <workspace>/.radian/workspace.json            workspace identity
//   <workspace>/.radian/manifest.json             installer ownership manifest
//   <workspace>/.radian/config/                   user-owned workspace overrides
//   <workspace>/.radian/state/projects.json       explicit project registry
//   <workspace>/.radian/state/capacity/           workspace-wide reservations
//   <workspace>/.radian/projects/<id>/state/      project coordinator state (protected)
//   <workspace>/.radian/projects/<id>/exchange/   per-assignment worker output
//   <workspace>/.radian/projects/<id>/scratch/    per-assignment private scratch
//   <workspace>/.radian/projects/<id>/worktrees/  owned worktrees
//   <workspace>/.radian/projects/<id>/projections/ short-lived credential projections
//
// Projects only receive an owned package entry in `.pi/settings.json` and, if the
// user chooses, project overrides under `.radian/config/`.

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export const RADIAN_DIR = ".radian";
export const WORKSPACE_FILE = path.join(RADIAN_DIR, "workspace.json");

export interface WorkspacePaths {
  root: string;
  radian: string;
  workspaceFile: string;
  manifest: string;
  config: string;
  state: string;
  registry: string;
  journal: string;
}

export interface ProjectPaths {
  id: string;
  root: string;
  state: string;
  exchange: string;
  scratch: string;
  worktrees: string;
  projections: string;
}

export function workspacePaths(root: string): WorkspacePaths {
  const radian = path.join(root, RADIAN_DIR);
  return {
    root,
    radian,
    workspaceFile: path.join(radian, "workspace.json"),
    manifest: path.join(radian, "manifest.json"),
    config: path.join(radian, "config"),
    state: path.join(radian, "state"),
    registry: path.join(radian, "state", "projects.json"),
    journal: path.join(radian, "journal"),
  };
}

export function projectPaths(workspaceRoot: string, projectId: string): ProjectPaths {
  const root = path.join(workspaceRoot, RADIAN_DIR, "projects", projectId);
  return {
    id: projectId,
    root,
    state: path.join(root, "state"),
    exchange: path.join(root, "exchange"),
    scratch: path.join(root, "scratch"),
    worktrees: path.join(root, "worktrees"),
    projections: path.join(root, "projections"),
  };
}

/** All ancestor directories (nearest first) that hold a Radian workspace marker. */
export function workspaceAncestors(start: string): string[] {
  let current: string;
  try {
    current = realpathSync(start);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (;;) {
    if (existsSync(path.join(current, WORKSPACE_FILE))) found.push(current);
    const parent = path.dirname(current);
    if (parent === current) return found;
    current = parent;
  }
}
