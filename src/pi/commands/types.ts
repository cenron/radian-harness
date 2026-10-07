import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ProjectSession } from "#pi/project-session.ts";
import type { State } from "#pi/state.ts";

export interface CommandDependencies {
  state: State;
  session: ProjectSession;
}

export interface CommandDefinition {
  name: string;
  description: string;
  action(
    args: string[],
    ctx: ExtensionCommandContext,
  ): string | undefined | Promise<string | undefined>;
}
