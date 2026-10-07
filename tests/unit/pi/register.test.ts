import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HARNESS_ROOT, makeWorkerEnv } from "../../helpers/worker-fixtures.ts";
import { RegisterRadian } from "../../../src/pi/register.ts";

type SessionHandler = (event: unknown, ctx: ExtensionContext) => unknown;

/** Starts Radian in a TUI session at the workspace root, tagged with `project` when given. */
async function startSession(project: string | undefined) {
  const { env } = await makeWorkerEnv();
  const handlers = new Map<string, SessionHandler>();
  const activeTools: string[][] = [];
  const editors: unknown[] = [];
  const errors: string[] = [];
  const pi = {
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerToolRenderer: () => undefined,
    on: (event: string, handler: SessionHandler) => handlers.set(event, handler),
    setActiveTools: (names: string[]) => activeTools.push(names),
    getThinkingLevel: () => "medium",
  } as unknown as ExtensionAPI;
  const entries = project
    ? [{ type: "custom", customType: "radian-project", data: { project } }]
    : [];
  const ctx = {
    cwd: env.workspaceRoot,
    mode: "tui",
    hasUI: true,
    model: undefined,
    sessionManager: { getEntries: () => entries, getSessionFile: () => undefined },
    ui: {
      notify: (message: string, level: string) => level === "error" && errors.push(message),
      setStatus: () => undefined,
      setWidget: () => undefined,
      setEditorComponent: (editor: unknown) => editors.push(editor),
      theme: { fg: (_color: string, text: string) => text },
    },
  } as unknown as ExtensionContext;

  const radian = new RegisterRadian(pi, {
    harnessRoot: HARNESS_ROOT,
    herdr: env.herdr,
    paneId: "w1:p1",
  });
  radian.initialize();
  await handlers.get("session_start")?.({}, ctx);
  const endSession = () => handlers.get("session_shutdown")?.({}, ctx);
  return { radian, activeTools, editors, errors, endSession };
}

test("a session with no project selected starts the dashboard without a watcher or mode editor", async () => {
  const { radian, activeTools, editors, errors } = await startSession(undefined);
  assert.deepEqual(errors, []);
  assert.equal(radian.state.view?.project, undefined);
  assert.ok(activeTools.at(-1)?.includes("radian_status"));
  assert.ok(!activeTools.at(-1)?.includes("radian_dispatch"));
  assert.deepEqual(editors, []);
  assert.equal(radian.state.stopWatcher, undefined);
});

test("a session with a project selected gets the mode editor and the worker watcher", async () => {
  const { radian, activeTools, editors, errors, endSession } = await startSession("demo");
  assert.deepEqual(errors, []);
  assert.equal(radian.state.view?.project?.name, "demo");
  assert.ok(activeTools.at(-1)?.includes("radian_dispatch"));
  assert.equal(editors.length, 1);
  assert.notEqual(radian.state.stopWatcher, undefined);
  endSession();
  assert.equal(radian.state.stopWatcher, undefined);
  assert.equal(editors.at(-1), undefined, "the mode editor is removed when the session ends");
});
