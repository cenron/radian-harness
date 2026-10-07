export const STATUS_KINDS = ["working", "question", "blocked", "done", "failed"] as const;
export type StatusKind = (typeof STATUS_KINDS)[number];

export interface StatusEntry {
  kind: StatusKind | "note";
  text: string;
}

// Agents write imperfect lines (bullets, capitals, dashes), so the format is
// matched loosely and anything else is kept as a note rather than rejected.
const STATUS_LINE = /^[-*\s]*(working|question|blocked|done|failed)\s*(?::|-|–|—)\s*(.*)$/i;

export function parseStatusLines(text: string): StatusEntry[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseStatusLine);
}

export function latestStatus(entries: readonly StatusEntry[]): StatusEntry | undefined {
  return entries.findLast((entry) => entry.kind !== "note");
}

function parseStatusLine(line: string): StatusEntry {
  const match = STATUS_LINE.exec(line);
  if (!match) return { kind: "note", text: line };
  return { kind: (match[1] ?? "").toLowerCase() as StatusKind, text: (match[2] ?? "").trim() };
}
