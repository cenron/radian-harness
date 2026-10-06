# Milestone 04 — Worktrees, candidate delivery, and controlled Git

**Status: complete** · Depends on: 03

## Objective

Implement exclusive owned checkouts and exact-candidate operations without exposing shared Git mutation to workers or executing worker-influenced helpers in the coordinator.

## Deliverables

- Canonical repository/workspace/project discovery and explicit protected-target configuration; do not assume every target branch is `main`.
- Owned worktree allocation/manifest, exclusive mutable ownership, resource identity validation, retained unfinished work, and safe cleanup classification.
- Fixed controlled Git operations with cleared credential/global configuration, hooks/fsmonitor/helpers neutralized, external diff/textconv disabled for patch export, and forbidden worker push/merge/config/ref/worktree operations.
- Worker file/patch delivery, controlled candidate assembly in an integration worktree, content/revision identity, and dirty/target-drift checks.
- Controlled fast-forward integration service requiring exact human approval and verified candidate/check/review identity. No candidate execution in this service.

## Implementation tasks

1. Build argument-vector Git wrappers, not shell-command regex filters. Handle paths/options safely and deliberately audit relevant config/helper/protocol channels.
2. Keep shared hooks/configuration/other refs, worktree Git pointer, and coordinator state outside worker-writable scope. Worktrees are not themselves a sandbox.
3. Refuse existing dirty/conflicting/ambiguous targets and target movement. Never automatically stash, squash, rebase, reset, clean, or cherry-pick into an unverified integrated result.
4. Assemble developer and independent tester changes into one exact candidate. Semantic conflicts become a developer repair assignment; the coordinator does not routinely resolve production semantics.
5. Bind patches/delivery to base and attempt identity; reject stale, out-of-scope, or ambiguous artifacts. Do not execute candidate hooks, check scripts, dependency code, or builds during assembly.
6. Integrate only the approved exact verified commit with rechecked target head and dirty state. Reassembly/reverification and renewed approval are required after material candidate/target changes.
7. Retire execution separately from deleting a worktree. Auto-clean only provably owned, clean, integrated work with preserved evidence; retain cancelled/report-only/dirty/unintegrated artifacts when cleanup authority is uncertain.
8. Write synthetic Git fixtures for planted hooks/helpers, shared metadata tampering, patch/base mismatch, drift/dirty state, concurrent ownership, exact fast-forward, and preservation/cleanup refusal.

## Completion criteria

- Controlled operations are narrow and do not accept arbitrary Git/shell strings from workers.
- Integration API cannot bypass approval/evidence/target identity.
- No real target worktrees are created or mutated in this milestone. Tests are authored for final disposable verification.
- Publication checks run now; full behavioral verification is deferred to 10.

## Commit boundary

Mark this milestone/index complete; commit/push `feat: milestone 04 — worktrees and controlled Git`.

## Completion record

- Completed: 2026-10-06. `src/git/`: repository discovery and explicit protected targets (`repository.ts`), owned worktree manager with manifest, exclusive ownership, identity validation, and conservative cleanup (`worktrees.ts`), controlled worktree and patch delivery (`delivery.ts`), exact candidate assembly (`candidate.ts`), approved fast-forward integration (`integration.ts`), fixed worker inspection operations (`inspect.ts`), and strengthened controlled invocation (`exec.ts`); synthetic fixture tests in `tests/unit/git/`.
- Implementation decisions:
  - Every controlled Git call runs with an argument vector, cleared environment, no global/system configuration, `--attr-source=<empty tree>` (verified on a scratch repository to stop filter drivers that otherwise run; it also disables diff/merge drivers and textconv), and `-c` overrides for hooks, fsmonitor, pager, editor, credential helpers, external diff, SSH command/proxy, protocol access, GPG signing, autostash, and auto-maintenance. Repository-local configuration is still read and must be protected from workers by containment (milestone 05).
  - Protected targets are explicit `refs/heads/<branch>` configuration; discovery only suggests candidates.
  - Owned worktrees are detached checkouts created outside the project checkout and Git directory. No worker branches are created; deliveries and candidates are kept reachable under `refs/radian/deliveries/<assignment>/<attempt>` and `refs/radian/candidates/<task>/r<round>-<n>` (create-only).
  - Workers deliver files in their worktree or a patch file. Radian builds the commit from a temporary index with `hash-object --no-filters`, `update-index --index-info`, `write-tree`, and `commit-tree`, so worker-edited `.gitattributes`, hooks, or helpers never execute. Every changed path must be inside the assignment's write roots; renames/unmerged entries, submodules, non-regular files, and symlinks that escape the repository are refused. Delivery is bound to the exact base and attempt identity.
  - Candidates are single-parent commits on the base. Multiple deliveries are combined with `git merge-tree --write-tree --merge-base`; conflicts return `CONFLICT` with paths for a developer repair assignment.
  - Integration requires the exact candidate (tree and parent), passing evidence for every required check on that commit, a completed review of the same commit with no blocking findings, a re-validated human approval for the current target, and the target still at the candidate's base. A checked-out target must be clean (including untracked files) and is updated by two-tree `read-tree -m -u`, followed by a compare-and-swap `update-ref`; an unchecked-out target uses compare-and-swap only. Nothing is stashed, rebased, squashed, reset, or cherry-picked.
  - Cleanup removes a worktree (without `--force`) only when its execution is retired, ownership validates, it is clean, every delivery is integrated, and evidence is preserved; otherwise it is marked preserved with the reason.
  - Limitation: with attribute helpers disabled, candidate and integration checkouts do not apply project filter drivers (for example large-file smudge filters).
- Checks before publication: private denylist **not supplied** (private-term coverage absent); bounded publication check and exact staged-diff review before commit. Milestone-local sanity run: `tsc --noEmit` clean; full unit suite passed, including nine Git fixture tests with planted hooks, filter/diff/merge drivers (not the milestone 10 run).
- Deferred verification / limitations: full behavioral verification in milestone 10. No real target worktrees were created or mutated.

## Requirements

[Guardrails](../../proposals/0003-safety-and-publication.md) · [Integration](../../proposals/0009-approval-and-integration.md) · [Feasibility evidence](../../research/feasibility-results.md)
