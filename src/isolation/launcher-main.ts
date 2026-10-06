// Entry point run inside an owned Herdr pane:
//   node src/isolation/launcher-main.ts <specFile> <specHash>
// Starts the worker's interactive runtime session on this pane's terminal.
// Prints a sanitized blocker and exits non-zero when any launch check fails.

import { launchRuntime, prepareLaunch } from "./launcher.ts";

const [specFile, specHash] = process.argv.slice(2);
if (!specFile || !specHash) {
  process.stderr.write("radian launcher: missing launch spec\n");
  process.exitCode = 2;
} else {
  const prepared = prepareLaunch(specFile, specHash);
  if (!prepared.ok) {
    process.stderr.write(`radian launcher: BLOCKED ${prepared.blocker.code}: ${prepared.blocker.message}\n`);
    process.exitCode = 3;
  } else {
    const result = await launchRuntime(prepared.value);
    if (!result.ok) {
      process.stderr.write(`radian launcher: BLOCKED ${result.blocker.code}: ${result.blocker.message}\n`);
      process.exitCode = 3;
    } else {
      process.exitCode = result.value.exitCode ?? 1;
    }
  }
}
