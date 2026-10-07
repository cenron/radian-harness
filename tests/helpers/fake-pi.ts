import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../src/io/config.ts";
import { State } from "../../src/pi/state.ts";
import type { WorkerEnv } from "../../src/workers/worker-env.ts";

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

export interface FakePi {
  state: State;
  ctx: ExtensionCommandContext;
  notes: string[];
  sessions: string[];
  /** The option the next `select` dialog picks; undefined cancels it. */
  answer: { pick: (options: string[]) => string | undefined };
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
  const answer: FakePi["answer"] = { pick: () => undefined };
  const pi = {
    registerCommand: (name: string, options: { handler: Handler }) =>
      handlers.set(name, options.handler),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    getThinkingLevel: () => "medium",
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    mode: "rpc",
    model: undefined,
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: {
      notify: (message: string) => notes.push(message),
      select: async (_title: string, options: string[]) => answer.pick(options),
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
    newSession: async () => (sessions.push("new"), { cancelled: false }),
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
  return { state, ctx, notes, sessions, answer, run, callTool };
}
