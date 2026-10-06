// Synthetic assignment layout used by containment and supervision tests.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveAuthority, type ResolvedAuthority } from "../../../src/contracts/authority.ts";
import { tempDir } from "./fixture.ts";

export interface Layout {
  root: string;
  project: string;
  gitDir: string;
  worktree: string;
  output: string;
  scratch: string;
  state: string;
  secret: string;
  outside: string;
}

export function layout(): Layout {
  const root = tempDir();
  const l: Layout = {
    root,
    project: path.join(root, "project"),
    gitDir: path.join(root, "project", ".git"),
    worktree: path.join(root, "worktrees", "a1"),
    output: path.join(root, "exchange", "a1"),
    scratch: path.join(root, "scratch", "a1"),
    state: path.join(root, "state"),
    secret: path.join(root, "personal-credentials"),
    outside: path.join(root, "outside"),
  };
  for (const dir of [l.gitDir, path.join(l.worktree, "src"), l.output, l.scratch, l.state, l.secret, l.outside]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(l.gitDir, "config"), "[core]\n");
  writeFileSync(path.join(l.secret, "token.json"), '{"synthetic": true}\n');
  writeFileSync(path.join(l.worktree, "src", "input.txt"), "task input\n");
  writeFileSync(path.join(l.worktree, ".git"), `gitdir: ${l.gitDir}/worktrees/a1\n`);
  return l;
}

export function authorityFor(l: Layout): ResolvedAuthority {
  const a = resolveAuthority(
    {
      role: "developer",
      worktree: l.worktree,
      readRoots: [l.project],
      writeRoots: [path.join(l.worktree, "src")],
      outputDir: l.output,
      scratchDir: l.scratch,
      operations: ["read", "edit", "shell", "run-checks", "deliver-changes", "write-report", "network-outbound"],
    },
    { projectRoot: l.project, protectedPaths: [l.gitDir, l.state] },
  );
  if (!a.ok) throw new Error(a.blocker.message);
  return a.value;
}
