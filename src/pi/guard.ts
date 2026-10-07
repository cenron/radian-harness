/** Pi coordinates; code changes and commands go through workers, so these built-ins are refused. */
const BLOCKED_TOOLS: Record<string, string> = {
  bash: "The Radian coordinator does not run shell commands. Use read, ls, grep, find, or radian_git to inspect, and dispatch a worker for anything else.",
  write:
    "The Radian coordinator does not edit project files. Write plans with radian_write_doc and dispatch a developer for code changes.",
  edit: "The Radian coordinator does not edit project files. Write plans with radian_write_doc and dispatch a developer for code changes.",
};

export function guardToolCall(toolName: string): { block: true; reason: string } | undefined {
  const reason = BLOCKED_TOOLS[toolName];
  return reason ? { block: true, reason } : undefined;
}
