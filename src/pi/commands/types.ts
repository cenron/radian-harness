import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ProjectMode } from "#pi/mode/project-mode.ts";
import type { ProjectSession } from "#pi/session/project-session.ts";
import type { State } from "#pi/state.ts";
import type { StatusView } from "#pi/status/status-view.ts";

export interface CommandDependencies {
  state: State;
  session: ProjectSession;
  status: StatusView;
  mode: ProjectMode;
}

export interface CommandDefinition {
  name: string;
  description: string;
  action(
    args: string[],
    ctx: ExtensionCommandContext,
  ): string | undefined | Promise<string | undefined>;
}
