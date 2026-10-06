# Milestone 07 — Engineering orchestration, integration, and metrics

**Status: pending** · Depends on: 03–06

## Objective

Connect the implemented services into the bounded spec → plan → candidate → review → human-approved integration workflow.

## Deliverables

- Coordinator orchestration for preparation, readiness, reservation, launch/binding, results, verification, fresh review, bounded repairs, blockers, retirement, and reconciliation.
- Developer/tester delivery and exact candidate assembly; contained candidate-check assignments consuming capacity; independent reviewer on the same candidate revision.
- Human approval gates, lightweight brief path, exact controlled integration, and non-destructive cancellation/cleanup.
- Durable questions, quota/infrastructure recovery decisions, stale-generation rejection, and health-aware scheduling.
- Local provenance-rich metrics/events and simple summaries; on-demand human-approved improvement proposals without private artifact export.

## Implementation tasks

1. Make all modifying dispatch depend on Build mode, current approvals, healthy supervision, exclusive checkout ownership, capacity, and required capabilities. Mode changes never grant approval.
2. Implement work-producing delegation through registered dispatch only. No hidden runtime-native agent trees or arbitrary secondary launches.
3. Give tester expectations from approved behavior, reviewer exact candidate/diff/check evidence, and repairs a bounded fresh handoff. Keep raw worker transcripts out of coordinator context by default.
4. Route candidate execution to contained assignments, not unrestricted coordinator shell. Author check/build/install entry points as scoped authority, with owned temporary dependencies/services/resources.
5. Enforce three total candidate rounds. Infrastructure retries inherit round/time limits; ambiguous counting or additional recovery requires recorded human authority.
6. On questions/quota, persist blockers and preserve work. Quota retry requires scoped approval, reliably reported timing, unchanged profile, remaining recovery budget, and healthy supervision; no unattended retry after loss.
7. Integrate only the exact verified/reviewed human-approved candidate and unchanged target. No automatic approval based on worker claims, idle panes, or implementation-run push authorization.
8. Resume by reconciling durable state, repo revisions, workers, ownership, and policy snapshots. Unknown termination blocks replacement.
9. Record actual source version/revision/local modifications/effective config per run; summarize delivery, rounds, blocked/execution time, recovery, cancellation, and quota. Missing usage/cost stays unknown; do not invent subscription dollar spend.
10. Implement on-demand retrospective proposals as private local artifacts requiring approval; no autonomous harness-policy changes or private-data export.
11. Author end-to-end fake-runtime tests for happy path, brief/spec approval, stale/missing approval, candidate drift, repairs/exhaustion, questions/quota, crashes, exact integration, and evidence preservation.

## Completion criteria

- A coherent end-to-end implementation exists with the same service contracts exercised by fake fixtures.
- No coordinator/model-callable path bypasses approval, contained checks, budgets, or safety readiness.
- Unsupported actual runtimes remain blocked; do not use fake success as support attestation.
- Full workflow verification is deferred to 10; publication checks run before push.

## Commit boundary

Mark this milestone/index complete; commit/push `feat: milestone 07 — engineering orchestration and metrics`.

## Completion record

- Completed: not yet
- Implementation decisions: not yet
- Checks before publication: not yet
- Deferred verification / limitations: full workflow verification in milestone 10; live-runtime coverage remains separate

## Requirements

[Direction](../../proposals/0001-direction.md) · [Contracts](../../proposals/0005-task-contract.md) · [Lifecycle/metrics](../../proposals/0006-lifecycle-and-improvement.md) · [Integration](../../proposals/0009-approval-and-integration.md)
