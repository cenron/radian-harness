// Workspace discovery, independent of Git. Pi's working directory is
// classified as one of:
//   unmanaged  — not inside any Radian workspace (Radian stays inactive);
//   workspace  — the workspace root itself (dashboard / selected projects);
//   direct     — inside an explicitly registered project (direct entry);
//   blocked    — inside a recognized workspace whose identity, registry, or
//                project binding is invalid. A blocked state is never treated
//                as unmanaged: every model tool is refused until it is fixed.

import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { type Blocker, blocker } from "../contracts/blockers.ts";
import { isWithin } from "../contracts/paths.ts";
import type { WorkspaceRecord, WorkspaceRegistry } from "../state/binding.ts";
import { readJsonIfExists } from "../state/fsutil.ts";
import { WORKSPACE_FILE, workspaceAncestors, workspacePaths } from "./layout.ts";

export interface RegisteredProject {
  project: string;
  canonicalPath: string;
  target?: string;
  /** Human-readable name: the path relative to the workspace root. */
  name: string;
  /** `missing`: the path no longer exists; `moved`: it exists but is no longer a directory at its canonical path. */
  presence: "present" | "missing" | "moved";
}

export interface WorkspaceInfo {
  root: string;
  id: string;
  projects: RegisteredProject[];
}

export type Discovery =
  | { state: "unmanaged" }
  | { state: "workspace"; workspace: WorkspaceInfo }
  | { state: "direct"; workspace: WorkspaceInfo; project: RegisteredProject }
  | { state: "blocked"; workspaceRoot?: string; blocker: Blocker };

function presenceOf(canonicalPath: string): RegisteredProject["presence"] {
  if (!existsSync(canonicalPath)) return "missing";
  try {
    return realpathSync(canonicalPath) === canonicalPath && statSync(canonicalPath).isDirectory() ? "present" : "moved";
  } catch {
    return "moved";
  }
}

/** Read and validate a workspace's identity and registry. */
export function loadWorkspace(root: string): { ok: true; value: WorkspaceInfo } | { ok: false; blocker: Blocker } {
  const record = readJsonIfExists(path.join(root, WORKSPACE_FILE));
  if (record.state !== "ok") return { ok: false, blocker: blocker("WORKSPACE_BLOCKED", "the workspace record is unreadable", "Run the installer's status and recover commands for this workspace.") };
  const ws = record.value as Partial<WorkspaceRecord>;
  if (ws.schema !== "radian.workspace/1" || typeof ws.workspace !== "string") return { ok: false, blocker: blocker("WORKSPACE_BLOCKED", "the workspace record is invalid") };
  if (ws.canonicalRoot !== root) return { ok: false, blocker: blocker("DUPLICATE_BINDING", "the workspace record belongs to another location (moved or copied workspace)", "Re-install the workspace explicitly.") };
  const registryRead = readJsonIfExists(workspacePaths(root).registry);
  if (registryRead.state !== "ok") return { ok: false, blocker: blocker("WORKSPACE_BLOCKED", "the workspace project registry is missing or unreadable", "Run the installer's status and recover commands for this workspace.") };
  const registry = registryRead.value as Partial<WorkspaceRegistry>;
  if (registry.schema !== "radian.workspace-registry/1" || registry.workspace !== ws.workspace || !Array.isArray(registry.projects)) return { ok: false, blocker: blocker("WORKSPACE_BLOCKED", "the workspace registry does not match this workspace") };
  const projects: RegisteredProject[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const p of registry.projects) {
    if (!p || typeof p.project !== "string" || typeof p.canonicalPath !== "string" || !path.isAbsolute(p.canonicalPath)) return { ok: false, blocker: blocker("WORKSPACE_BLOCKED", "the workspace registry has an invalid project entry") };
    if (ids.has(p.project) || paths.has(p.canonicalPath)) return { ok: false, blocker: blocker("DUPLICATE_BINDING", "a project is registered more than once") };
    if (!isWithin(p.canonicalPath, root) || p.canonicalPath === root) return { ok: false, blocker: blocker("WORKSPACE_BLOCKED", "a registered project is outside the workspace") };
    ids.add(p.project);
    paths.add(p.canonicalPath);
    const out: RegisteredProject = { project: p.project, canonicalPath: p.canonicalPath, name: path.relative(root, p.canonicalPath).split(path.sep).join("/"), presence: presenceOf(p.canonicalPath) };
    if (typeof p.target === "string") out.target = p.target;
    projects.push(out);
  }
  for (const a of projects) for (const b of projects) if (a !== b && isWithin(a.canonicalPath, b.canonicalPath)) return { ok: false, blocker: blocker("WORKSPACE_BLOCKED", "registered projects are nested inside each other") };
  return { ok: true, value: { root, id: ws.workspace, projects } };
}

export function discover(cwd: string): Discovery {
  let canonical: string;
  try {
    canonical = realpathSync(cwd);
  } catch {
    return { state: "unmanaged" };
  }
  const roots = workspaceAncestors(canonical);
  if (roots.length === 0) return { state: "unmanaged" };
  if (roots.length > 1) return { state: "blocked", workspaceRoot: roots[0]!, blocker: blocker("DUPLICATE_BINDING", "this directory is inside more than one Radian workspace", "Remove the nested workspace installation.") };
  const root = roots[0]!;
  const loaded = loadWorkspace(root);
  if (!loaded.ok) return { state: "blocked", workspaceRoot: root, blocker: loaded.blocker };
  if (canonical === root) return { state: "workspace", workspace: loaded.value };
  const project = loaded.value.projects.find((p) => p.canonicalPath === canonical || isWithin(canonical, p.canonicalPath));
  if (!project) return { state: "blocked", workspaceRoot: root, blocker: blocker("WORKSPACE_BLOCKED", "this directory is inside a Radian workspace but is not a registered project", "Start Pi at the workspace root, or register the repository with /add-project.") };
  if (canonical !== project.canonicalPath) return { state: "blocked", workspaceRoot: root, blocker: blocker("WORKSPACE_BLOCKED", `start Pi at the project root (${project.name}), not a subdirectory`) };
  return { state: "direct", workspace: loaded.value, project };
}
