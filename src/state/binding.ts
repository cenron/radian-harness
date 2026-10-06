// Project binding identity checks used before a run starts. Bindings are
// written by the workspace installer (milestone 09); here they are verified so
// that unregistered, moved, nested, or duplicate bindings fail closed.

import { realpathSync } from "node:fs";
import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { WORKSPACE_FILE, workspaceAncestors, workspacePaths } from "../workspace/layout.ts";
import { readJsonIfExists } from "./fsutil.ts";

export interface WorkspaceRecord {
  schema: "radian.workspace/1";
  workspace: string;
  canonicalRoot: string;
}

export interface WorkspaceRegistry {
  schema: "radian.workspace-registry/1";
  workspace: string;
  projects: Array<{ project: string; canonicalPath: string; target?: string }>;
}

export interface ResolvedBinding {
  workspace: string;
  workspaceRoot: string;
  project: string;
  canonicalPath: string;
}

/**
 * Resolve the managed binding for a project directory: exactly one enclosing
 * workspace (nested workspaces are ambiguous), a workspace record that matches
 * its location, and exactly one registry entry for the project's canonical path.
 */
export function checkProjectBinding(projectRoot: string): Outcome<ResolvedBinding> {
  let canonical: string;
  try {
    canonical = realpathSync(projectRoot);
  } catch {
    return refuse("INSTALL_TARGET_INVALID", "project path cannot be resolved");
  }
  const all = workspaceAncestors(canonical);
  if (all.includes(canonical)) return refuse("INSTALL_TARGET_INVALID", "a workspace root cannot itself be a registered project");
  const unique = all;
  if (unique.length === 0) return refuse("INSTALL_TARGET_INVALID", "project is not inside a Radian workspace", "Install Radian into the workspace and register this project explicitly.");
  if (unique.length > 1) return refuse("DUPLICATE_BINDING", "project is inside more than one Radian workspace", "Remove the nested workspace binding.");
  const workspaceRoot = unique[0]!;
  const record = readJsonIfExists(path.join(workspaceRoot, WORKSPACE_FILE));
  if (record.state !== "ok") return refuse("INSTALL_TARGET_INVALID", "workspace record is unreadable");
  const ws = record.value as WorkspaceRecord;
  if (ws.canonicalRoot !== workspaceRoot) return refuse("DUPLICATE_BINDING", "workspace record belongs to another location (moved or copied workspace)", "Re-install the workspace explicitly.");
  const registryRead = readJsonIfExists(workspacePaths(workspaceRoot).registry);
  if (registryRead.state !== "ok") return refuse("INSTALL_TARGET_INVALID", "workspace registry is missing or unreadable");
  const registry = registryRead.value as WorkspaceRegistry;
  if (registry.workspace !== ws.workspace) return refuse("DUPLICATE_BINDING", "workspace registry belongs to a different workspace");
  const matches = registry.projects.filter((p) => p.canonicalPath === canonical);
  if (matches.length === 0) return refuse("INSTALL_TARGET_INVALID", "project is not registered in this workspace", "Register the project explicitly with the installer.");
  if (matches.length > 1) return refuse("DUPLICATE_BINDING", "project is registered more than once");
  const project = matches[0]!.project;
  if (registry.projects.filter((p) => p.project === project).length > 1) return refuse("DUPLICATE_BINDING", "project identity is registered at more than one path");
  return success({ workspace: ws.workspace, workspaceRoot, project, canonicalPath: canonical });
}
