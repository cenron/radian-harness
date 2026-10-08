import { canEditCode } from "#core/roles.ts";
import { FILE_LIST_LIMIT, listSome } from "#core/text.ts";
import type { WorkerChange } from "#workers/poll.ts";

const NEXT_STEP: Record<string, string> = {
  question:
    "Answer with radian_send if the conversation already settles it; otherwise ask the user.",
  blocked: "Tell the user what blocks it.",
  failed: "Tell the user why it failed.",
  done: "Summarize the work for the user and offer the merge (radian_merge asks the user to approve).",
};

const CLOSED_READER_NEXT_STEP =
  "Summarize its report (below) for the user; there is nothing to merge.";
const CLOSED_NEXT_STEP = "Tell the user what it reported; there is nothing to merge.";
const MAX_REPORT_CHARS = 4000;

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
    // Scouts and reviewers put their findings in a report; developers and testers do not.
    const report = canEditCode(worker.role) ? "" : ` Report:\n${reportText(change.report)}`;
    lines.push(
      `${label}: pane, worktree, and branch were closed because it had nothing to merge.${report}`,
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
  const count = `${files.length} file${files.length === 1 ? "" : "s"}`;
  return `Radian committed ${count} on ${branch}: ${listSome(files, FILE_LIST_LIMIT)}. Check that these files fit the task; flag any that do not (leftovers from a tool or an editor, for example) before offering the merge.`;
}

function nextStep(change: WorkerChange, kind: string): string | undefined {
  if (kind !== "done" || !change.isClosed) return NEXT_STEP[kind];
  return canEditCode(change.worker.role) ? CLOSED_NEXT_STEP : CLOSED_READER_NEXT_STEP;
}

function reportText(report: string | undefined): string {
  if (!report?.trim()) return "(no report written)";
  return report.length > MAX_REPORT_CHARS
    ? `${report.slice(0, MAX_REPORT_CHARS)}\n[report truncated]`
    : report;
}
