import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../core/errors.ts";
import { hasOpenPane } from "../core/worker.ts";
import { listWorkers } from "../io/worker-store.ts";
import { pollWorker, type WorkerChange } from "../workers/poll.ts";
import { workersFileOf } from "../workers/worker-env.ts";
import { workerEnvOf, type RadianState } from "./state.ts";
import { refreshStatus } from "./status-view.ts";

const NEXT_STEP: Record<string, string> = {
  question:
    "Answer with radian_send if the conversation already settles it; otherwise ask the user.",
  blocked: "Tell the user what blocks it.",
  failed: "Tell the user why it failed.",
  done: "Summarize the work for the user and offer the merge (radian_merge asks the user to approve).",
};

/** Polls the selected project's workers and tells Pi about questions, results, and exits. */
export function startWatcher(state: RadianState, ctx: ExtensionContext): () => void {
  const pollMs = workerEnvOf(state).config.harness.pollSeconds * 1000;
  let isPolling = false;
  const timer = setInterval(async () => {
    if (isPolling) return;
    isPolling = true;
    try {
      await pollOnce(state, ctx);
    } catch (error) {
      ctx.ui.notify(`Radian could not check its workers: ${errorMessage(error)}`, "warning");
    } finally {
      isPolling = false;
    }
  }, pollMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** The message Pi receives about one worker's change, or undefined when Pi need not react. */
export function describeChange(change: WorkerChange): string | undefined {
  const { worker } = change;
  const label = `${worker.name} (${worker.role}: ${worker.title})`;
  const lines = change.entries
    .filter((entry) => entry.kind in NEXT_STEP)
    .map((entry) => `${label} ${entry.kind}: ${entry.text}\n→ ${NEXT_STEP[entry.kind]}`);
  if (change.hasExited && worker.state === "exited") {
    lines.push(
      `${label}: its pane closed before it reported done. Its worktree and branch are kept.`,
    );
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

async function pollOnce(state: RadianState, ctx: ExtensionContext): Promise<void> {
  const env = workerEnvOf(state);
  const messages: string[] = [];
  for (const worker of listWorkers(workersFileOf(env)).filter(hasOpenPane)) {
    const message = describeChange(await pollWorker(env, worker));
    if (message) messages.push(message);
  }
  refreshStatus(ctx, state);
  if (messages.length === 0) return;
  state.pi.sendMessage(
    {
      customType: "radian-worker",
      content: `Radian worker update:\n${messages.join("\n\n")}`,
      display: true,
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}
