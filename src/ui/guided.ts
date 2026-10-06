// Guided approvals (proposal 0016): the coordinator requests a decision and
// Radian renders the dialog from disk and configuration. Nothing here records
// a decision; the controller records one only after the user chose Approve in
// an interactive dialog. These helpers build the dialog text.

import path from "node:path";
import type { DispatchConfig } from "../config/dispatch.ts";
import { selectProfile } from "../config/dispatch.ts";
import { ROLES } from "../contracts/identity.ts";
import type { RunState, TaskPhase } from "../state/model.ts";

/** Dialog choices. Cancel comes first: Pi's selector starts on the first option, so Enter alone never approves. */
export const CHOICE = {
  cancel: "Cancel",
  view: "View file",
  changes: "Request changes",
  approve: "Approve",
  merge: "Approve and merge",
} as const;

const CLOSED: readonly TaskPhase[] = ["integrated", "cancelled", "failed"];

/** Tasks that can still take approvals. */
export function openTasks(state: RunState | undefined): Array<{ id: string; title: string }> {
  return Object.values(state?.tasks ?? {}).filter((t) => !CLOSED.includes(t.phase)).map((t) => ({ id: t.id, title: t.title }));
}

/** The draft's first Markdown heading, else its file name; one line, bounded. */
export function artifactTitle(content: string, relativePath: string): string {
  const heading = content.split(/\r?\n/).map((l) => /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(l.trim())?.[1]).find((h) => h && h.trim() !== "");
  const title = (heading ?? path.basename(relativePath).replace(/\.[^.]+$/, "")).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return title.length > 120 ? `${title.slice(0, 117)}...` : title || "Untitled task";
}

/** A bounded excerpt of the artifact for the View option. */
export function artifactExcerpt(content: string, maxLines = 60): string {
  const lines = content.split(/\r?\n/);
  const shown = lines.slice(0, maxLines).map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " "));
  return lines.length > maxLines ? `${shown.join("\n")}\n... (${lines.length - maxLines} more lines; open the file to read all of it)` : shown.join("\n");
}

/** The coordinator's free text, labelled so it cannot pass as Radian's own facts. */
export function coordinatorNote(note: unknown): string[] {
  if (typeof note !== "string" || note.trim() === "") return [];
  const text = note.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return [`Coordinator's note (not verified by Radian): ${text.length > 300 ? `${text.slice(0, 297)}...` : text}`];
}

/** Which profile each role would use: the default, and the rule candidates the coordinator may choose with a rationale. */
export function profileLines(config: DispatchConfig): string[] {
  const describe = (name: string): string => {
    const p = config.profiles[name];
    return p ? `${name} (${p.runtime}/${p.model}/${p.effort})` : name;
  };
  const lines = [`Profiles: without a routing rule, every role uses ${describe(config.default)}.`];
  for (const role of ROLES) {
    const candidates = [...new Set(config.rules.filter((r) => r.roles.includes(role)).flatMap((r) => r.use))];
    if (candidates.length) lines.push(`  ${role} rule candidates: ${candidates.map(describe).join(", ")}`);
  }
  // Fail visibly rather than display a profile the policy would refuse.
  const resolved = selectProfile(config, { role: "developer" });
  if (!resolved.ok) lines.push(`  default profile is not usable: ${resolved.blocker.message}`);
  return lines;
}
