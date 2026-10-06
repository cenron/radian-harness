// Worker environment. Workers run as the user's normal interactive runtime
// sessions (no sandbox, no credential copies): they inherit the coordinator's
// environment so each runtime finds its own login and tools, minus variables
// that would switch it to API-key billing, a custom endpoint, or a proxy.

/** Environment variables that would route a runtime to API-key billing or a custom endpoint. */
export const PROHIBITED_RUNTIME_ENV: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
];

/** The host environment with prohibited variables removed, plus adapter overrides. */
export function workerEnv(host: NodeJS.ProcessEnv, overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(host)) {
    if (value === undefined || PROHIBITED_RUNTIME_ENV.includes(key) || PROHIBITED_RUNTIME_ENV.includes(key.toUpperCase())) continue;
    // Radian's own coordinator markers never leak into a worker.
    if (key.startsWith("RADIAN_")) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) if (!PROHIBITED_RUNTIME_ENV.includes(key)) env[key] = value;
  return env;
}
