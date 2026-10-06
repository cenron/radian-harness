// /calm: presentation-only quieting of routine tool output. Implemented with
// Pi's tool-renderer resolver, never by replacing execution tools. Tool calls
// stay visible as one compact line; successful results collapse unless the user
// expands them; errors, partial progress, messages, approvals, blockers, and
// questions are untouched. Execution, model context, input order, session data,
// logs, and exports are unaffected. The preference is stored in Radian's
// project state, not in personal settings.

import path from "node:path";
import { atomicWriteJson, readJsonIfExists } from "../state/fsutil.ts";
import type { HostToolRenderers } from "./pi-host.ts";

export class CalmPreference {
  private readonly file: string;
  private readonly fallback: boolean;
  constructor(stateDir: string, defaultValue: boolean) {
    this.file = path.join(stateDir, "ui-preferences.json");
    this.fallback = defaultValue;
  }
  get enabled(): boolean {
    const read = readJsonIfExists(this.file);
    if (read.state !== "ok") return this.fallback;
    const value = (read.value as { calm?: unknown }).calm;
    return typeof value === "boolean" ? value : this.fallback;
  }
  set(enabled: boolean): void {
    atomicWriteJson(this.file, { schema: "radian.ui-preferences/1", calm: enabled });
  }
}

function isErrorResult(result: { isError?: boolean; details?: unknown }): boolean {
  if (result.isError === true) return true;
  const details = result.details as { isError?: unknown; exitCode?: unknown } | undefined;
  return details?.isError === true || (typeof details?.exitCode === "number" && details.exitCode !== 0);
}

/**
 * Build the renderer resolver. `makeLine` creates a host text component for a
 * collapsed line; `enabled` is read on every render so toggling is immediate
 * and fully reversible.
 */
export function calmResolver(enabled: () => boolean, makeLine: (text: string) => unknown): (toolName: string, next: () => HostToolRenderers | undefined) => HostToolRenderers | undefined {
  return (toolName, next) => {
    const base = next();
    // Pi uses its built-in result renderer when this callback is absent.
    // Installing a wrapper that returns undefined suppresses that fallback
    // and gives MouseRegion an undefined child, crashing the interactive TUI.
    // Preserve the host fallback rather than inventing a renderer here.
    const renderResult = base?.renderResult;
    if (!base || !renderResult) return base;
    return {
      ...base,
      renderResult(result, options, theme, context) {
        if (!enabled() || options.expanded || options.isPartial || isErrorResult(result)) {
          return renderResult(result, options, theme, context);
        }
        return makeLine(theme.fg("muted", `${toolName}: output hidden by /calm (expand to view)`));
      },
    };
  };
}
