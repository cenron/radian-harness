// Radian's Pi worker bridge. Runs inside the contained launcher as:
//   <pi's node> pi-bridge.ts <bridge-config.json>
// It uses only Pi's public package-root SDK exports (ModelRuntime,
// createAgentSession, SessionManager, SettingsManager, createExtensionRuntime)
// with an injected read-only CredentialStore: reads succeed, every write —
// including the OAuth refresh path, which runs inside `modify` — is refused, so
// a worker can never refresh or rotate a credential. The bridge verifies that
// the exact model, provider, effort, and tool set took effect (Pi clamps
// thinking levels silently otherwise) and emits compact JSONL events on stdout.
//
// Parity: this is SDK execution, not Pi's interactive TUI. Herdr does not
// detect it as a Pi agent, and interactive slash commands are unavailable.

import { readFileSync } from "node:fs";

interface BridgeConfig {
  schema: "radian.pi-bridge/1";
  piEntry: string;
  provider: string;
  model: string;
  effort: string;
  credentialFile: string;
  agentDir: string;
  cwd: string;
  tools: string[];
  systemPromptFile: string;
  prompt: string;
  sessionId: string;
  catalogFile: string;
}

type Listener = (event: Record<string, unknown>) => void;

interface PiSession {
  model?: { id?: string; provider?: string };
  thinkingLevel: string;
  getActiveToolNames(): string[];
  subscribe(listener: Listener): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

interface PiModule {
  ModelRuntime: { create(options: Record<string, unknown>): Promise<{ getModel(provider: string, model: string): unknown; getProvider(provider: string): unknown }> };
  createAgentSession(options: Record<string, unknown>): Promise<{ session: PiSession }>;
  SessionManager: { inMemory(cwd?: string): unknown };
  SettingsManager: { inMemory(settings?: Record<string, unknown>): unknown };
  createExtensionRuntime(): unknown;
}

function emit(record: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(record) + "\n");
}

function block(code: string, message: string): never {
  emit({ type: "radian_blocker", code, message });
  process.exit(3);
}

const configPath = process.argv[2];
if (!configPath) block("CONFIG_INVALID", "bridge configuration path missing");
let config: BridgeConfig;
try {
  config = JSON.parse(readFileSync(configPath, "utf8")) as BridgeConfig;
} catch {
  block("CONFIG_INVALID", "bridge configuration unreadable");
}
if (config.schema !== "radian.pi-bridge/1") block("CONFIG_INVALID", "bridge configuration schema mismatch");

let credential: Record<string, unknown> | undefined;
try {
  const projected = JSON.parse(readFileSync(config.credentialFile, "utf8")) as Record<string, unknown>;
  const entry = projected[config.provider];
  if (typeof entry === "object" && entry !== null) credential = entry as Record<string, unknown>;
} catch {
  block("CREDENTIAL_UNAVAILABLE", "projected credential unreadable");
}
if (!credential || credential.type !== "oauth") block("BILLING_PATH_UNVERIFIED", "projected credential is not subscription OAuth");

const readOnlyStore = {
  async read(providerId: string) {
    return providerId === config.provider ? { ...credential } : undefined;
  },
  async list() {
    return [{ providerId: config.provider, type: "oauth" }];
  },
  async modify() {
    // Pi runs OAuth refresh inside modify(); refusing here prevents any worker-side refresh.
    throw new Error("radian read-only credential store: credential writes and refresh are not permitted in workers");
  },
  async delete() {
    throw new Error("radian read-only credential store: credential deletion is not permitted in workers");
  },
};

const pi = (await import(config.piEntry)) as PiModule;
const runtime = await pi.ModelRuntime.create({
  credentials: readOnlyStore,
  modelsPath: null,
  allowModelNetwork: false,
  refreshOnCreate: false,
  modelsStorePath: config.catalogFile,
});

const provider = runtime.getProvider(config.provider) as { auth?: { oauth?: { isSubscription?: boolean } } } | undefined;
if (!provider) block("PROVIDER_PROVENANCE_UNKNOWN", "provider is not known to this Pi version");
if (provider.auth?.oauth?.isSubscription !== true) block("BILLING_PATH_UNVERIFIED", "Pi does not mark this provider's OAuth path as subscription-backed");
const model = runtime.getModel(config.provider, config.model);
if (!model) block("PROFILE_UNCONFIGURED", "exact model is not available in Pi's catalog");

const systemPrompt = readFileSync(config.systemPromptFile, "utf8");
const resourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: pi.createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => systemPrompt,
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};

const { session } = await pi.createAgentSession({
  cwd: config.cwd,
  agentDir: config.agentDir,
  model,
  thinkingLevel: config.effort,
  modelRuntime: runtime,
  resourceLoader,
  tools: config.tools,
  sessionManager: pi.SessionManager.inMemory(config.cwd),
  settingsManager: pi.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }),
});

const active = [...session.getActiveToolNames()].sort();
if (session.model?.id !== config.model || session.model?.provider !== config.provider) block("PROVIDER_PROVENANCE_UNKNOWN", "Pi selected a different model than requested");
if (session.thinkingLevel !== config.effort) block("EFFORT_UNSUPPORTED", "Pi clamped the requested thinking level");
if (JSON.stringify(active) !== JSON.stringify([...config.tools].sort())) block("CAPABILITY_MISSING", "Pi's active tool set differs from the role's tool set");

emit({ type: "radian_session", sessionId: config.sessionId, provider: config.provider, model: config.model, thinkingLevel: session.thinkingLevel, tools: active });

session.subscribe((event) => {
  switch (event.type) {
    case "agent_start":
    case "turn_start":
    case "agent_settled":
      emit({ type: event.type });
      break;
    case "agent_end":
      emit({ type: "agent_end", willRetry: event.willRetry });
      break;
    case "message_end": {
      const message = event.message as { role?: string; stopReason?: string; errorMessage?: string; usage?: { input?: number; output?: number } };
      if (message?.role === "assistant") emit({ type: "assistant_end", stopReason: message.stopReason, errorMessage: message.errorMessage, usage: message.usage ? { input: message.usage.input, output: message.usage.output } : undefined });
      break;
    }
    case "tool_execution_start":
      emit({ type: "tool_start", toolName: event.toolName });
      break;
    case "tool_execution_end":
      emit({ type: "tool_end", toolName: event.toolName, isError: event.isError });
      break;
    case "auto_retry_start":
      emit({ type: "auto_retry_start", errorMessage: event.errorMessage });
      break;
    default:
      break;
  }
});

let stopping = false;
const stop = async (code: number) => {
  if (stopping) return;
  stopping = true;
  try {
    await session.abort();
  } finally {
    session.dispose();
    process.exit(code);
  }
};
process.on("SIGTERM", () => void stop(143));
process.on("SIGINT", () => void stop(130));

emit({ type: "radian_prompt_accepted" });
await session.prompt(config.prompt);
session.dispose();
process.exit(0);
