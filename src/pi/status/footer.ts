import { countsTowardLimit, type WorkerRecord, type WorkerState } from "#core/worker.ts";
import type { ProjectStatus } from "#pi/status/project-status.ts";

const STATE_ORDER: readonly WorkerState[] = [
  "starting",
  "working",
  "question",
  "blocked",
  "done",
  "failed",
  "exited",
  "stopped",
];
const STATE_LABELS: Partial<Record<WorkerState, string>> = { question: "asking" };
const SUMMARY_INDENT = "    ";
const SUMMARY_LINES = 2;
const MIN_SUMMARY_ROOM = 12;

export type WidgetColor = "accent" | "warning" | "success" | "error" | "muted";
/** Colors text for the terminal; tests pass a plain or tagging function instead. */
export type Paint = (color: WidgetColor, text: string) => string;

const STATE_STYLE: Record<WorkerState, { icon: string; color: WidgetColor }> = {
  starting: { icon: "◌", color: "accent" },
  working: { icon: "●", color: "accent" },
  question: { icon: "?", color: "warning" },
  blocked: { icon: "!", color: "warning" },
  done: { icon: "✓", color: "success" },
  failed: { icon: "✗", color: "error" },
  exited: { icon: "✗", color: "error" },
  stopped: { icon: "■", color: "muted" },
};

/**
 * The footer: every open worker by state, and how many of the limit's slots are in use. A done
 * worker frees its slot while it waits for a merge, so the two numbers differ on purpose.
 */
export function projectStatusLine(status: ProjectStatus): string {
  const inUse = status.workers.filter(countsTowardLimit).length;
  const slots = `${inUse}/${status.maxWorkers} slots in use`;
  const prefix = `Radian · ${status.project.name} · ${status.mode.toUpperCase()}`;
  if (status.workers.length === 0) return `${prefix} · no workers · ${slots}`;
  const byState = STATE_ORDER.map((state) => ({
    label: STATE_LABELS[state] ?? state,
    count: status.workers.filter((worker) => worker.state === state).length,
  }))
    .filter((group) => group.count > 0)
    .map((group) => `${group.count} ${group.label}`);
  const count = status.workers.length;
  return `${prefix} · ${count} worker${count === 1 ? "" : "s"}: ${byState.join(", ")} · ${slots}`;
}

/**
 * The worker list under Pi, for people: an aligned line per worker with a colored state and its
 * title, and its last status on indented lines below. Paths and model IDs stay in the
 * radian_workers report.
 */
export function workerWidgetLines(
  workers: readonly WorkerRecord[],
  paint: Paint,
  width = Number.POSITIVE_INFINITY,
): string[] {
  const names = workers.map(shortName);
  const labels = workers.map((worker) => STATE_LABELS[worker.state] ?? worker.state);
  const nameWidth = Math.max(0, ...names.map((name) => name.length));
  const labelWidth = Math.max(0, ...labels.map((label) => label.length));
  return workers.flatMap((worker, index) => {
    const style = STATE_STYLE[worker.state];
    const head = `${style.icon} ${(names[index] ?? "").padEnd(nameWidth)}  ${(labels[index] ?? "").padEnd(labelWidth)}`;
    const title = fit(worker.title, width - head.length - 2);
    const summary = wrap(summaryOf(worker), width - SUMMARY_INDENT.length, SUMMARY_LINES);
    return [
      `${paint(style.color, head)}  ${title}`,
      ...summary.map((line) => `${SUMMARY_INDENT}${paint("muted", line)}`),
    ];
  });
}

function shortName(worker: WorkerRecord): string {
  const prefix = `${worker.project}-`;
  return worker.name.startsWith(prefix) ? worker.name.slice(prefix.length) : worker.name;
}

/** The last status without its kind (the state shows it) and with long paths cut to their last two parts. */
function summaryOf(worker: WorkerRecord): string {
  return (worker.lastStatus ?? "")
    .replace(/^(working|question|blocked|done|failed|waiting):\s*/, "")
    .replace(/\/(?:[^\s/]+\/)+([^\s/]+\/[^\s/]+)/g, "…/$1");
}

/** Word-wraps to `room` columns, keeping at most `maxLines` and marking the cut with "…". */
function wrap(text: string, room: number, maxLines: number): string[] {
  if (!text || room < MIN_SUMMARY_ROOM) return [];
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    const joined = current ? `${current} ${word}` : word;
    if (joined.length <= room || !current) {
      current = joined;
      continue;
    }
    lines.push(current);
    current = word;
  }
  lines.push(current);
  const kept = lines.slice(0, maxLines).map((line) => fit(line, room));
  if (lines.length <= maxLines) return kept;
  const last = kept[maxLines - 1] ?? "";
  kept[maxLines - 1] = `${last.length < room ? last : last.slice(0, room - 1)}…`;
  return kept;
}

function fit(text: string, room: number): string {
  return text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`;
}
