// Runtime adapter registry. All three runtimes are in product scope; each
// worker runs as its runtime's normal interactive session in a Herdr pane.

import type { RuntimeKind } from "../contracts/identity.ts";
import { createClaudeAdapter } from "./claude.ts";
import { createCodexAdapter } from "./codex.ts";
import type { RuntimeAdapter } from "./contract.ts";
import { createPiAdapter } from "./pi.ts";

export function defaultAdapters(overrides: Partial<Record<RuntimeKind, { executable?: string }>> = {}): Record<RuntimeKind, RuntimeAdapter> {
  return {
    pi: createPiAdapter(overrides.pi),
    codex: createCodexAdapter(overrides.codex),
    "claude-code": createClaudeAdapter(overrides["claude-code"]),
  };
}
