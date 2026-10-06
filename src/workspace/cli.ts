// Workspace command surface. Every mutating command previews by default and
// applies only with `--apply <plan-hash>` naming the exact plan the user
// reviewed; lack of interaction never implies authorization.
//
//   install --workspace <dir> [--project <repo>=<refs/heads/branch> ...] (--local <harness> | --source <pinned-spec>) [--apply <hash>]
//   update  --workspace <dir> (--local <harness> | --source <pinned-spec>) [--apply <hash>]
//   remove  --workspace <dir> [--apply <hash>]
//   status  --workspace <dir>
//   recover --workspace <dir>

import type { Outcome } from "../contracts/blockers.ts";
import { type OperationPlan, type Source, applyPlan, planInstall, planRemove, planUpdate, recover, status } from "./installer.ts";
import { type Prerequisites, checkPrerequisites } from "./prerequisites.ts";

export interface ParsedCommand {
  command: "install" | "update" | "remove" | "status" | "recover";
  workspace: string;
  projects: Array<{ path: string; target: string }>;
  source?: Source;
  apply?: string;
}

export function parseCommand(argv: readonly string[]): ParsedCommand | { error: string } {
  const [command, ...rest] = argv;
  if (!command || !["install", "update", "remove", "status", "recover"].includes(command)) return { error: "usage: install|update|remove|status|recover --workspace <dir> …" };
  let workspace: string | undefined;
  const projects: ParsedCommand["projects"] = [];
  let source: Source | undefined;
  let apply: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined) return { error: `${flag} needs a value` };
    i += 1;
    switch (flag) {
      case "--workspace": workspace = value; break;
      case "--project": {
        const eq = value.lastIndexOf("=");
        if (eq <= 0) return { error: "--project needs <path>=<refs/heads/branch> (an explicit protected target)" };
        projects.push({ path: value.slice(0, eq), target: value.slice(eq + 1) });
        break;
      }
      case "--local": source = { kind: "local", path: value }; break;
      case "--source": source = { kind: "pinned", spec: value }; break;
      case "--apply": apply = value; break;
      default: return { error: `unknown argument ${flag}` };
    }
  }
  if (!workspace) return { error: "--workspace is required; Radian never guesses a target" };
  if ((command === "install" || command === "update") && !source) return { error: "--local <harness> or --source <pinned-spec> is required" };
  const out: ParsedCommand = { command: command as ParsedCommand["command"], workspace, projects };
  if (source) out.source = source;
  if (apply) out.apply = apply;
  return out;
}

export function renderPlan(plan: OperationPlan): string[] {
  return [
    `Plan ${plan.operation} for ${plan.workspace}`,
    ...(plan.actions.length === 0 ? ["  (no changes)"] : plan.actions.map((a) => `  - ${a.description} [${a.before.state === "absent" ? "new" : "replace"} → ${a.after.state === "absent" ? "delete" : "write"}]`)),
    ...plan.conflicts.map((c) => `  ! conflict: ${c}`),
    ...plan.notes.map((n) => `  note: ${n}`),
    `Plan hash: ${plan.hash}`,
    `Apply exactly this plan with: --apply ${plan.hash}`,
  ];
}

export interface RunOptions {
  /** Local prerequisite check (Node, Git, Pi); injectable for tests. */
  prerequisites?: () => Outcome<Prerequisites>;
}

export async function runCommand(cmd: ParsedCommand, options: RunOptions = {}): Promise<{ exitCode: number; lines: string[] }> {
  if (cmd.command === "status") {
    const s = status(cmd.workspace);
    return s.ok ? { exitCode: 0, lines: [JSON.stringify(s.value, null, 2)] } : { exitCode: 2, lines: [`BLOCKED ${s.blocker.code}: ${s.blocker.message}`] };
  }
  if (cmd.command === "recover") {
    const r = recover(cmd.workspace);
    if (!r.ok) return { exitCode: 2, lines: [`BLOCKED ${r.blocker.code}: ${r.blocker.message}`] };
    return { exitCode: r.value.conflicts.length ? 1 : 0, lines: [`recovered ${r.value.completed} action(s)`, ...r.value.conflicts.map((c) => `  ! ${c}`)] };
  }
  if (cmd.command === "install" || cmd.command === "update") {
    const prereq = (options.prerequisites ?? checkPrerequisites)();
    if (!prereq.ok) return { exitCode: 2, lines: [`BLOCKED ${prereq.blocker.code}: ${prereq.blocker.message}${prereq.blocker.nextAction ? ` — ${prereq.blocker.nextAction}` : ""}`, "Nothing was written. Radian never installs tools globally."] };
  }
  let planned: Outcome<OperationPlan>;
  if (cmd.command === "install") planned = await planInstall({ workspaceRoot: cmd.workspace, source: cmd.source!, projects: cmd.projects });
  else if (cmd.command === "update") planned = await planUpdate(cmd.workspace, cmd.source!);
  else planned = planRemove(cmd.workspace);
  if (!planned.ok) return { exitCode: 2, lines: [`BLOCKED ${planned.blocker.code}: ${planned.blocker.message}${planned.blocker.nextAction ? ` — ${planned.blocker.nextAction}` : ""}`] };
  const lines = renderPlan(planned.value);
  if (!cmd.apply) return { exitCode: 0, lines: [...lines, "Preview only; nothing was written."] };
  const applied = applyPlan(planned.value, cmd.apply);
  if (!applied.ok) return { exitCode: 2, lines: [...lines, `BLOCKED ${applied.blocker.code}: ${applied.blocker.message}`] };
  return { exitCode: planned.value.conflicts.length ? 1 : 0, lines: [...lines, `Applied ${applied.value.applied} action(s).`] };
}
