import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "#core/utils/errors.ts";
import type { CommandDefinition, CommandDependencies } from "#pi/commands/types.ts";
import { workspaceCommand } from "#pi/commands/workspace.ts";
import { projectCommand } from "#pi/commands/projects.ts";
import { calmCommand } from "#pi/commands/calm.ts";
import { radianCommand } from "#pi/commands/radian.ts";

/** Registers Radian's slash commands: `/projects`, `/workspace`, `/calm`, and `/radian`. */
export function registerCommands(deps: CommandDependencies): void {
  for (const command of createCommands(deps)) {
    deps.state.pi.registerCommand(command.name, {
      description: command.description,
      handler: (args, ctx) => runCommand(ctx, () => command.action(splitArguments(args), ctx)),
    });
  }
}

function createCommands(deps: CommandDependencies): CommandDefinition[] {
  return [projectCommand(deps), workspaceCommand(deps), calmCommand(deps), radianCommand(deps)];
}

/** Shows the command's reply, or its error, as a notification instead of throwing into Pi. */
async function runCommand(
  ctx: ExtensionContext,
  action: () => string | undefined | Promise<string | undefined>,
): Promise<void> {
  try {
    const message = await action();
    if (message) ctx.ui.notify(message, "info");
  } catch (error) {
    ctx.ui.notify(errorMessage(error), "error");
  }
}

function splitArguments(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}
