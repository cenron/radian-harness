import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RadianError } from "../core/errors.ts";
import type { Mode } from "../core/roles.ts";
import type { RadianConfig } from "../io/config.ts";
import type { HerdrRunner } from "../io/herdr.ts";
import { readMode, type Project } from "../io/workspace.ts";
import type { WorkerEnv } from "../workers/worker-env.ts";

export interface RadianDeps {
  harnessRoot: string;
  herdr: HerdrRunner;
  /** Pi's own Herdr pane; undefined when Pi runs outside Herdr. */
  paneId: string | undefined;
}

/** What this Pi session shows: the workspace dashboard, or one project when `project` is set. */
export interface View {
  workspaceRoot: string;
  config: RadianConfig;
  project: Project | undefined;
}

/** Radian's state for one Pi session. Pi rebuilds it whenever the session is replaced. */
export interface RadianState {
  pi: ExtensionAPI;
  deps: RadianDeps;
  view: View | undefined;
  skillRoots: string[];
  isCalm: boolean;
  stopWatcher: (() => void) | undefined;
}

export function requireView(state: RadianState): View {
  if (!state.view) {
    throw new RadianError(
      "no_workspace",
      "Radian is not active here; start Pi in a Radian workspace.",
    );
  }
  return state.view;
}

export function requireProject(state: RadianState): View & { project: Project } {
  const view = requireView(state);
  if (!view.project) {
    throw new RadianError(
      "no_project",
      "No project is selected. Use /projects to pick one or /new-project to create one.",
    );
  }
  return { ...view, project: view.project };
}

export function currentMode(view: View & { project: Project }): Mode {
  return readMode(view.workspaceRoot, view.project.name, view.config.harness.startMode);
}

export function workerEnvOf(state: RadianState): WorkerEnv {
  const view = requireProject(state);
  return {
    workspaceRoot: view.workspaceRoot,
    project: view.project,
    config: view.config,
    harnessRoot: state.deps.harnessRoot,
    herdr: state.deps.herdr,
    paneId: state.deps.paneId,
  };
}
