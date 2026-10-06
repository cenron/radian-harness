// Optional owned pre-push hook. Installation never overwrites an existing
// personal hook or an alternative hooks path; removal deletes only an unchanged
// hook that carries Radian's ownership marker.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { type GitContext, git, gitText } from "../git/exec.ts";
import { succeeded } from "../util/proc.ts";

export const HOOK_MARKER = "# radian-harness owned hook: publication check";

export function hookBody(): string {
  return [
    "#!/bin/sh",
    HOOK_MARKER,
    "# Runs the generic publication scan before pushing. Remove with:",
    "#   node scripts/publication-hooks.ts remove",
    "exec node scripts/publication-check.ts --pre-push",
    "",
  ].join("\n");
}

export function hookHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export type HookResult = { ok: true; message: string } | { ok: false; message: string };

async function hookPath(ctx: GitContext): Promise<{ file?: string; refusal?: string }> {
  const configured = await git(ctx, ["config", "--local", "--get", "core.hooksPath"]);
  if (succeeded(configured) && configured.stdout.toString("utf8").trim() !== "") {
    return { refusal: "core.hooksPath is configured locally; refusing to manage hooks owned by another tool" };
  }
  const commonDir = await gitText(ctx, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return { file: path.join(commonDir, "hooks", "pre-push") };
}

export async function installHook(ctx: GitContext): Promise<HookResult> {
  const located = await hookPath(ctx);
  if (!located.file) return { ok: false, message: located.refusal ?? "hook path unavailable" };
  const body = hookBody();
  if (existsSync(located.file)) {
    const current = readFileSync(located.file, "utf8");
    if (current === body) return { ok: true, message: "owned pre-push hook already installed" };
    return { ok: false, message: "a pre-push hook already exists and is not an unchanged Radian hook; left untouched" };
  }
  mkdirSync(path.dirname(located.file), { recursive: true });
  writeFileSync(located.file, body, { flag: "wx", mode: 0o755 });
  chmodSync(located.file, 0o755);
  return { ok: true, message: "installed owned pre-push hook" };
}

export async function removeHook(ctx: GitContext): Promise<HookResult> {
  const located = await hookPath(ctx);
  if (!located.file) return { ok: false, message: located.refusal ?? "hook path unavailable" };
  if (!existsSync(located.file)) return { ok: true, message: "no pre-push hook present" };
  const current = readFileSync(located.file, "utf8");
  if (hookHash(current) !== hookHash(hookBody())) {
    return { ok: false, message: "pre-push hook is not an unchanged Radian hook; left untouched" };
  }
  unlinkSync(located.file);
  return { ok: true, message: "removed owned pre-push hook" };
}
