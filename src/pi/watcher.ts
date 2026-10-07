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

const CLOSED_NEXT_STEP = "Summarize its report (below) for the user; there is nothing to merge.";
const MAX_REPORT_CHARS = 4000;
const MAX_LISTED_FILES = 10;

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
    .map((entry) => `${label} ${entry.kind}: ${entry.text}\n→ ${nextStep(change, entry.kind)}`);
  if (change.committedFiles.length > 0) {
    lines.push(`${label}: ${committedFilesText(change.committedFiles, worker.branch)}`);
  }
  if (change.isAwaitingUser) {
    lines.push(
      `${label}: its ${worker.runtime} session is asking a startup question in pane ${worker.pane} (for example, whether to trust the folder). Ask the user to answer it there; Radian types in the task afterwards.`,
    );
  }
  if (change.isClosed) {
    lines.push(
      `${label}: pane, worktree, and branch were closed because it had nothing to merge. Report:\n${reportText(change.report)}`,
    );
  }
  if (change.hasExited && worker.state === "exited") {
    lines.push(
      `${label}: its pane closed before it reported done. Its worktree and branch are kept.`,
    );
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

// A worker's tools or editors can leave files behind (a debug server a tool injected, for
// example), and Radian commits everything at done, so Pi checks the list against the task.
function committedFilesText(files: readonly string[], branch: string): string {
  const listed = files.slice(0, MAX_LISTED_FILES).join(", ");
  const more =
    files.length > MAX_LISTED_FILES ? `, and ${files.length - MAX_LISTED_FILES} more` : "";
  const count = `${files.length} file${files.length === 1 ? "" : "s"}`;
  return `Radian committed ${count} on ${branch}: ${listed}${more}. Check that these files fit the task; flag any that do not (leftovers from a tool or an editor, for example) before offering the merge.`;
}

function nextStep(change: WorkerChange, kind: string): string | undefined {
  return kind === "done" && change.isClosed ? CLOSED_NEXT_STEP : NEXT_STEP[kind];
}

function reportText(report: string | undefined): string {
  if (!report?.trim()) return "(no report written)";
  return report.length > MAX_REPORT_CHARS
    ? `${report.slice(0, MAX_REPORT_CHARS)}\n[report truncated]`
    : report;
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
