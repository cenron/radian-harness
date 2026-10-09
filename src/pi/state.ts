import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RadianError } from "../core/errors.ts";
import type { Mode, RadianConfig } from "../core/types.ts";
import type { WorkerRecord } from "../core/worker.ts";
import type { HerdrRunner } from "../io/herdr.ts";
import { findWorker } from "../io/worker-store.ts";
import { readAutoMerge, readMode, type Project } from "../io/workspace.ts";
import { workersFileOf, type WorkerEnv } from "../workers/worker-env.ts";

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
export class State {
  readonly pi: ExtensionAPI;
  readonly deps: RadianDeps;

  view: View | undefined = undefined;
  skillRoots: string[] = [];
  isCalm = false;
  /** The planning document written last in this session, relative to the project root. */
  lastPlan: string | undefined = undefined;

  constructor(pi: ExtensionAPI, deps: RadianDeps) {
    this.pi = pi;
    this.deps = deps;
  }

  requireView(): View {
    if (!this.view) {
      throw new RadianError(
        "no_workspace",
        "Radian is not active here; start Pi in a Radian workspace.",
      );
    }
    return this.view;
  }

  requireProject(): View & { project: Project } {
    const view = this.requireView();
    if (!view.project) {
      throw new RadianError(
        "no_project",
        "No project is selected. Use /projects select to pick one or /projects create to create one.",
      );
    }
    return { ...view, project: view.project };
  }

  currentMode(view: View & { project: Project }): Mode {
    return readMode(view.workspaceRoot, view.project.name, view.config.harness.startMode);
  }

  /** The selected project's auto-merge countdown in seconds; 0 means merges wait for an answer. */
  autoMergeSeconds(): number {
    const view = this.requireProject();
    return readAutoMerge(
      view.workspaceRoot,
      view.project.name,
      view.config.harness.autoMergeSeconds,
    );
  }

  workerEnvOf(): WorkerEnv {
    const view = this.requireProject();
    return {
      workspaceRoot: view.workspaceRoot,
      project: view.project,
      config: view.config,
      harnessRoot: this.deps.harnessRoot,
      herdr: this.deps.herdr,
      paneId: this.deps.paneId,
    };
  }

  /** The selected project's worker environment and the worker with this name in it. */
  namedWorker(name: string): { env: WorkerEnv; worker: WorkerRecord } {
    const env = this.workerEnvOf();
    return { env, worker: findWorker(workersFileOf(env), name) };
  }
}
