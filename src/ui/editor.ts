// Managed-session editor: a subclass of Pi's public CustomEditor that claims
// Shift+Tab for the Plan/Build toggle before the base class would cycle the
// thinking level. Every other key — including Tab for autocomplete and all app
// actions — is forwarded unchanged. It is installed only in Radian-managed
// sessions and removed on shutdown; personal keybinding files are never
// edited. Native `/thinking` remains available for thinking control.

import type { HostRuntime } from "./pi-host.ts";

export const MODE_TOGGLE_KEY = "shift+tab";

export function managedEditorFactory(runtime: Pick<HostRuntime, "CustomEditor" | "matchesKey">, onToggle: () => void): (tui: unknown, theme: unknown, keybindings: unknown) => unknown {
  const Base = runtime.CustomEditor;
  class RadianManagedEditor extends Base {
    override handleInput(data: string): void {
      if (runtime.matchesKey(data, MODE_TOGGLE_KEY)) {
        onToggle();
        return;
      }
      super.handleInput(data);
    }
  }
  return (tui, theme, keybindings) => new RadianManagedEditor(tui, theme, keybindings);
}
