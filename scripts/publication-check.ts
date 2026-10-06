// Thin entry point for the publication check. On macOS, the scan re-executes
// itself under a sandbox profile that denies writes to the repository and its
// Git directory, with a private scratch directory for temporary files.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, runCheck } from "../src/publication/cli.ts";
import { gitText, locateGit } from "../src/git/exec.ts";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

function sandboxString(value: string): string {
  return JSON.stringify(value);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`publication-check: ${parsed.error}\n`);
    return 2;
  }
  const prePushInput = parsed.prePush ? readFileSync(0, "utf8") : "";

  if (process.env.RADIAN_PUBLICATION_BOUNDED !== "1" && process.platform === "darwin" && existsSync(SANDBOX_EXEC)) {
    const gitPath = locateGit();
    if (!gitPath) {
      process.stderr.write("publication-check: git executable not found\n");
      return 2;
    }
    const cwd = parsed.repo ?? process.cwd();
    const root = realpathSync(await gitText({ gitPath, cwd }, ["rev-parse", "--show-toplevel"]));
    const commonDir = realpathSync(await gitText({ gitPath, cwd }, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    const scratch = mkdtempSync(path.join(os.tmpdir(), "radian-publication-"));
    const profile = [
      "(version 1)",
      "(allow default)",
      `(deny file-write* (subpath ${sandboxString(root)}))`,
      `(deny file-write* (subpath ${sandboxString(commonDir)}))`,
    ].join("\n");
    try {
      const child = spawnSync(
        SANDBOX_EXEC,
        ["-p", profile, process.execPath, import.meta.filename, ...argv, "--bounded-state", "macOS sandbox profile; repository and Git directory read-only; private scratch"],
        {
          cwd,
          input: prePushInput,
          stdio: ["pipe", "inherit", "inherit"],
          env: { ...process.env, RADIAN_PUBLICATION_BOUNDED: "1", TMPDIR: realpathSync(scratch) },
        },
      );
      if (child.error || child.status === null) {
        process.stderr.write("publication-check: bounded execution failed; result INCOMPLETE\n");
        return 2;
      }
      return child.status;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  if (parsed.bounded === "unknown") {
    parsed.bounded = process.platform === "darwin" ? "not OS-bounded (sandbox-exec unavailable); read-only Git plumbing only" : "not OS-bounded on this platform; read-only Git plumbing only";
  }
  const outcome = await runCheck(parsed, prePushInput);
  process.stdout.write(outcome.lines.join("\n") + "\n");
  return outcome.exitCode;
}

process.exitCode = await main();
