// The subset of Pi's public extension API that Radian uses, declared
// structurally so Radian's sources type-check without bundling the
// host-provided Pi packages (which Pi supplies at runtime; see the package's
// peerDependencies). Names and shapes follow Pi 1.0.2's exported declarations.

export type ExtensionMode = "tui" | "rpc" | "json" | "print";

export interface HostTheme {
  fg(token: string, text: string): string;
  bold(text: string): string;
}

export interface HostUI {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, lines: string[] | undefined): void;
  confirm(title: string, message?: string): Promise<boolean>;
  select(title: string, options: string[]): Promise<string | undefined>;
  setEditorComponent(factory: ((tui: unknown, theme: unknown, keybindings: unknown) => unknown) | undefined): void;
  theme: HostTheme;
}

export interface HostContext {
  ui: HostUI;
  mode: ExtensionMode;
  hasUI: boolean;
  cwd: string;
  isIdle(): boolean;
}

export interface HostToolCallEvent {
  toolName: string;
  input: Record<string, unknown>;
}

export interface HostInputEvent {
  text: string;
  source: "interactive" | "rpc" | "extension";
}

export interface HostToolRenderers {
  renderShell?: unknown;
  renderCall?: (...args: unknown[]) => unknown;
  renderResult?: (result: { content?: Array<{ type: string; text?: string }>; isError?: boolean; details?: unknown }, options: { expanded: boolean; isPartial?: boolean }, theme: HostTheme, context: unknown) => unknown;
}

export interface HostToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: HostContext) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}

export interface PiHost {
  on(event: "session_start" | "session_shutdown", handler: (event: unknown, ctx: HostContext) => unknown): () => void;
  on(event: "tool_call", handler: (event: HostToolCallEvent, ctx: HostContext) => unknown): () => void;
  on(event: "input", handler: (event: HostInputEvent, ctx: HostContext) => unknown): () => void;
  registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: HostContext) => Promise<void> }): void;
  registerTool(tool: HostToolDefinition): void;
  registerToolRenderer(resolver: (toolName: string, next: () => HostToolRenderers | undefined) => HostToolRenderers | undefined): void;
  sendMessage(message: { customType: string; content: string; display: boolean }, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void;
}

/** TypeBox builders supplied by Pi to extensions (the `typebox` package). */
export interface HostTypeBuilder {
  Object(properties: Record<string, unknown>): unknown;
  String(options?: Record<string, unknown>): unknown;
  Number(options?: Record<string, unknown>): unknown;
  Boolean(options?: Record<string, unknown>): unknown;
  Array(item: unknown, options?: Record<string, unknown>): unknown;
  Optional(schema: unknown): unknown;
  Union(schemas: unknown[]): unknown;
  Literal(value: string): unknown;
}

/** Runtime classes Pi exposes to extensions; resolved lazily from the host package. */
export interface HostRuntime {
  CustomEditor: new (tui: unknown, theme: unknown, keybindings: unknown) => { handleInput(data: string): void };
  matchesKey(data: string, key: string): boolean;
  Text: new (text: string, x: number, y: number) => unknown;
  Type: HostTypeBuilder;
}
