import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { listProjects } from "../../src/io/workspace.ts";
import { chooseOption, waitForNote } from "./helpers/notes.ts";
import { startWorkspace } from "./helpers/workspace.ts";

test("projects keep separate conversations in one Pi process", async () => {
  const workspace = startWorkspace();
  const { pi } = workspace;
  try {
    await pi.prompt("/projects create alpha");
    await waitForNote(pi, /Project alpha selected/);
    await pi.prompt("remember alpha");
    await pi.prompt("/projects create beta");
    await waitForNote(pi, /Project beta selected/);
    await pi.prompt("remember beta");
    await pi.prompt("/projects select alpha");
    await pi.prompt("back in alpha");

    const requests = workspace.modelLog();
    const last = requests.at(-1);
    const said = (last?.transcript ?? []).map((message) => message.text);
    assert.ok(said.includes("remember alpha") && !said.includes("remember beta"), said.join(" | "));
    assert.match(
      last?.systemPrompt ?? "",
      /Radian project alpha at .*alpha; workers merge into main/,
    );
    assert.match(last?.systemPrompt ?? "", /Mode: PLAN/);
    assert.ok(last?.tools.includes("radian_dispatch"));
    assert.ok(!last?.tools.includes("bash"));
    await pi.prompt("/workspace");
    await waitForNote(pi, /Workspace dashboard/);
  } finally {
    await pi.close();
  }
});

test("after planning, clearing context builds from the plan in a fresh project session", async () => {
  const workspace = startWorkspace();
  const { pi, root } = workspace;
  try {
    await pi.prompt("/projects create alpha");
    await waitForNote(pi, /Project alpha selected/);
    await pi.prompt("exploring the login options at length");
    const plan = { path: "login-plan.md", content: "# Login plan\n\nBuild the login form." };
    await pi.prompt(`TOOL radian_write_doc ${JSON.stringify(plan)}`);
    const sessionFile = path.join(root, ".radian", "projects", "alpha", "session.json");
    const planningSession = readFileSync(sessionFile, "utf8");

    chooseOption(pi, /^Clear context/);
    await pi.prompt("/radian mode build");
    await waitForNote(pi, /Fresh session for alpha/);
    const handoff = await waitForRequest(workspace, (said) =>
      said[0]?.startsWith("Implementation handoff"),
    );

    assert.equal(handoff.length, 1, `the model sees only the handoff: ${handoff.join(" | ")}`);
    assert.match(handoff[0] ?? "", /\.radian\/planning\/login-plan\.md/);
    assert.match(handoff[0] ?? "", /Build the login form\./);
    assert.match(workspace.modelLog().at(-1)?.systemPrompt ?? "", /Mode: BUILD/);
    assert.notEqual(
      readFileSync(sessionFile, "utf8"),
      planningSession,
      "the project now resumes the fresh session",
    );
  } finally {
    await pi.close();
  }
});

/** Polls the model log until a request's transcript matches; returns that transcript's texts. */
async function waitForRequest(
  workspace: ReturnType<typeof startWorkspace>,
  matches: (said: string[]) => boolean | undefined,
): Promise<string[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = workspace
      .modelLog()
      .map((request) => request.transcript.map((message) => message.text))
      .find((said) => matches(said));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The model never received the expected request.");
}

test("the guard blocks bash and reads stay inside the project", async () => {
  const workspace = startWorkspace();
  const { pi } = workspace;
  try {
    await pi.prompt("/projects create alpha");
    await waitForNote(pi, /Project alpha selected/);
    await pi.prompt('TOOL bash {"command":"ls"}');
    await pi.prompt('TOOL read {"path":"../.radian/projects.json"}');
    await pi.prompt('TOOL radian_write_doc {"path":"plan.md","content":"# Plan"}');
    await pi.prompt('TOOL read {"path":".radian/planning/plan.md"}');
    const results = workspace
      .modelLog()
      .flatMap((request) => request.transcript)
      .filter((message) => message.role === "toolResult")
      .map((message) => message.text);
    // bash is not among the active tools; the guard is the second line if it ever were.
    assert.ok(
      results.some((text) => /does not run shell commands|Tool bash not found/.test(text)),
      results.join("\n"),
    );
    assert.ok(
      results.some((text) => /outside the selected project/.test(text)),
      results.join("\n"),
    );
    assert.ok(
      results.some((text) => /# Plan/.test(text)),
      results.join("\n"),
    );
  } finally {
    await pi.close();
  }
});

test("/projects delete removes a project, keeping or deleting its files", async () => {
  const workspace = startWorkspace();
  const { pi, root } = workspace;
  try {
    await pi.prompt("/projects create keep");
    await waitForNote(pi, /Project keep selected/);
    await pi.prompt("/projects create gone");
    await waitForNote(pi, /Project gone selected/);

    chooseOption(pi, /keep files/);
    await pi.prompt("/projects delete keep");
    await waitForNote(pi, /Removed project keep/);
    assert.ok(existsSync(path.join(root, "keep", ".git")));

    chooseOption(pi, /Delete project and files/);
    await pi.prompt("/projects delete gone");
    await waitForNote(pi, /Workspace dashboard/);
    assert.equal(existsSync(path.join(root, "gone")), false);
    assert.deepEqual(listProjects(root), []);
  } finally {
    await pi.close();
  }
});
