# Milestone 03 — Durable state, approvals, reservations, and budgets

**Status: complete** · Depends on: 02

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

- Completed: 2026-10-06. Durable state services in `src/state/`: fsync'd atomic files and a verified-owner cross-process mutex (`fsutil.ts`), per-project coordinator lease (`lease.ts`), hash-chained append-only run events with a pure reducer and reconstructable snapshots (`model.ts`, `run-store.ts`), human-only approvals (`approvals.ts`), workspace-wide capacity reservations (`capacity.ts`), project-binding checks (`binding.ts`), the result inbox (`inbox.ts`), and interrupted-state reconciliation (`reconcile.ts`); clock and process-identity utilities in `src/util/`; tests in `tests/unit/state/`.
- Implementation decisions:
  - Run = one coordinator engineering run in a project; task = one approved unit of work with its round counter; assignment = one role-specific unit of work within a candidate round, owning its execution budget and recovery counters; attempt = one execution (generation) of an assignment. Counters live in durable task/assignment state, never in panes.
  - Storage is local JSON files: `events.jsonl` (hash chain, sequence numbers, lease generation, actor, idempotency keys) plus `snapshot.json`. Loading replays and verifies the chain; a torn final line is quarantined to a `torn-tail-*.json` evidence file; any other corruption returns `STATE_CORRUPT` and nothing is guessed. No database dependency.
  - Every write runs under a run lock and re-reads durable state; it requires the project's coordinator lease to be current and unexpired. A lease held by a live or unverifiable process is never taken over; a verifiably dead owner (absent PID, or PID reused with a different start time) is reclaimed with a higher generation, after which the old holder's writes fail with `LEASE_LOST`.
  - Approvals, decision resolutions, extra-round grants, extra recoveries, and paused-run configuration migration require a `HumanChannel` created only from user command/UI input; forged instances are rejected. Approvals bind artifact hashes; integration approvals also bind exact candidate commit/tree/base and target ref/commit. Changed artifacts invalidate approvals. Developer/tester assignments require a valid spec or human-chosen lightweight brief, plus a valid plan.
  - Rounds: a new candidate round is started explicitly; at most three (or the task cap) unless a recorded human grant adds more. Tester/reviewer/repair-check work inside a round does not start another. Infrastructure failures do not add rounds; ambiguous classification opens an accounting decision.
  - Execution time starts at confirmed binding (queue/preflight excluded), stops while blocked on questions/quota/pauses (blocked time recorded per reason), and is inherited by recovery attempts. Exhausted budgets block; nothing extends silently.
  - Replacement attempts require the previous attempt's verified termination, remaining budget, and either the single automatic recovery or a recorded, unused human authorization. Replayed bindings are always rechecked against the current generation.
  - Capacity is a workspace-level ledger reserved before launch under a cross-process lock; blocked or idle live workers keep slots; reservations are released or reclaimed only on verified termination. The ceiling comes from the caller's workspace-resolved configuration.
  - Results are read from the worker's exchange directory without following links, validated through the store (identity, generation, brief hash, strict envelope), deduplicated by content hash, and persisted in protected run state before any notification.
- Checks before publication: private denylist **not supplied** (private-term coverage absent); bounded publication check and exact staged-diff review before commit. Milestone-local sanity run: `tsc --noEmit` clean; 53 unit tests passed, including six-process capacity contention (not the milestone 10 run).
- Deferred verification / limitations: full behavioral verification in milestone 10. Process identity uses sampled `ps` start times, not an atomic process handle. Budget accounting uses wall-clock timestamps so it survives restarts; large clock changes affect it.

## Requirements

[Lifecycle](../../proposals/0006-lifecycle-and-improvement.md) · [Approvals](../../proposals/0009-approval-and-integration.md) · [Review resolution](../../proposals/0012-review-resolution.md)
