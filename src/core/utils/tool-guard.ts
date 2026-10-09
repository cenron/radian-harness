export type ToolBlock = { block: true; reason: string };

/** Refuses the listed tools, each with its own reason; every other tool is let through. */
export function createToolGuard(blocked: Record<string, string>) {
  return (toolName: string): ToolBlock | undefined => {
    const reason = blocked[toolName];
    return reason ? { block: true, reason } : undefined;
  };
}
