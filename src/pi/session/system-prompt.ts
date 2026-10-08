import {
  type BuildSystemPromptOptions,
  getAgentDir,
  loadProjectContextFiles,
} from "@earendil-works/pi-coding-agent";
import { listProjects } from "#io/workspace.ts";
import type { State } from "#pi/state.ts";

/** Radian's part of Pi's system prompt, rebuilt before each turn. */
export class SystemPrompt {
  private readonly state: State;

  constructor(state: State) {
    this.state = state;
  }

  /** Points the model at the selected project: its root, its context files, and Radian's rules. */
  describe(options: BuildSystemPromptOptions): void {
    const view = this.state.view;
    if (!view) return;
    this.state.skillRoots = (options.skills ?? []).map((skill) => skill.baseDir);
    options.sections ??= {};
    if (!view.project) {
      const names = listProjects(view.workspaceRoot).map((project) => project.name);
      options.sections.radian = `Radian workspace dashboard; no project is selected. Projects: ${names.join(", ") || "none"}. The user selects one with /projects select <name> or creates one with /projects create <name>.`;
      return;
    }
    const project = view.project;
    options.cwd = project.path;
    options.contextFiles = loadProjectContextFiles({ cwd: project.path, agentDir: getAgentDir() });
    options.sections.radian = [
      `Radian project ${project.name} at ${project.path}; workers merge into ${project.target}.`,
      `Mode: ${this.state.currentMode({ ...view, project }).toUpperCase()}.`,
      "You coordinate and never edit files or run commands yourself; follow the radian-coordinator skill.",
    ].join(" ");
  }
}
