// Canonical command-line entry for workspace binding operations, used by the
// thin `install.sh` wrapper and `scripts/radian-workspace.ts`.
//
// `install.sh` passes `--workspace-default <caller dir>`: when no explicit
// `--workspace` is given, the caller's current directory is the target and is
// displayed before anything happens. Every mutating command previews first.
// With an interactive terminal, the user may confirm the exact previewed plan;
// otherwise applying requires `--apply <plan-hash>` naming the reviewed plan.

import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseCommand, runCommand } from "./cli.ts";

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = [...argv];
  const defaultAt = args.indexOf("--workspace-default");
  let defaulted: string | undefined;
  if (defaultAt >= 0) {
    defaulted = args[defaultAt + 1];
    args.splice(defaultAt, 2);
    if (!defaulted) {
      process.stderr.write("radian-workspace: --workspace-default needs a value\n");
      return 2;
    }
    if (!args.includes("--workspace")) {
      args.push("--workspace", defaulted);
      process.stdout.write(`Target workspace: ${defaulted} (the current directory; pass --workspace <dir> to choose another)\n`);
    }
  }
  const parsed = parseCommand(args);
  if ("error" in parsed) {
    process.stderr.write(`radian-workspace: ${parsed.error}\n`);
    return 2;
  }
  const preview = await runCommand(parsed);
  process.stdout.write(preview.lines.join("\n") + "\n");
  if (preview.exitCode === 2 || parsed.apply || !["install", "update", "remove"].includes(parsed.command)) return preview.exitCode;
  const hash = /Plan hash: (\S+)/.exec(preview.lines.join("\n"))?.[1];
  if (!hash || !process.stdin.isTTY || !process.stdout.isTTY) return preview.exitCode;
  if (!(await confirm(`Apply exactly this plan (${hash.slice(0, 19)}…) to ${parsed.workspace}? [y/N] `))) {
    process.stdout.write("Not applied; nothing was written.\n");
    return 0;
  }
  const applied = await runCommand({ ...parsed, apply: hash });
  process.stdout.write(applied.lines.slice(-1).join("\n") + "\n");
  return applied.exitCode;
}

function invokedDirectly(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = await main(process.argv.slice(2));
