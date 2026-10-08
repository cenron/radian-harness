import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Pi rebuilds the extension on every session replacement, so the user's model and
// thinking level are carried across the switch in process-wide state.
const CARRY_KEY = Symbol.for("radian.carried-model");
const MODEL_RETRIES = 50;
const MODEL_RETRY_DELAY_MS = 20;

interface CarriedModel {
  model: ExtensionContext["model"];
  thinking: ReturnType<ExtensionAPI["getThinkingLevel"]>;
}

/** Keeps the user's model and thinking level when Pi switches to another session. */
export class ModelCarry {
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  /** Remembers the current model and thinking level just before a switch. */
  save(ctx: ExtensionContext): void {
    store()[CARRY_KEY] = { model: ctx.model, thinking: this.pi.getThinkingLevel() };
  }

  /** Re-applies the model and thinking level the user had before a project switch. */
  async restore(ctx: ExtensionContext): Promise<void> {
    const carried = store()[CARRY_KEY];
    store()[CARRY_KEY] = undefined;

    if (!carried) return;

    this.pi.setThinkingLevel(carried.thinking);
    if (!carried.model || isSameModel(ctx.model, carried.model)) return;
    // The model's provider may not be usable for a moment after the runtime is replaced.
    for (let attempt = 0; attempt < MODEL_RETRIES; attempt += 1) {
      if (await this.pi.setModel(carried.model)) return;
      await new Promise((resolve) => setTimeout(resolve, MODEL_RETRY_DELAY_MS));
    }
    ctx.ui.notify("Radian could not restore your previous model; check /model.", "warning");
  }
}

function store(): Record<symbol, CarriedModel | undefined> {
  return globalThis as Record<symbol, CarriedModel | undefined>;
}

function isSameModel(
  current: ExtensionContext["model"],
  wanted: ExtensionContext["model"],
): boolean {
  return current?.provider === wanted?.provider && current?.id === wanted?.id;
}
