import type { CommandDefinition, CommandDependencies } from "#pi/commands/types.ts";

/** `/workspace`: leaves the selected project and returns to the workspace dashboard. */
export function workspaceCommand({ state, session }: CommandDependencies): CommandDefinition {
  return {
    name: "workspace",
    description: "Return to the workspace dashboard",
    action: async (_args, ctx) => {
      if (!state.requireView().project) return "Already on the workspace dashboard.";
      await session.openDashboard(ctx);
      return undefined;
    },
  };
}
