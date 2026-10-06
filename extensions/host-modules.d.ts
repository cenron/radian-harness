// Ambient declarations for the host-provided packages Pi supplies to
// extensions at runtime (declared as optional peer dependencies and never
// bundled). Only the members Radian uses are declared; Pi 1.0.2's own
// declarations are authoritative.

declare module "@earendil-works/pi-coding-agent" {
  export class CustomEditor {
    constructor(tui: unknown, theme: unknown, keybindings: unknown, options?: unknown);
    handleInput(data: string): void;
  }
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
