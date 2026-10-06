// Fixed read-only Git inspection operations for worker tools (for example the
// reviewer's read/report-only tool set) and the coordinator's radian_git_inspect
// tool. Callers choose an operation and validated operands; they never supply
// Git options or argument strings. Execution goes through controlled Git
// (src/git/exec.ts), which neutralizes hooks, pagers, helpers, and attributes.

import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import { safeRelative } from "../contracts/paths.ts";

export type InspectRequest =
  | { op: "status" }
  | { op: "diff"; from: string; to?: string; paths?: string[] }
  | { op: "log"; max: number; rev?: string }
  | { op: "show"; rev: string; path?: string };

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Operations that would mutate or reach outside the repository are not representable. */
export function inspectArgv(request: InspectRequest): Outcome<string[]> {
  const paths = (list: readonly string[] | undefined): Outcome<string[]> => {
    const out: string[] = [];
    for (const p of list ?? []) {
      if (!safeRelative(p)) return refuse("PATH_OUTSIDE_SCOPE", "inspection paths must be repository-relative");
      out.push(p);
    }
    return success(out);
  };
  switch (request.op) {
    case "status":
      return success(["status", "--porcelain=v2", "--untracked-files=all", "--no-renames", "--ignore-submodules=all"]);
    case "diff": {
      if (!OID.test(request.from) || (request.to !== undefined && !OID.test(request.to))) return refuse("CONFIG_INVALID", "diff endpoints must be exact commit ids");
      const p = paths(request.paths);
      if (!p.ok) return p;
      return success(["diff", "--no-ext-diff", "--no-textconv", "--no-color", request.from, ...(request.to ? [request.to] : []), "--", ...p.value]);
    }
    case "log": {
      if (!Number.isInteger(request.max) || request.max < 1 || request.max > 200) return refuse("CONFIG_INVALID", "log limit must be 1–200");
      if (request.rev !== undefined && !OID.test(request.rev)) return refuse("CONFIG_INVALID", "log revision must be an exact commit id");
      return success(["log", "--no-color", "--no-show-signature", `--max-count=${request.max}`, "--format=%H %s", ...(request.rev ? [request.rev] : []), "--"]);
    }
    case "show": {
      if (!OID.test(request.rev)) return refuse("CONFIG_INVALID", "show revision must be an exact commit id");
      if (request.path !== undefined) {
        if (!safeRelative(request.path)) return refuse("PATH_OUTSIDE_SCOPE", "show path must be repository-relative");
        return success(["show", "--no-ext-diff", "--no-textconv", "--no-color", `${request.rev}:${request.path}`]);
      }
      return success(["show", "--no-ext-diff", "--no-textconv", "--no-color", "--stat", request.rev, "--"]);
    }
  }
}

/** Git subcommands no worker role may run, documented for adapters and denial diagnostics. */
export const WORKER_FORBIDDEN_GIT = ["push", "merge", "rebase", "reset", "commit", "config", "update-ref", "branch", "tag", "worktree", "checkout", "switch", "stash", "clean", "gc", "remote", "fetch", "pull", "am", "cherry-pick", "revert", "submodule", "hook"] as const;
