// Ambient declarations for the host-provided packages Pi supplies to
// extensions at runtime (declared as optional peer dependencies and never
// bundled). Only the members Radian uses are declared; Pi 1.0.2's own
// declarations are authoritative.

declare module "@earendil-works/pi-coding-agent" {
  export class CustomEditor {
    constructor(tui: unknown, theme: unknown, keybindings: unknown, options?: unknown);
    handleInput(data: string): void;
  }
  /** Pi's agent directory (PI_CODING_AGENT_DIR or the default). */
  export function getAgentDir(): string;
  /** The context files Pi loads for a working directory: agent directory, then ancestors down to cwd. */
  export function loadProjectContextFiles(options: { cwd: string; agentDir: string }): Array<{ path: string; content: string }>;
  /** Pi's built-in grep/find definitions (ripgrep/fd), used only after Radian validates the search path. */
  export function createGrepToolDefinition(cwd: string): { execute: (...args: unknown[]) => Promise<unknown> };
  export function createFindToolDefinition(cwd: string): { execute: (...args: unknown[]) => Promise<unknown> };
  export function createLocalBashOperations(): import("../src/ui/pi-host.ts").HostBashOperations;
}

declare module "@earendil-works/pi-tui" {
  export function matchesKey(data: string, key: string): boolean;
  export class Text {
    constructor(text: string, paddingX: number, paddingY: number);
  }
}

declare module "typebox" {
  export const Type: import("../src/ui/pi-host.ts").HostTypeBuilder;
}
