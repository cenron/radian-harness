import path from "node:path";
import type { ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readJsonFile, writeJsonFile } from "../io/json-file.ts";

/**
 * Calm collapses successful tool results to one line; errors, partial output, and
 * expanded results render as usual. Only presentation changes, never execution.
 */
export function calmResolver(isCalm: () => boolean): ToolRendererResolver {
  return (toolName, next) => {
    const base = next();
    const renderResult = base?.renderResult;
    // Without a result renderer Pi uses its built-in one. Wrapping nothing would
    // replace that fallback with an empty component and break the transcript.
    if (!base || !renderResult) return base;
    const calm: ToolRenderers = {
      ...base,
      renderResult(result, options, theme, context) {
        if (!isCalm() || options.expanded || options.isPartial || context.isError) {
          return renderResult(result, options, theme, context);
        }
        return new Text(
          theme.fg("muted", `${toolName}: output hidden by Calm (expand to view)`),
          0,
          0,
        );
      },
    };
    return calm;
  };
}

export function readCalm(workspaceRoot: string, fallback: boolean): boolean {
  const stored = readJsonFile<{ calm?: boolean }>(preferencesFile(workspaceRoot), {});
  return stored.calm ?? fallback;
}

export function writeCalm(workspaceRoot: string, isCalm: boolean): void {
  writeJsonFile(preferencesFile(workspaceRoot), { calm: isCalm });
}

function preferencesFile(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".radian", "ui.json");
}
