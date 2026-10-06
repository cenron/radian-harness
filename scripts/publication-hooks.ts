// Thin entry point to install or remove the optional owned pre-push hook.
// Existing personal hooks and custom hook paths are never overwritten.

import { installHook, removeHook } from "../src/publication/hooks.ts";
import { locateGit } from "../src/git/exec.ts";

const action = process.argv[2];
const gitPath = locateGit();
if (!gitPath || (action !== "install" && action !== "remove")) {
  process.stderr.write("usage: node scripts/publication-hooks.ts install|remove\n");
  process.exitCode = 2;
} else {
  const ctx = { gitPath, cwd: process.cwd() };
  const result = action === "install" ? await installHook(ctx) : await removeHook(ctx);
  process.stdout.write(result.message + "\n");
  process.exitCode = result.ok ? 0 : 1;
}
