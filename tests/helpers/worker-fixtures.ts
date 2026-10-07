import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerRecord } from "../../src/core/worker.ts";
import { loadConfig } from "../../src/io/config.ts";
import { writeJsonFile } from "../../src/io/json-file.ts";
import { createProject } from "../../src/io/workspace.ts";
import type { WorkerEnv } from "../../src/workers/worker-env.ts";
import { createFakeHerdr, type FakeHerdr } from "./fake-herdr.ts";
import { commitFile, makeTempDir } from "./git-fixtures.ts";

export const HARNESS_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** A workspace with one fresh project, the shipped configuration, and a fake Herdr. */
export async function makeWorkerEnv(): Promise<{ env: WorkerEnv; herdr: FakeHerdr }> {
  const workspaceRoot = makeTempDir();
  writeJsonFile(path.join(workspaceRoot, ".radian", "workspace.json"), { version: 1 });
  const project = await createProject(workspaceRoot, { name: "demo", branch: "main" });
  const herdr = createFakeHerdr();
  const env: WorkerEnv = {
    workspaceRoot,
    project,
    config: loadConfig({ harnessRoot: HARNESS_ROOT, workspaceRoot }),
    harnessRoot: HARNESS_ROOT,
    herdr: herdr.run,
    paneId: "w1:p1",
  };
  return { env, herdr };
}

/** Plays the worker agent: commits in its worktree and appends status lines. */
export function actAsWorker(
  worker: WorkerRecord,
  input: { file?: string; status: string[] },
): void {
  if (input.file) commitFile(worker.worktree, input.file, `${input.file}\n`, `add ${input.file}`);
  const statusFile = path.join(
    path.dirname(path.dirname(worker.worktree)),
    "workers",
    worker.name,
    "status",
  );
  appendFileSync(statusFile, input.status.map((line) => `${line}\n`).join(""));
}
