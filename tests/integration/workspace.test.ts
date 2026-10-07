import assert from "node:assert/strict";
import { test } from "node:test";
import { startWorkspace } from "./helpers/workspace.ts";

test("Pi loads Radian in a workspace and shows the dashboard", async () => {
  const workspace = startWorkspace();
  try {
    await workspace.pi.prompt("/radian status");
    assert.ok(
      workspace.pi.notes().some((note) => /No projects yet/.test(note)),
      workspace.pi.notes().join("\n"),
    );
    await workspace.pi.prompt("hello");
    const [request] = workspace.modelLog();
    assert.match(request?.systemPrompt ?? "", /Radian workspace dashboard/);
    assert.deepEqual(request?.tools.sort(), ["find", "grep", "ls", "radian_status", "read"]);
  } finally {
    await workspace.pi.close();
  }
});
