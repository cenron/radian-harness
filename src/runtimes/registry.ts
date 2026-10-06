// Runtime adapter registry. All three runtimes are in product scope; each
// adapter is implemented, and each stays launch-disabled until its required
// capabilities are verified.

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

/** Pane renderer used by the launcher: parse one JSONL record and summarize it. */
export function rendererFor(runtime: RuntimeKind): (line: string) => string | undefined {
  const adapter = defaultAdapters()[runtime];
  return (line) => {
    const lines = adapter.parseEvent(line).map((event) => adapter.render(event)).filter((x): x is string => x !== undefined);
    return lines.length > 0 ? lines.join("\n") : undefined;
  };
}
