# Milestone 07 — Engineering orchestration, integration, and metrics

**Status: complete** · Depends on: 03–06

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

- Completed: 2026-10-06. `src/coordinator/`: orchestration (`orchestrator.ts`), worker-driver abstraction with the production runtime driver (`driver.ts`), Plan/Build mode state and guards (`mode.ts`), harness provenance (`provenance.ts`), local metrics and per-version summaries (`metrics.ts`), and on-demand retrospectives (`retrospective.ts`). Service extensions: per-attempt brief hashes and question/pause resumes in the run store, repair candidates squashed onto the unchanged target, and write-protected versus private paths in authority resolution. End-to-end fake-runtime tests in `tests/unit/coordinator/`.
- Implementation decisions:
  - Every assignment is prepared (mode, supervision health, profile selection, approvals, owned worktree, resolved authority, sealed brief, durable record) and then run as attempts. Each attempt reserves workspace capacity before launch, claims exclusive worktree ownership, reseals the brief for its exact attempt/generation and records that hash, launches through the driver (which performs runtime preflight and capability checks), requires semantic binding, waits within the remaining execution budget, stops with verified termination, and only then collects the validated result and delivers changes. Reservations and worktree ownership are released only after verified termination.
  - Modifying dispatch, candidate checks, and integration require Build mode; read-only scouts may run in Plan. Mode changes never approve or start work.
  - Developer and tester deliveries are combined into one candidate per round. Candidate checks run as contained tester assignments on the exact candidate (whole-worktree write scope, no delivery); only check evidence bound to the exact candidate counts. A fresh reviewer assignment reviews the same candidate read-only. A new candidate makes earlier evidence historical.
  - Repairs deliver against the previous candidate; the new candidate is a single commit on the unchanged target base, so integration stays a fast-forward. Three total candidate rounds; a fourth is refused with `ROUNDS_EXHAUSTED`, the task is blocked, and only a recorded human grant adds rounds.
  - Worker questions block the assignment with a durable decision; after a human resolves it, the work resumes in a fresh attempt without consuming the infrastructure-recovery allowance. Quota exhaustion stops the attempt, preserves work, and opens a quota decision; a retry requires an explicit human authorization, a reached reported reset time, healthy supervision, and the unchanged profile, and consumes the assignment's recovery allowance. One automatic fresh recovery follows a verified infrastructure failure; further failures open a human decision. Stale or spoofed results are never accepted.
  - Integration is triggered only by a genuine human channel in Build mode and requires a current integration approval bound to the exact candidate and target, passing evidence for every required check, a completed review of the same candidate without blocking findings, and an unmoved, clean target.
  - Resume reconciliation closes attempts from supervision evidence, reclaims only reservations whose attempts all ended with verified termination, validates owned worktrees, records supervision gaps, and never relaunches.
  - Metrics record identifiers, categories, counts, durations, and the run's recorded harness version/revision/local-modification state plus config hash; prompts, code, logs, and credentials are excluded. Unknown usage is counted as unknown, not zero; no dollar spend is invented. Summaries group by harness version and leave comparisons to human judgment.
  - Retrospectives are private local artifacts built from metrics; proposals that weaken approvals, containment, round limits, provider restrictions, or publication safety are refused; a human decision only schedules a separate harness task; nothing is applied or exported automatically.
- Checks before publication: private denylist **not supplied** (private-term coverage absent); bounded publication check and exact staged-diff review before commit. Milestone-local sanity run: `tsc --noEmit` clean; full unit suite passed, including ten fake-runtime workflow tests (happy path through integration, Plan/stale-approval guards, three-round exhaustion, questions, quota retry, crash recovery, unknown termination, drift, stale results, retrospectives, resume reconciliation) (not the milestone 10 run).
- Deferred verification / limitations: full workflow verification in milestone 10; live-runtime coverage remains separate. The production driver path inherits every runtime capability gap from milestone 06, so real workers stay blocked. Fake-driver success is not support evidence.

## Requirements

[Direction](../../proposals/0001-direction.md) · [Contracts](../../proposals/0005-task-contract.md) · [Lifecycle/metrics](../../proposals/0006-lifecycle-and-improvement.md) · [Integration](../../proposals/0009-approval-and-integration.md)
