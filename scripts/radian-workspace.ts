// Thin entry point for workspace binding operations (see src/workspace/main.ts).
import { main } from "../src/workspace/main.ts";

process.exitCode = await main(process.argv.slice(2));
