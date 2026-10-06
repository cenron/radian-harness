// Thin entry point for workspace binding operations (see src/workspace/cli.ts).
import { parseCommand, runCommand } from "../src/workspace/cli.ts";

const parsed = parseCommand(process.argv.slice(2));
if ("error" in parsed) {
  process.stderr.write(`radian-workspace: ${parsed.error}\n`);
  process.exitCode = 2;
} else {
  const result = await runCommand(parsed);
  process.stdout.write(result.lines.join("\n") + "\n");
  process.exitCode = result.exitCode;
}
