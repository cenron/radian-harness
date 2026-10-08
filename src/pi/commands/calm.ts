import type { CommandDefinition, CommandDependencies } from "#pi/commands/types.ts";
import { RadianError } from "#core/errors.ts";
import { writeCalm } from "#pi/calm.ts";
import type { State } from "#pi/state.ts";

/**
 * `/calm [on|off]`: collapses successful tool output. With no argument it toggles; the choice
 * is saved for the workspace.
 */
export function calmCommand({ state }: CommandDependencies): CommandDefinition {
  return {
    name: "calm",
    description: "Toggle Calm (collapse successful tool output), or set it: /calm [on|off]",
    action: async (_args) => {
      const setting = _args[0];

      if (setting === undefined) return setCalm(state, !state.isCalm);
      if (setting === "on" || setting === "off") return setCalm(state, setting === "on");

      throw new RadianError("usage", "Usage: /calm [on|off]");
    },
  };
}

export function setCalm(state: State, isCalm: boolean): string {
  writeCalm(state.requireView().workspaceRoot, isCalm);
  state.isCalm = isCalm;
  return `Calm ${isCalm ? "on: successful tool output is collapsed" : "off"}.`;
}
