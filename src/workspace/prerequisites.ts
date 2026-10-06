// Local prerequisite checks for installation: the running Node, Git, and Pi.
// Read-only and offline: version queries only, with an empty temporary HOME so
// no personal configuration or credential is read. Missing or unreviewed tools
// block; Radian never installs or upgrades tools.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { locateGit } from "../git/exec.ts";
import { resolveExecutable } from "../util/proc.ts";

export interface Prerequisites {
  node: string;
  git: string;
  pi: string;
}

export const REVIEWED_PI_VERSION = "1.0.2";
const MIN_NODE: [number, number] = [22, 18];
const MIN_GIT: [number, number] = [2, 42];

function atLeast(version: string, min: [number, number]): boolean {
  const [major = 0, minor = 0] = version.split(".").map((n) => Number.parseInt(n, 10));
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

function versionOf(exe: string, args: string[]): string | undefined {
  const home = mkdtempSync(path.join(os.tmpdir(), "radian-prereq-"));
  try {
    const out = spawnSync(exe, args, { encoding: "utf8", timeout: 20_000, env: { PATH: "/usr/bin:/bin", HOME: home, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", TERM: "dumb" } });
    if (out.status !== 0) return undefined;
    return /(\d+\.\d+\.\d+)/.exec(`${out.stdout}\n${out.stderr}`)?.[1];
  } catch {
    return undefined;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export function checkPrerequisites(env: NodeJS.ProcessEnv = process.env): Outcome<Prerequisites> {
  const node = process.versions.node;
  if (!atLeast(node, MIN_NODE)) return refuse("PREREQUISITE_MISSING", `Node ${node} is too old; Radian needs Node ${MIN_NODE.join(".")} or later`, "Install a supported Node yourself, then preview again.");
  const gitPath = locateGit();
  const git = gitPath ? versionOf(gitPath, ["--version"]) : undefined;
  if (!git) return refuse("PREREQUISITE_MISSING", "Git was not found", "Install Git yourself, then preview again.");
  if (!atLeast(git, MIN_GIT)) return refuse("PREREQUISITE_MISSING", `Git ${git} is too old; Radian needs Git ${MIN_GIT.join(".")} or later`);
  const piPath = resolveExecutable("pi", env.PATH);
  const pi = piPath ? versionOf(piPath, ["--version"]) : undefined;
  if (!pi) return refuse("PREREQUISITE_MISSING", "Pi was not found on PATH", "Install Pi yourself, then preview again.");
  if (pi !== REVIEWED_PI_VERSION) return refuse("PREREQUISITE_MISSING", `Pi ${pi} has not been reviewed for Radian (reviewed: ${REVIEWED_PI_VERSION})`);
  return success({ node, git, pi });
}
