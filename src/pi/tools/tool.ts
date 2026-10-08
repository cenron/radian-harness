import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

type ToolParams<TParams extends TSchema> = Parameters<ToolDefinition<TParams>["execute"]>[1];

export type ToolContext = Parameters<ToolDefinition["execute"]>[4];

/** Radian tools return plain text; thrown errors become failed tool results for the model. */
export function tool<TParams extends TSchema>(input: {
  name: string;
  description: string;
  parameters: TParams;
  run: (params: ToolParams<TParams>, ctx: ToolContext) => Promise<string>;
}): ToolDefinition<TParams> {
  return {
    name: input.name,
    label: input.name,
    description: input.description,
    promptSnippet: input.description,
    parameters: input.parameters,
    // Pi passes (toolCallId, params, signal, onUpdate, ctx); Radian needs only params and ctx.
    async execute(...args): Promise<AgentToolResult<unknown>> {
      const [, params, , , ctx] = args;
      const text = await input.run(params, ctx);
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}
