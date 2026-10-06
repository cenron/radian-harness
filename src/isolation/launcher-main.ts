// Entry point run inside an owned Herdr pane:
//   node src/isolation/launcher-main.ts <specFile> <specHash>
// Prints a sanitized blocker and exits non-zero when any launch check fails.

import { launchContained, prepareLaunch, terminalDevice } from "./launcher.ts";

const [specFile, specHash] = process.argv.slice(2);
if (!specFile || !specHash) {
  process.stderr.write("radian launcher: missing launch spec\n");
  process.exitCode = 2;
} else {
  const prepared = prepareLaunch(specFile, specHash, terminalDevice(process.pid));
  if (!prepared.ok) {
    process.stderr.write(`radian launcher: BLOCKED ${prepared.blocker.code}: ${prepared.blocker.message}\n`);
    process.exitCode = 3;
  } else {
    const result = await launchContained(prepared.value);
    if (!result.ok) {
      process.stderr.write(`radian launcher: BLOCKED ${result.blocker.code}: ${result.blocker.message}\n`);
      process.exitCode = 3;
    } else {
      process.exitCode = result.value.exitCode ?? 1;
    }
  }
}
