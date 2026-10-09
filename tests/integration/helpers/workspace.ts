import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyPlan, planInstall } from "../../../src/install/installer.ts";
import { writeJsonFile } from "#core/utils/json.ts";
import { HARNESS_ROOT } from "../../helpers/worker-fixtures.ts";
import { makeTempDir } from "../../helpers/git-fixtures.ts";
import { startPi, type PiProcess } from "./pi-rpc.ts";

export interface TestWorkspace {
  root: string;
  pi: PiProcess;
  modelLog: () => Array<{
    systemPrompt: string;
    tools: string[];
    transcript: Array<{ role: string; text: string }>;
  }>;
  herdrCalls: () => string[][];
}

/** A workspace installed with the real installer, Pi running in it, and a fake Herdr on PATH. */
export function startWorkspace(): TestWorkspace {
  const sandbox = makeTempDir();
  const root = path.join(sandbox, "workspace");
  mkdirSync(root);
  applyPlan(planInstall({ workspace: root, harness: HARNESS_ROOT }));
  writeJsonFile(path.join(root, ".radian", "config", "harness.json"), { pollSeconds: 0.2 });
  const bin = path.join(sandbox, "bin");
  mkdirSync(bin);
  const fakeHerdr = path.resolve(import.meta.dirname, "../fixtures/fake-herdr.ts");
  writeFileSync(
    path.join(bin, "herdr"),
    `#!/bin/sh\nexec "${process.execPath}" "${fakeHerdr}" "$@"\n`,
  );
  chmodSync(path.join(bin, "herdr"), 0o755);
  const log = path.join(sandbox, "model.jsonl");
  const herdrState = path.join(sandbox, "herdr.json");
  const pi = startPi({
    cwd: root,
    sandbox,
    env: {
      PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HERDR_PANE_ID: "w1:p1",
      RADIAN_TEST_LOG: log,
      FAKE_HERDR_STATE: herdrState,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Radian Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Radian Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  return {
    root,
    pi,
    modelLog: () => readLines(log),
    herdrCalls: () =>
      existsSync(herdrState) ? JSON.parse(readFileSync(herdrState, "utf8")).calls : [],
  };
}

function readLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
