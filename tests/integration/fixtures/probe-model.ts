// Test-only Pi extension for native offline probes. It registers pi-ai's
// public faux provider (no network, no credential) and selects its model, so
// a real Pi process runs complete agent turns locally. Every request the model
// would receive is appended to $RADIAN_PROBE_LOG as one JSON line (the replayed
// system prompt and the transcript text), which lets a probe assert exactly
// what context reached the model.
//
// Scripted behavior, keyed on the latest user text:
//   "TOOL <name> <json-args>" → the model calls that tool, then reports the result.
//   anything else             → the model answers "ack".

import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";

type Message = { role: string; content?: unknown; toolName?: string };

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("");
}

// One faux provider per Pi process, created when the module is first evaluated. Pi evaluates the
// module once and reruns the factory for every replacement runtime (project switch, resume); a
// provider created per factory run would leave carried model objects pointing at a replaced
// provider, and Pi would fall back to its "unknown" placeholder model.
const log = process.env.RADIAN_PROBE_LOG;
let calls = 0;
const respond = (context: { messages: Message[] }) => {
  const messages = context.messages;
  const record = {
    call: ++calls,
    systemPrompt: getCurrentSystemPrompt(messages as never),
    transcript: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, text: text(m.content), tool: m.toolName })),
    cwd: process.cwd(),
  };
  if (log) appendFileSync(log, JSON.stringify(record) + "\n");
  const last = messages[messages.length - 1];
  if (last?.role === "toolResult") return fauxAssistantMessage(fauxText(`TOOLRESULT ${text(last.content).slice(0, 2000)}`));
  const userText = last?.role === "user" ? text(last.content) : "";
  const match = /^TOOL (\S+) (.*)$/s.exec(userText);
  if (match) return fauxAssistantMessage(fauxToolCall(match[1]!, JSON.parse(match[2]!) as Record<string, unknown>), { stopReason: "toolUse" });
  return fauxAssistantMessage("ack");
};
const faux = fauxProvider({ provider: "radian-probe", models: [{ id: "probe-1", reasoning: true }] });
// An unbounded script: every request is answered by `respond` above.
const refill = () => faux.setResponses(Array.from({ length: 200 }, () => respond as never));
refill();

/** Pi's setModel returns false while the provider is not usable yet (for example right after a runtime replacement); retry briefly. */
export async function selectModel(pi: { setModel(model: unknown): Promise<boolean> }, model: unknown): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (await pi.setModel(model)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

export default function probeModel(pi: { registerProvider(provider: unknown): void; setModel(model: unknown): Promise<boolean>; on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void }): void {
  pi.registerProvider(faux.provider);
  pi.on("session_start", async () => {
    if (faux.getPendingResponseCount() < 50) refill();
    await selectModel(pi, faux.getModel());
  });
}
