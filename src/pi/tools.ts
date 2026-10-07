import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { RadianError } from "../core/errors.ts";
import { ROLES, parseRole } from "../core/roles.ts";
import { runReadOnlyGit } from "../io/git.ts";
import { findWorker, listWorkers } from "../io/worker-store.ts";
import { dispatchWorker } from "../workers/dispatch.ts";
import { sendToWorker, stopWorker } from "../workers/finish.ts";
import { workersFileOf } from "../workers/worker-env.ts";
import { statusReport } from "./commands.ts";
import { mergeWithApproval } from "./dialogs.ts";
import { currentMode, requireProject, workerEnvOf, type RadianState } from "./state.ts";
import { workersReport } from "./status-view.ts";

export const RADIAN_TOOL_NAMES = [
  "radian_status",
  "radian_write_doc",
  "radian_git",
  "radian_dispatch",
  "radian_workers",
  "radian_send",
  "radian_stop",
  "radian_merge",
];

const MAX_GIT_OUTPUT_CHARS = 50_000;
const PLANNING_DIR = path.join(".radian", "planning");
const workerParameter = Type.String({ description: "Worker name, e.g. demo-developer-1" });

export function registerTools(state: RadianState): void {
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
        const output = await runReadOnlyGit(requireProject(state).project.path, args);
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
        const view = requireProject(state);
        const request = { ...params, role: parseRole(params.role) };
        const worker = await dispatchWorker(workerEnvOf(state), request, currentMode(view));
        const started = `Started ${worker.name} (${worker.runtime} ${worker.model}, effort ${worker.effort}) in pane ${worker.pane} on branch ${worker.branch}.`;
        if (worker.isTaskPending) {
          return `${started} Its agent is showing a startup prompt (for example, asking to trust the worktree folder). Ask the user to answer it in pane ${worker.pane}; Radian types in the task once the agent is ready.`;
        }
        return `${started} Its status updates arrive as messages.`;
      },
    }),
    tool({
      name: "radian_workers",
      description: "List the selected project's workers with their state and last status.",
      parameters: Type.Object({}),
      run: async () => workersReport(listWorkers(workersFileOf(workerEnvOf(state)))),
    }),
    tool({
      name: "radian_send",
      description: "Type a message into a worker's session, for example to answer its question.",
      parameters: Type.Object({ worker: workerParameter, text: Type.String() }),
      run: async ({ worker, text }) => {
        const env = workerEnvOf(state);
        return sendToWorker(env, findWorker(workersFileOf(env), worker), text);
      },
    }),
    tool({
      name: "radian_stop",
      description: "Close a worker's pane. Its worktree and branch are kept.",
      parameters: Type.Object({ worker: workerParameter }),
      run: async ({ worker }) => {
        const env = workerEnvOf(state);
        return stopWorker(env, findWorker(workersFileOf(env), worker));
      },
    }),
    tool({
      name: "radian_merge",
      description:
        "Ask the user to approve merging a worker's branch into the target branch. Only the user's approval merges; report exactly what this tool returns.",
      parameters: Type.Object({ worker: workerParameter }),
      run: async ({ worker }, ctx) => {
        const env = workerEnvOf(state);
        return mergeWithApproval(ctx, env, findWorker(workersFileOf(env), worker));
      },
    }),
  ];
  for (const definition of tools) state.pi.registerTool(definition);
}

function writeDoc(state: RadianState, relative: string, content: string): string {
  const normalized = path.normalize(relative);
  if (path.isAbsolute(normalized) || normalized.startsWith("..") || normalized === ".") {
    throw new RadianError(
      "invalid_path",
      `${relative} must be a relative path inside .radian/planning/.`,
    );
  }
  const file = path.join(requireProject(state).project.path, PLANNING_DIR, normalized);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return `Wrote ${path.join(PLANNING_DIR, normalized)}.`;
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
