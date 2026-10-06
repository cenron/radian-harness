// Ambient declarations for host packages used only by test-only probe
// extensions. Pi 1.0.2's own declarations are authoritative.

declare module "@earendil-works/pi-coding-agent" {
  export function createReadToolDefinition(cwd: string, options?: unknown): { execute(...args: unknown[]): Promise<unknown>; [key: string]: unknown };
}

declare module "@earendil-works/pi-ai" {
  export function fauxProvider(options?: { provider?: string; models?: Array<{ id: string; reasoning?: boolean }> }): {
    provider: unknown;
    getModel(): unknown;
    setResponses(responses: unknown[]): void;
    getPendingResponseCount(): number;
  };
  export function fauxAssistantMessage(content: unknown, options?: { stopReason?: string }): unknown;
  export function fauxText(text: string): unknown;
  export function fauxToolCall(name: string, args: Record<string, unknown>): unknown;
  export function getCurrentSystemPrompt(messages: unknown): string;
}
