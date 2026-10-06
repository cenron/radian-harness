# Milestone 04 — Worktrees, candidate delivery, and controlled Git

**Status: pending** · Depends on: 03

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

- Completed: not yet
- Implementation decisions: not yet
- Checks before publication: not yet
- Deferred verification / limitations: full behavioral verification in milestone 10

## Requirements

[Guardrails](../../proposals/0003-safety-and-publication.md) · [Integration](../../proposals/0009-approval-and-integration.md) · [Feasibility evidence](../../research/feasibility-results.md)
