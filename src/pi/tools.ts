import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { RadianError } from "../core/errors.ts";
import { ROLES, parseRole } from "../core/roles.ts";
import { assertWorkerToolName } from "../core/runtime-args.ts";
import { runReadOnlyGit } from "../io/git.ts";
import { listWorkers } from "../io/worker-store.ts";
import { addWorkerTool, readWorkerTools } from "../io/worker-tools.ts";
import { isWaitingForUser } from "../workers/delivery.ts";
import { dispatchWorker } from "../workers/dispatch.ts";
import { sendToWorker, stopWorker } from "../workers/finish.ts";
import { workersFileOf } from "../workers/worker-env.ts";
import { approveWorkerTool, discardWithApproval, mergeWithApproval } from "./dialogs.ts";
import { statusReport, workersReport } from "./status-view.ts";
import type { State } from "./state.ts";

export const RADIAN_TOOL_NAMES = [
  "radian_status",
  "radian_write_doc",
  "radian_git",
  "radian_dispatch",
  "radian_workers",
  "radian_send",
  "radian_stop",
  "radian_merge",
  "radian_discard",
  "radian_allow_tool",
];

const MAX_GIT_OUTPUT_CHARS = 50_000;
const PLANNING_DIR = path.join(".radian", "planning");
const workerParameter = Type.String({ description: "Worker name, e.g. demo-developer-1" });

export function registerTools(state: State): void {
  const tools = [
    tool({
      name: "radian_status",
      description:
        "Show the selected project, its mode, and its workers; on the dashboard, list projects.",
      parameters: Type.Object({}),
      run: async () => statusReport(state),
    }),
    tool({
      name: "radian_write_doc",
      description:
        "Write a planning document under the project's .radian/planning/ folder (not tracked by git).",
      parameters: Type.Object({
        path: Type.String({
          description: "Path relative to .radian/planning/, e.g. login-plan.md",
        }),
        content: Type.String(),
      }),
      run: async ({ path: relative, content }) => writeDoc(state, relative, content),
    }),
    tool({
      name: "radian_git",
      description: "Run a read-only git command (status, log, diff, show) in the selected project.",
      parameters: Type.Object({
        args: Type.Array(Type.String(), { description: 'e.g. ["log", "--oneline", "-10"]' }),
      }),
      run: async ({ args }) => {
        const output = await runReadOnlyGit(state.requireProject().project.path, args);
        return output.length > MAX_GIT_OUTPUT_CHARS
          ? `${output.slice(0, MAX_GIT_OUTPUT_CHARS)}\n[truncated; narrow the command]`
          : output || "(no output)";
      },
    }),
    tool({
      name: "radian_dispatch",
      description:
        "Start a worker in its own Herdr pane and git worktree. Developer, tester, and reviewer need Build mode; a scout may run in Plan mode. The task must be self-contained: the worker sees only its brief.",
      parameters: Type.Object({
        role: Type.Union(ROLES.map((role) => Type.Literal(role))),
        title: Type.String({ description: "Short title for the pane, e.g. Add login form" }),
        task: Type.String({ description: "Everything the worker needs to know" }),
        profile: Type.Optional(
          Type.String({ description: "Profile name; omit for the role default" }),
        ),
        fromWorker: Type.Optional(Type.String({ description: "Start from this worker's branch" })),
      }),
      run: async (params) => {
        const view = state.requireProject();
        const request = { ...params, role: parseRole(params.role) };
        const worker = await dispatchWorker(state.workerEnvOf(), request, state.currentMode(view));
        const started = `Started ${worker.name} (${worker.runtime} ${worker.model}, effort ${worker.effort}) in pane ${worker.pane} on branch ${worker.branch}.`;
        if (isWaitingForUser(worker)) {
          return `${started} Its agent is asking a startup question (for example, whether to trust the worktree folder). Ask the user to answer it in pane ${worker.pane}; Radian types in the task once the agent is ready.`;
        }
        if (worker.isTaskPending) {
          return `${started} Radian types in the task as soon as the agent is ready. Its status updates arrive as messages.`;
        }
        return `${started} Its status updates arrive as messages.`;
      },
    }),
    tool({
      name: "radian_workers",
      description: "List the selected project's workers with their state and last status.",
      parameters: Type.Object({}),
      run: async () => workersReport(listWorkers(workersFileOf(state.workerEnvOf()))),
    }),
    tool({
      name: "radian_send",
      description: "Type a message into a worker's session, for example to answer its question.",
      parameters: Type.Object({ worker: workerParameter, text: Type.String() }),
      run: async ({ worker, text }) => {
        const named = state.namedWorker(worker);
        return sendToWorker(named.env, named.worker, text);
      },
    }),
    tool({
      name: "radian_stop",
      description: "Close a worker's pane. Its worktree and branch are kept.",
      parameters: Type.Object({ worker: workerParameter }),
      run: async ({ worker }) => {
        const named = state.namedWorker(worker);
        return stopWorker(named.env, named.worker);
      },
    }),
    tool({
      name: "radian_merge",
      description:
        "Ask the user to approve merging a worker's branch into the target branch. Only the user's approval merges; report exactly what this tool returns.",
      parameters: Type.Object({ worker: workerParameter }),
      run: async ({ worker }, ctx) => {
        const named = state.namedWorker(worker);
        return mergeWithApproval(ctx, named.env, named.worker);
      },
    }),
    tool({
      name: "radian_discard",
      description:
        "Ask the user to approve throwing a worker's work away: its pane, worktree, and branch are removed without merging. Use it for failed launches, rejected changes, or the losing side of a conflict. Only the user's approval discards; report exactly what this tool returns.",
      parameters: Type.Object({ worker: workerParameter }),
      run: async ({ worker }, ctx) => {
        const named = state.namedWorker(worker);
        return discardWithApproval(ctx, named.env, named.worker);
      },
    }),
    tool({
      name: "radian_allow_tool",
      description:
        "Ask the user to approve an MCP tool (mcp__<server> or mcp__<server>__<tool>) for this project's workers, for example when a worker reports the tool was denied. Only the user's approval adds it, and it applies to workers dispatched afterwards.",
      parameters: Type.Object({
        tool: Type.String({ description: "e.g. mcp__godot__run_project, or mcp__godot for all" }),
        reason: Type.String({ description: "Why the workers need it, for the user" }),
      }),
      run: async (params, ctx) => allowWorkerTool(state, ctx, params),
    }),
  ];
  for (const definition of tools) state.pi.registerTool(definition);
}

