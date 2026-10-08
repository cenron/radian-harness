import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { calmResolver } from "#pi/calm.ts";
import { registerCommands } from "#pi/commands/index.ts";
import { guardToolCall } from "#pi/guard.ts";
import { ProjectMode } from "#pi/mode/project-mode.ts";
import { ModelCarry } from "#pi/session/model-carry.ts";
import { ProjectSession } from "#pi/session/project-session.ts";
import { SessionLifecycle } from "#pi/session/session-lifecycle.ts";
import { SystemPrompt } from "#pi/session/system-prompt.ts";
import { type RadianDeps, State } from "#pi/state.ts";
import { StatusView } from "#pi/status/status-view.ts";
import { registerTools } from "#pi/tools/index.ts";
import { registerReadTools } from "#pi/tools/read-tools.ts";
import { Watcher } from "#pi/watcher/watcher.ts";

/** Builds Radian's parts once and connects them to Pi's tools, commands, and events. */
export class RegisterRadian {
  readonly state: State;
  readonly session: ProjectSession;
  readonly status: StatusView;
  readonly mode: ProjectMode;
  readonly watcher: Watcher;
  private readonly lifecycle: SessionLifecycle;
  private readonly systemPrompt: SystemPrompt;

  constructor(pi: ExtensionAPI, deps: RadianDeps) {
    const carry = new ModelCarry(pi);
    this.state = new State(pi, deps);
    this.session = new ProjectSession(deps.harnessRoot, carry);
    this.status = new StatusView(this.state);
    this.mode = new ProjectMode(this.state, this.status);
    this.watcher = new Watcher(this.state, this.status);
    this.systemPrompt = new SystemPrompt(this.state);
    this.lifecycle = new SessionLifecycle({ ...this.parts(), carry, watcher: this.watcher });
  }

  initialize(): void {
    const parts = this.parts();
    const pi = this.state.pi;

    registerReadTools(parts);
    registerTools(parts);
    registerCommands(parts);
    pi.registerToolRenderer(calmResolver(() => this.state.isCalm));

    pi.on("session_start", (_event, ctx) => this.lifecycle.start(ctx));
    pi.on("session_shutdown", (_event, ctx) => this.lifecycle.end(ctx));
    pi.on("tool_call", (event) => (this.state.view ? guardToolCall(event.toolName) : undefined));
    pi.on("before_agent_start", (event) => {
      this.systemPrompt.describe(event.systemPromptOptions);
      return undefined;
    });
  }

  /** The parts that commands and tools are built from; each takes the ones it needs. */
  private parts() {
    return { state: this.state, session: this.session, status: this.status, mode: this.mode };
  }
}
