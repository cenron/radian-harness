// Harness provenance recorded when a run starts: the version actually running,
// the immutable source revision, and whether the source tree is locally
// modified. Later reports use this record, never the currently installed
// version, so mixed-version metrics keep per-run attribution.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git, locateGit } from "../git/exec.ts";
import type { HarnessProvenance } from "../state/model.ts";
import { succeeded } from "../util/proc.ts";

export function harnessRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export async function harnessProvenance(root = harnessRoot()): Promise<HarnessProvenance> {
  let version = "unknown";
  try {
    version = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    // keep unknown
  }
  const gitPath = locateGit();
  if (!gitPath) return { version, revision: "unknown", locallyModified: "unknown" };
  const ctx = { gitPath, cwd: root };
  const head = await git(ctx, ["rev-parse", "--verify", "HEAD"]);
  if (!succeeded(head)) return { version, revision: "unknown", locallyModified: "unknown" };
  const status = await git(ctx, ["status", "--porcelain", "--untracked-files=normal"]);
  return {
    version,
    revision: head.stdout.toString("utf8").trim(),
    locallyModified: succeeded(status) ? status.stdout.length > 0 : "unknown",
  };
}
