import { CustomEditor, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

type EditorFactory = NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]>;

/**
 * Pi's editor with Shift+Tab claimed for the Plan/Build toggle; Pi would otherwise
 * cycle the thinking level, which stays available through /thinking.
 */
export function modeEditorFactory(onToggle: () => void): EditorFactory {
  class ModeEditor extends CustomEditor {
    override handleInput(data: string): void {
      if (matchesKey(data, "shift+tab")) {
        onToggle();
        return;
      }
      super.handleInput(data);
    }
  }
  return (tui, theme, keybindings) => new ModeEditor(tui, theme, keybindings);
}