function writeDoc(state: State, relative: string, content: string): string {
  const normalized = path.normalize(relative);
  if (path.isAbsolute(normalized) || normalized.startsWith("..") || normalized === ".") {
    throw new RadianError(
      "invalid_path",
      `${relative} must be a relative path inside .radian/planning/.`,
    );
  }
  const file = path.join(state.requireProject().project.path, PLANNING_DIR, normalized);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return `Wrote ${path.join(PLANNING_DIR, normalized)}.`;
}

async function allowWorkerTool(
  state: State,
  ctx: Parameters<ToolDefinition["execute"]>[4],
  request: { tool: string; reason: string },
): Promise<string> {
  assertWorkerToolName(request.tool);
  const { project } = state.requireProject();
  if (readWorkerTools(project.path).includes(request.tool)) {
    return `${request.tool} is already allowed for workers in ${project.name}.`;
  }
  const isApproved = await approveWorkerTool(ctx, { project: project.name, ...request });
  if (!isApproved) return `${request.tool} not allowed: the user said no.`;
  addWorkerTool(project.path, request.tool);
  return `Allowed ${request.tool} for new workers in ${project.name}. Workers already running keep their tools; dispatch a new worker to use it.`;
}

/** Radian tools return plain text; thrown errors become failed tool results for the model. */
function tool<TParams extends TSchema>(input: {
  name: string;
  description: string;
  parameters: TParams;
  run: (
    params: ToolParams<TParams>,
    ctx: Parameters<ToolDefinition<TParams>["execute"]>[4],
  ) => Promise<string>;
}): ToolDefinition<TParams> {
  return {
    name: input.name,
    label: input.name,
    description: input.description,
    promptSnippet: input.description,
    parameters: input.parameters,
    // Pi passes (toolCallId, params, signal, onUpdate, ctx); Radian needs only params and ctx.
    async execute(...args): Promise<AgentToolResult<unknown>> {
      const [, params, , , ctx] = args;
      const text = await input.run(params, ctx);
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}

type ToolParams<TParams extends TSchema> = Parameters<ToolDefinition<TParams>["execute"]>[1];
