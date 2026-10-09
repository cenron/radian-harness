import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "#core/config.ts";
import { State } from "../../src/pi/state.ts";
import { StatusView } from "../../src/pi/status/status-view.ts";
import type { WorkerEnv } from "../../src/workers/worker-env.ts";

type NewSessionOptions = Parameters<ExtensionCommandContext["newSession"]>[0];

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

/** A session started with `ctx.newSession`: the custom entries its setup wrote, and its prompts. */
export interface FakeSession {
  entries: Array<{ customType: string; data: unknown }>;
  prompts: string[];
}

export interface FakePi {
  state: State;
  status: StatusView;
  ctx: ExtensionCommandContext;
  notes: string[];
  sessions: string[];
  /** Every `newSession`, in order, with what its setup and `withSession` did. */
  newSessions: FakeSession[];
  /** Messages Radian sent as the user, such as a dispatched slash command. */
  userMessages: Array<{ text: string; options: unknown }>;
  /** Custom instructions of every `ctx.compact` call. */
  compactions: Array<string | undefined>;
  /**
   * The option the next `select` dialog picks; undefined cancels it at once. With `waits`, a
   * dialog that has a timeout gets no answer and resolves when the timeout runs out.
   */
  answer: { pick: (options: string[]) => string | undefined; waits?: boolean };
  /** Every `select` dialog shown, with its timeout in milliseconds when it had one. */
  dialogs: Array<{ title: string; options: string[]; timeout?: number }>;
  run: (command: string) => Promise<string | undefined>;
  /** Calls a registered tool as the model would and returns its text. */
  callTool: (name: string, params: Record<string, unknown>) => Promise<string>;
}

/** Just enough of Pi to run Radian's command handlers against a real workspace. */
export function createFakePi(env: WorkerEnv): FakePi {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, ToolDefinition>();
  const notes: string[] = [];
  const sessions: string[] = [];
  const newSessions: FakeSession[] = [];
  const userMessages: FakePi["userMessages"] = [];
  const compactions: FakePi["compactions"] = [];
  const answer: FakePi["answer"] = { pick: () => undefined };
  const dialogs: FakePi["dialogs"] = [];
  const pi = {
    registerCommand: (name: string, options: { handler: Handler }) =>
      handlers.set(name, options.handler),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    getThinkingLevel: () => "medium",
    sendUserMessage: (text: string, options: unknown) => userMessages.push({ text, options }),
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    mode: "rpc",
    model: undefined,
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: {
      notify: (message: string) => notes.push(message),
      select: async (title: string, options: string[], opts?: { timeout?: number }) => {
        dialogs.push({ title, options, timeout: opts?.timeout });
        if (!answer.waits || !opts?.timeout) return answer.pick(options);
        await new Promise((resolve) => setTimeout(resolve, opts.timeout));
        return undefined;
      },
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
    compact: (options?: { customInstructions?: string }) =>
      compactions.push(options?.customInstructions),
    newSession: async (options?: NewSessionOptions) => {
      sessions.push("new");
      const session: FakeSession = { entries: [], prompts: [] };
      newSessions.push(session);
      await options?.setup?.({
        appendCustomEntry: (customType: string, data: unknown) =>
          session.entries.push({ customType, data }),
      } as never);
      await options?.withSession?.({
        ui: { notify: (message: string) => notes.push(message) },
        sendUserMessage: async (text: string) => session.prompts.push(text),
      } as never);
      return { cancelled: false };
    },
    switchSession: async (file: string) => (sessions.push(file), { cancelled: false }),
  } as unknown as ExtensionCommandContext;
  const state = new State(pi, {
    harnessRoot: env.harnessRoot,
    herdr: env.herdr,
    paneId: env.paneId,
  });
  state.view = { workspaceRoot: env.workspaceRoot, config: loadConfig(env), project: env.project };
  const run = async (command: string) => {
    const [name = "", ...rest] = command.replace(/^\//, "").split(" ");
    const before = notes.length;
    await handlers.get(name)?.(rest.join(" "), ctx);
    return notes.slice(before).join("\n") || undefined;
  };
  const callTool = async (name: string, params: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`No tool ${name}`);
    const result = await tool.execute(
      "call-1",
      params as never,
      undefined,
      undefined,
      ctx as never,
    );
    return result.content.map((part) => ("text" in part ? part.text : "")).join("");
  };
  return {
    state,
    status: new StatusView(state),
    ctx,
    notes,
    sessions,
    newSessions,
    userMessages,
    compactions,
    answer,
    dialogs,
    run,
    callTool,
  };
}
