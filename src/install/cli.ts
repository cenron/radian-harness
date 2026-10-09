import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { RadianError } from "../core/errors.ts";
import { errorMessage } from "../core/utils/errors.ts";
import type { InstallPlan, InstallStatus } from "./installer.ts";
import { applyPlan, planInstall, planRemove, planUpdate, readInstallStatus } from "./installer.ts";

const usage =
  "Usage: node src/install/cli.ts <install|update|remove|status> [--workspace <dir>] [--yes]";

interface CliOptions {
  command: "install" | "update" | "remove" | "status";
  workspace: string;
  shouldSkipQuestion: boolean;
}

process.exitCode = await main(process.argv.slice(2));

async function main(args: string[]): Promise<number> {
  try {
    await run(parseArguments(args));
    return 0;
  } catch (error) {
    const isUsageError = error instanceof RadianError && error.code === "usage";
    console.error(isUsageError ? `${error.message}\n${usage}` : errorMessage(error));
    return isUsageError ? 2 : 1;
  }
}

async function run(options: CliOptions): Promise<void> {
  if (options.command === "status") {
    printStatus(readInstallStatus(options.workspace));
    return;
  }
  const plan = planFor(options);
  printPlan(plan);
  if (plan.changes.length === 0) return;
  if (!(await isConfirmed(options.shouldSkipQuestion))) {
    console.log("No changes made.");
    return;
  }
  applyPlan(plan);
  console.log(`Done: ${plan.operation} applied to ${plan.workspace}.`);
}

function parseArguments(args: string[]): CliOptions {
  const [command, ...rest] = args;
  if (
    command !== "install" &&
    command !== "update" &&
    command !== "remove" &&
    command !== "status"
  ) {
    const problem = command === undefined ? "Missing command." : `Unknown command: ${command}`;
    throw new RadianError("usage", problem);
  }
  let workspace = process.env.INIT_CWD ?? process.cwd();
  let shouldSkipQuestion = false;
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (argument === "--yes") {
      shouldSkipQuestion = true;
    } else if (argument === "--workspace" && rest[index + 1] !== undefined) {
      workspace = rest[++index] as string;
    } else {
      throw new RadianError("usage", `Unknown or incomplete option: ${argument}`);
    }
  }
  return { command, workspace, shouldSkipQuestion };
}

function planFor(options: CliOptions): InstallPlan {
  const workspace = options.workspace;
  if (options.command === "install") return planInstall({ workspace, harness: harnessRoot() });
  if (options.command === "update") return planUpdate({ workspace, harness: harnessRoot() });
  return planRemove({ workspace });
}

/** The checkout that contains this file: src/install/cli.ts → two levels up. */
function harnessRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

async function isConfirmed(shouldSkipQuestion: boolean): Promise<boolean> {
  if (shouldSkipQuestion) return true;
  if (!stdin.isTTY) {
    throw new RadianError(
      "confirmation_required",
      "No terminal to confirm the changes; run again with --yes to apply them.",
    );
  }
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question("Apply these changes? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

function printPlan(plan: InstallPlan): void {
  if (plan.changes.length === 0) {
    console.log(`Nothing to ${plan.operation} in ${plan.workspace}.`);
    return;
  }
  console.log(`Radian ${plan.operation} in ${plan.workspace}:`);
  for (const change of plan.changes) {
    console.log(`  ${path.relative(plan.workspace, change.path)}: ${change.description}`);
  }
}

function printStatus(status: InstallStatus): void {
  console.log(`Workspace: ${status.workspace}`);
  if (!status.isInstalled) {
    console.log("Radian is not installed here.");
    return;
  }
  console.log(`Harness: ${status.harness}${status.hasHarness ? "" : " (missing)"}`);
  console.log(
    `Package entry: ${status.packageEntry}${status.hasPackageEntry ? "" : " (not in .pi/settings.json; run update)"}`,
  );
  console.log(`Workspace record: ${status.hasWorkspaceFile ? "present" : "missing (run update)"}`);
}
