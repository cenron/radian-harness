import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "#core/errors.ts";
import { hasOpenPane } from "#core/worker.ts";
import { listWorkers } from "#io/worker-store.ts";
import { pollWorker } from "#workers/poll.ts";
import { workersFileOf } from "#workers/worker-env.ts";
import type { State } from "#pi/state.ts";
import type { StatusView } from "#pi/status/status-view.ts";
import { describeChange } from "#pi/watcher/worker-messages.ts";

/** Polls the selected project's workers and tells Pi about questions, results, and exits. */
export class Watcher {
  private readonly state: State;
  private readonly status: StatusView;
  private timer: NodeJS.Timeout | undefined = undefined;
  private isPolling = false;

  constructor(state: State, status: StatusView) {
    this.state = state;
    this.status = status;
  }

  get isRunning(): boolean {
    return this.timer !== undefined;
  }

  start(ctx: ExtensionContext): void {
    this.stop();
    const pollMs = this.state.workerEnvOf().config.harness.pollSeconds * 1000;
    this.timer = setInterval(() => this.poll(ctx), pollMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One poll at a time; a slow poll makes the next tick skip rather than overlap. */
  private async poll(ctx: ExtensionContext): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      await this.reportChanges(ctx);
    } catch (error) {
      ctx.ui.notify(`Radian could not check its workers: ${errorMessage(error)}`, "warning");
    } finally {
      this.isPolling = false;
    }
  }

  private async reportChanges(ctx: ExtensionContext): Promise<void> {
    const env = this.state.workerEnvOf();
    const messages: string[] = [];
    for (const worker of listWorkers(workersFileOf(env)).filter(hasOpenPane)) {
      const message = describeChange(await pollWorker(env, worker));
      if (message) messages.push(message);
    }
    this.status.refresh(ctx);
    if (messages.length === 0) return;
    this.state.pi.sendMessage(
      {
        customType: "radian-worker",
        content: `Radian worker update:\n${messages.join("\n\n")}`,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }
}
