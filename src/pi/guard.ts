import { createToolGuard } from "#core/utils/tool-guard.ts";

const NO_EDITS =
  "The Radian coordinator does not edit project files. Write plans with radian_write_doc and dispatch a developer for code changes.";

/** Pi coordinates; code changes and commands go through workers, so these built-ins are refused. */
export const guardToolCall = createToolGuard({
  bash: "The Radian coordinator does not run shell commands. Use read, ls, grep, find, or radian_git to inspect, and dispatch a worker for anything else.",
  write: NO_EDITS,
  edit: NO_EDITS,
});
