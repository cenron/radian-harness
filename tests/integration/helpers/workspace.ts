// Disposable installed workspaces and an offline Pi for native probes.

import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutable } from "../../../src/util/proc.ts";
import { applyPlan, planInstall } from "../../../src/workspace/installer.ts";
import { makeRepo, tempDir } from "../../unit/helpers/fixture.ts";
import { PiRpc, type UiResponder } from "./pi-rpc.ts";

export const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const PROBE_MODEL = path.join(HARNESS, "tests", "integration", "fixtures", "probe-model.ts");

export function installedPi(): string | undefined {
  const exe = resolveExecutable("pi", process.env.PATH);
  if (!exe) return undefined;
  const out = spawnSync(exe, ["--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: tempDir("radian-ver-") }, timeout: 20_000 });
  return `${out.stdout}${out.stderr}`.includes("1.0.2") ? realpathSync(exe) : undefined;
}

/** An installed workspace with registered Git projects (each with a marker AGENTS.md and file). */
export async function installedWorkspace(names: string[] = []) {
  const root = tempDir("radian-native-");
  const ws = path.join(root, "ws");
  mkdirSync(ws);
  writeFileSync(path.join(ws, "AGENTS.md"), "WORKSPACE-MARKER\n");
  const dirs: Record<string, string> = {};
  for (const name of names) {
    const dir = path.join(ws, name);
    mkdirSync(dir);
    const repo = await makeRepo(dir);
    repo.write("AGENTS.md", `PROJECT-${name.toUpperCase()}-MARKER\n`);
    repo.write(`${name}.txt`, `content-of-${name}\n`);
    await repo.commitAll("base");
    dirs[name] = dir;
  }
  const plan = await planInstall({ workspaceRoot: ws, source: { kind: "local", path: HARNESS }, projects: names.map((n) => ({ path: dirs[n]!, target: "refs/heads/main" })) });
  if (!plan.ok) throw new Error(plan.blocker.message);
  const applied = applyPlan(plan.value, plan.value.hash);
  if (!applied.ok) throw new Error(applied.blocker.message);
  return { root, ws, dirs };
}

/** Pi at the workspace root, trusted for this run only, with the faux model; requests are logged. */
export function workspacePi(pi: string, root: string, cwd: string, log: string, ui?: UiResponder, extraArgs: string[] = []): PiRpc {
  const options: ConstructorParameters<typeof PiRpc>[0] = { pi, cwd, sandbox: path.join(root, "sb"), args: ["--approve", "-e", PROBE_MODEL, ...extraArgs], env: { RADIAN_PROBE_LOG: log } };
  if (ui) options.ui = ui;
  return new PiRpc(options);
}
