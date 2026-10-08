import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
