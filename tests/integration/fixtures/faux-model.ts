// Test-only Pi extension: registers pi-ai's offline faux provider and logs every request
// to $RADIAN_TEST_LOG, so tests can assert what reached the model.
//
// Script, keyed on the latest user text:
//   "TOOL <name> <json-args>" → the model calls that tool, then echoes the result.
//   anything else             → the model answers "ack".
import { appendFileSync } from "node:fs";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai";

interface Message {
  role: string;
  content?: unknown;
}

const RESPONSE_BATCH = 200;
const MODEL_RETRIES = 100;

// One provider per Pi process, created when the module is first evaluated. Pi reruns the
// factory for each replacement session; a provider per run would strand the selected model.
const faux = fauxProvider({ provider: "radian-test", models: [{ id: "faux-1", reasoning: true }] });
const refill = () =>
  faux.setResponses(Array.from({ length: RESPONSE_BATCH }, () => respond as never));
refill();

function respond(context: { messages: Message[] }) {
  const messages = context.messages;
  const log = process.env.RADIAN_TEST_LOG;
  if (log) {
    const transcript = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({ role: message.role, text: textOf(message.content) }));
    const record = {
      systemPrompt: getCurrentSystemPrompt(messages as never),
      tools: getCurrentTools(messages as never).map((tool) => tool.name),
      transcript,
    };
    appendFileSync(log, `${JSON.stringify(record)}\n`);
  }
  const last = messages.at(-1);
  if (last?.role === "toolResult")
    return fauxAssistantMessage(fauxText(`TOOLRESULT ${textOf(last.content)}`));
  const match = last?.role === "user" ? /^TOOL (\S+) (.*)$/s.exec(textOf(last.content)) : null;
  if (match)
    return fauxAssistantMessage(fauxToolCall(match[1] ?? "", JSON.parse(match[2] ?? "{}")), {
      stopReason: "toolUse",
    });
  return fauxAssistantMessage("ack");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

export default function fauxModel(pi: {
  registerProvider(provider: unknown): void;
  setModel(model: unknown): Promise<boolean>;
  on(event: "session_start", handler: () => Promise<void>): void;
}): void {
  pi.registerProvider(faux.provider);
  pi.on("session_start", async () => {
    if (faux.getPendingResponseCount() < RESPONSE_BATCH / 4) refill();
    // The provider may not be usable for a moment after Pi replaces the session.
    for (let attempt = 0; attempt < MODEL_RETRIES; attempt += 1) {
      if (await pi.setModel(faux.getModel())) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
}
