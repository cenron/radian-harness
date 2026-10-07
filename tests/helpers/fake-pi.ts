import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../src/io/config.ts";
import type { RadianState } from "../../src/pi/state.ts";
import type { WorkerEnv } from "../../src/workers/worker-env.ts";

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

export interface FakePi {
  state: RadianState;
  ctx: ExtensionCommandContext;
  notes: string[];
  sessions: string[];
  /** The option the next `select` dialog picks; undefined cancels it. */
  answer: { pick: (options: string[]) => string | undefined };
  run: (command: string) => Promise<string | undefined>;
}

/** Just enough of Pi to run Radian's command handlers against a real workspace. */
export function createFakePi(env: WorkerEnv): FakePi {
  const handlers = new Map<string, Handler>();
  const notes: string[] = [];
  const sessions: string[] = [];
  const answer: FakePi["answer"] = { pick: () => undefined };
  const pi = {
    registerCommand: (name: string, options: { handler: Handler }) =>
      handlers.set(name, options.handler),
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
  const state: RadianState = {
    pi,
    deps: { harnessRoot: env.harnessRoot, herdr: env.herdr, paneId: env.paneId },
    view: { workspaceRoot: env.workspaceRoot, config: loadConfig(env), project: env.project },
    skillRoots: [],
    isCalm: false,
    stopWatcher: undefined,
  };
  const run = async (command: string) => {
    const [name = "", ...rest] = command.replace(/^\//, "").split(" ");
    const before = notes.length;
    await handlers.get(name)?.(rest.join(" "), ctx);
    return notes.slice(before).join("\n") || undefined;
  };
  return { state, ctx, notes, sessions, answer, run };
}
