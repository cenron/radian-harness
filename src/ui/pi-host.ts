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
  /** Pi's selector: the first option is initially selected (Enter chooses it); Escape dismisses (undefined). */
  select(title: string, options: string[]): Promise<string | undefined>;
  input?(title: string, placeholder?: string): Promise<string | undefined>;
  setEditorComponent(factory: ((tui: unknown, theme: unknown, keybindings: unknown) => unknown) | undefined): void;
  theme: HostTheme;
}

export interface HostSessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

/** Read-only view of Pi's session manager (`ctx.sessionManager`). */
export interface HostSessionManager {
  getBranch(): HostSessionEntry[];
  getEntries?(): HostSessionEntry[];
  getSessionFile(): string | undefined;
  getSessionId(): string;
  getHeader(): { id: string; cwd: string } | null;
}

/** Pi's session manager as passed to `newSession({ setup })`. */
export interface HostWritableSessionManager extends HostSessionManager {
  appendCustomEntry(customType: string, data?: unknown): string;
}

export interface HostContext {
  ui: HostUI;
  mode: ExtensionMode;
  hasUI: boolean;
  cwd: string;
  isIdle(): boolean;
  hasPendingMessages?(): boolean;
  sessionManager?: HostSessionManager;
  model?: unknown;
  /** Command contexts only: Pi's in-process session replacement (W01). */
  newSession?(options?: { setup?: (sm: HostWritableSessionManager) => Promise<void>; withSession?: (ctx: HostContext) => Promise<void> }): Promise<{ cancelled: boolean }>;
  switchSession?(sessionPath: string, options?: { withSession?: (ctx: HostContext) => Promise<void> }): Promise<{ cancelled: boolean }>;
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
  /** Pi 1.0.2 tool exposure; `model-only` tools are declared to the model but never callable from other tools. */
  exposure?: "direct" | "model-only" | "codemode" | "deferred" | "hidden";
  label?: string;
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: HostContext) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}

/** `before_agent_start`: the mutable prompt sections Pi renders for this run. */
export interface HostBeforeAgentStartEvent {
  systemPromptOptions: {
    cwd: string;
    contextFiles?: Array<{ path: string; content: string }>;
    skills?: Array<{ name: string; filePath: string; baseDir: string }>;
    sections?: Record<string, string>;
  };
}

export interface HostToolInfo {
  name: string;
  sourceInfo?: { path: string };
}

export interface HostBashOperations {
  exec(command: string, cwd: string, options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv }): Promise<{ exitCode: number | null }>;
}

export interface PiHost {
  on(event: "session_start", handler: (event: { reason?: string }, ctx: HostContext) => unknown): () => void;
  on(event: "session_shutdown", handler: (event: { reason?: string }, ctx: HostContext) => unknown): () => void;
  on(event: "before_agent_start", handler: (event: HostBeforeAgentStartEvent, ctx: HostContext) => unknown): () => void;
  on(event: "user_bash", handler: (event: { command: string; cwd: string }, ctx: HostContext) => unknown): () => void;
  on(event: "tool_call", handler: (event: HostToolCallEvent, ctx: HostContext) => unknown): () => void;
  on(event: "input", handler: (event: HostInputEvent, ctx: HostContext) => unknown): () => void;
  registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: HostContext) => Promise<void> }): void;
  registerTool(tool: HostToolDefinition): void;
  registerToolRenderer(resolver: (toolName: string, next: () => HostToolRenderers | undefined) => HostToolRenderers | undefined): void;
  sendMessage(message: { customType: string; content: string; display: boolean }, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void;
  /** Optional in fake hosts; present in Pi 1.0.2. */
  getAllTools?(): HostToolInfo[];
  getActiveTools?(): string[];
  setActiveTools?(names: string[]): void;
  getThinkingLevel?(): string;
  setThinkingLevel?(level: string): void;
  setModel?(model: unknown): Promise<boolean>;
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
  /** Pi's context-file discovery for a directory (agent directory, ancestors, the directory). */
  loadProjectContextFiles?(options: { cwd: string; agentDir: string }): Array<{ path: string; content: string }>;
  getAgentDir?(): string;
  /** Pi's grep/find definitions, delegated to only after Radian validates the search path. */
  createGrepToolDefinition?(cwd: string): { execute: (...args: unknown[]) => Promise<unknown> };
  createFindToolDefinition?(cwd: string): { execute: (...args: unknown[]) => Promise<unknown> };
  createLocalBashOperations?(): HostBashOperations;
}
