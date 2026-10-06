# W06 — Final safety revalidation and remaining corrections

**Status: pending.** Dependency: W01–W05 implemented. Mandatory before final acceptance/publication checkpoint.

The user explicitly moved the [four independent findings](../../research/remediation-follow-up-review.md) to this end-of-plan phase. Revalidate them against the assembled workspace-first source; do not assume they remain or were fixed incidentally. This is not authorization for live tests or weaker containment.

## Work and acceptance

| Finding | Required production-path regression and correction if still present |
| --- | --- |
| F01 / R02 | Substitute a validated parent immediately before creating a missing child directory. Refusal must leave outside files **and directory namespace** unchanged. Protect mkdir as well as final open, or conservatively refuse unsupported creation. Preserve macOS no-follow enforcement and non-macOS fail-closed behavior. |
| F02 / R03 | Record `unit` with one command, repair/reassemble, then request the same id with a substituted command under unchanged approvals. Refuse it. Preserve revision-bound definitions across assembly, restart, and project-context restore; reset check outcomes/reviews only. Changing definitions requires an approved plan revision; initial definitions also need approval provenance. |
| F03 / R04 | Revoke approvals after final local authorization, during transport delivery, and before delayed launcher start. No new worker/check begins under stale approval. Use revision-bound actual-start authorization/invalidation and accountable uncertain-launch cleanup, not an extra pre-check alone. Recovery/resume/quota retry and project switching must preserve the same guarantee. |
| F04 / R05–R06 | Produce an unknown stop, then lose watcher/lease or shut down with only retained attempts. All potentially alive owned work remains monitored and subject to bounded stop/reconciliation; never orderly-release its watcher or reuse slots/worktrees. Retry stops generation-safely without duplicate finalization. |

1. Inspect current implementations and prior probe steps. Add deterministic regressions exercising real orchestration/session/tool paths over fake transport/workers and disposable repositories. Executable native fixtures remain contained; no real credentials or existing panes.
2. For each still-present failure, run and record red **before** fixing, then correct and immediately demonstrate green. If feature work already eliminated it, retain a passing equivalent regression and document the mechanical correction and revision; do not invent a failing baseline.
3. Re-run original R01–R07 suites and interacting cases when shared contracts change. Preserve shell denial, immutable tested-tree identity, approved command provenance, human revision-bound approvals, partial-launch revocation, continuous safety monitoring, and durable cycle caps.
4. Update the independent-review qualification and remediation index with truthful current status, evidence, residual limitations, and verified tree. Preserve original red/green and review history. No unsupported claim becomes complete because capabilities are disabled.

## Exit gate

All four cases demonstrably safe on the final feature source; original safety regressions still pass. Any unresolved required property blocks W06/W07: preserve work, record a focused blocker, and stop rather than publish a completion claim. No live/runtime/release support is granted. Independent follow-up review remains required before live verification.

## Completion record

Not started. Record each finding's still-present/already-corrected classification, red/green or equivalent evidence, decision, tree, and limitations.
