// Project binding identity checks used before a run starts. The binding files
// themselves are written by the workspace installer (milestone 09); here they
// are only verified so that duplicate, moved, or foreign bindings fail closed.

import { realpathSync } from "node:fs";
import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { readJsonIfExists } from "./fsutil.ts";

export interface ProjectBinding {
  schema: "radian.project-binding/1";
  workspace: string;
  project: string;
  canonicalPath: string;
}

export interface WorkspaceRegistry {
  schema: "radian.workspace-registry/1";
  workspace: string;
  projects: Array<{ project: string; canonicalPath: string }>;
}

export const PROJECT_BINDING_FILE = path.join(".radian", "binding.json");
export const WORKSPACE_REGISTRY_FILE = path.join(".radian", "state", "projects.json");

export function checkProjectBinding(projectRoot: string, workspaceRoot: string): Outcome<{ workspace: string; project: string; canonicalPath: string }> {
  let canonical: string;
  let workspaceCanonical: string;
  try {
    canonical = realpathSync(projectRoot);
    workspaceCanonical = realpathSync(workspaceRoot);
  } catch {
    return refuse("INSTALL_TARGET_INVALID", "project or workspace path cannot be resolved");
  }
  const bindingRead = readJsonIfExists(path.join(canonical, PROJECT_BINDING_FILE));
  if (bindingRead.state !== "ok") return refuse("INSTALL_TARGET_INVALID", "project is not registered with a Radian workspace", "Register the project explicitly with the installer.");
  const binding = bindingRead.value as ProjectBinding;
  const registryRead = readJsonIfExists(path.join(workspaceCanonical, WORKSPACE_REGISTRY_FILE));
  if (registryRead.state !== "ok") return refuse("INSTALL_TARGET_INVALID", "workspace registry is missing or unreadable");
  const registry = registryRead.value as WorkspaceRegistry;
  if (binding.workspace !== registry.workspace) {
    return refuse("DUPLICATE_BINDING", "project is bound to a different workspace", "Remove the other binding before using this workspace.");
  }
  if (binding.canonicalPath !== canonical) {
    return refuse("DUPLICATE_BINDING", "project binding records a different location (moved or copied project)", "Re-register the project explicitly.");
  }
  const entries = registry.projects.filter((p) => p.project === binding.project || p.canonicalPath === canonical);
  if (entries.length !== 1 || entries[0]?.project !== binding.project || entries[0]?.canonicalPath !== canonical) {
    return refuse("DUPLICATE_BINDING", "workspace registry does not uniquely match this project", "Resolve duplicate or stale registrations with the installer.");
  }
  return success({ workspace: registry.workspace, project: binding.project, canonicalPath: canonical });
}
