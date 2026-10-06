# Milestone 03 — Durable state, approvals, reservations, and budgets

**Status: pending** · Depends on: 02

## Objective

Implement deterministic authority/lifecycle bookkeeping independent of chat memory and worker claims.

## Deliverables

- Durable local run/task/assignment/attempt state, append-only events, reconstructable snapshots, atomic writes, version/config provenance, and migrations that do not silently adopt changed policy.
- Serialized transition services with run/project coordinator lease, generation identities, idempotency/deduplication, and stale-callback rejection.
- Human-only spec/brief, plan, and exact-candidate integration approval records bound to artifact hashes/revisions and actors.
- Workspace-wide cross-process capacity reservations; default three, configurable, multiple workers per role, live blocked workers retaining slots.
- Assignment execution-budget and recovery/round counters with explicit blocked-time states.
- Durable unresolved decisions, result inbox validation/acknowledgement, and safe interrupted-state reconciliation.

## Implementation tasks

1. Define run versus task versus assignment versus attempt clearly. Round/recovery counters belong to durable task/assignment state, not panes.
2. Use explicit user-initiated control APIs as the only approval writers. Worker-facing/model-callable tools cannot mint approval records; reports are data only.
3. Invalidate affected approval when its bound artifact changes. A lightweight brief is human-selected/approved, not an automatic assistant shortcut.
4. Enforce one active run/coordinator per project and detect duplicate project binding across workspaces. Reserve capacity before launch; reclaim only after verified ownership/liveness reconciliation.
5. Start execution time at confirmed assignment binding; exclude queue/preflight and recorded question/quota blocking. Recovery inherits remaining time. Insufficient budget blocks, never silently extends.
6. Count three total candidate cycles; classify infrastructure evidence failures separately without allowing a hidden fourth candidate. Ambiguous classification records a blocker.
7. Allow one automatic infrastructure recovery; additional attempts require explicit recorded human authority. Quota waits/retries require scoped approval and healthy supervision; no background autonomous retry.
8. Preserve source/config snapshots for paused runs. Reject stale results and revoke prior generations before replacement.
9. Author concurrency, crash/write interruption, replay, duplicate result, approval invalidation, timing, counter exhaustion, paused-config, and lease-reclaim tests with fake clocks/process identities.

## Completion criteria

- Durable state, approvals, and counters have one authoritative owner, not conflicting copies in UI/worker metadata.
- Worker input cannot promote state or approve artifacts without validated transitions.
- Unknown liveness and ownership fail closed; no silent capacity reclaim or duplicate writer.
- Tests are implemented but full execution is deferred to 10. Run publication checks now.

## Commit boundary

Mark this milestone/index complete; commit/push `feat: milestone 03 — durable state and authority`.

## Completion record

- Completed: not yet
- Implementation decisions: not yet
- Checks before publication: not yet
- Deferred verification / limitations: full behavioral verification in milestone 10

## Requirements

[Lifecycle](../../proposals/0006-lifecycle-and-improvement.md) · [Approvals](../../proposals/0009-approval-and-integration.md) · [Review resolution](../../proposals/0012-review-resolution.md)
