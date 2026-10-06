// Test-only W01 contract probe. It exercises, through Pi 1.0.2's public
// extension API only, the mechanisms the workspace-first design relies on:
//   - command-context newSession/switchSession replace the conversation in the
//     same process without changing process.cwd() or the runtime cwd;
//   - the replacement reloads extensions, so durable owners must live outside
//     the per-runtime extension instance (globalThis registry);
//   - a custom session entry written in newSession's setup tags the session;
//   - before_agent_start systemPromptOptions replaces context files and cwd;
//   - a same-name tool override confines the built-in read tool to a root;
//   - nested tool calls pass through tool_call handlers.
// It is not product code.

import path from "node:path";
import { createReadToolDefinition, getAgentDir, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";

const KEY = Symbol.for("radian.w01-probe");
type Shared = { starts: number; evaluations: number; sessions: Record<string, string>; shutdownReasons: string[]; nested: string[]; carry?: { thinking: string; model?: unknown } };
const shared: Shared = ((globalThis as Record<symbol, unknown>)[KEY] as Shared | undefined) ?? { starts: 0, evaluations: 0, sessions: {}, shutdownReasons: [], nested: [] };
(globalThis as Record<symbol, unknown>)[KEY] = shared;
shared.evaluations += 1;
let moduleStarts = 0;

export default function probe(pi: any): void {
  let selected: string | undefined;
  let workspace = "";

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    shared.starts += 1;
    moduleStarts += 1;
    workspace = ctx.cwd;
    const tag = ctx.sessionManager.getBranch().find((e: any) => e.type === "custom" && e.customType === "w01-project");
    selected = tag?.data?.name;
    // Re-apply the interface's pre-switch model and thinking level: selection must not change them.
    const carry = shared.carry;
    shared.carry = undefined;
    if (carry) {
      // Model first (awaited): Pi clamps a thinking level set while no model is selected to "off",
      // and its setModel resets the level when it completes.
      if (carry.model) for (let i = 0; i < 100 && !(await pi.setModel(carry.model)); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      pi.setThinkingLevel(carry.thinking);
    }
  });
  pi.on("session_shutdown", (event: any) => {
    shared.shutdownReasons.push(event.reason);
  });
  pi.on("before_agent_start", (event: any) => {
    if (!selected) return;
    const root = path.join(workspace, selected);
    event.systemPromptOptions.contextFiles = loadProjectContextFiles({ cwd: root, agentDir: getAgentDir() }).filter((f: { path: string }) => !f.path.startsWith(workspace + path.sep) || f.path.startsWith(root + path.sep));
    event.systemPromptOptions.cwd = root;
  });
  pi.on("tool_call", (event: any) => {
    if (event.parentToolCallId) shared.nested.push(event.toolName);
    if (event.toolName === "bash") return { block: true, reason: "probe: shell blocked" };
    if (event.toolName === "write" || event.toolName === "edit") return { block: true, reason: "probe: writes blocked" };
    return undefined;
  });
  pi.registerTool({
    ...createReadToolDefinition(workspace || process.cwd()),
    name: "read",
    async execute(id: string, params: { path: string }, signal: AbortSignal | undefined, update: unknown, ctx: any) {
      if (!selected) throw new Error("probe: no project selected");
      const root = path.join(workspace, selected);
      const target = path.resolve(root, params.path);
      if (target !== root && !target.startsWith(root + path.sep)) throw new Error("probe: outside the selected project");
      // Built-in tools resolve against ctx.cwd first, so the delegate gets a context rooted at the project.
      return createReadToolDefinition(root).execute(id, params as never, signal, update as never, Object.create(ctx, { cwd: { value: root } }));
    },
  });
  pi.registerCommand("w01-select", {
    description: "probe: select a project conversation",
    handler: async (args: string, ctx: any) => {
      const name = args.trim();
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("probe: busy; switch refused", "warning");
        return;
      }
      shared.carry = { thinking: pi.getThinkingLevel(), model: ctx.model };
      const existing = shared.sessions[name];
      if (existing) {
        await ctx.switchSession(existing);
        return;
      }
      await ctx.newSession({
        setup: async (sm: any) => {
          sm.appendCustomEntry("w01-project", { name });
          shared.sessions[name] = sm.getSessionFile();
        },
      });
    },
  });
  pi.registerCommand("w01-state", {
    description: "probe: report state",
    handler: async (_args: string, ctx: any) => {
      ctx.ui.notify(JSON.stringify({ pid: process.pid, processCwd: process.cwd(), ctxCwd: ctx.cwd, selected: selected ?? null, starts: shared.starts, moduleStarts, evaluations: shared.evaluations, shutdownReasons: shared.shutdownReasons, nested: shared.nested, sessionFile: ctx.sessionManager.getSessionFile(), model: ctx.model?.id ?? null, thinking: pi.getThinkingLevel() }), "info");
    },
  });
}
