# 0007 — Coordinator interface and finalization checklist

**Status: planning only. Interface direction and three approval gates with lightweight briefs are confirmed below. Technical implementation and remaining operational decisions are not approved.**

## 1. Requested interface additions

- Provide `/calm` to reduce Pi's visible operational output.
- Provide plan mode and allow toggling plan/build with Shift+Tab; ordinary Tab remains autocomplete. See [review resolution](0012-review-resolution.md) for superseding decisions.

### Confirmed Calm direction

Presentation only: preserve execution, authority, input delivery/order, model context, durable state, logs, and exports. Keep human prompts, substantive responses, approval requests, blockers, failures, and working activity visible. Routine tool output and operational chatter may be hidden where verified presentation surfaces permit; toggling off restores ordinary presentation. Persist the preference without changing personal settings implicitly.

Calm feasibility must be verified against the supported Pi version. Pi 1.0.2 documents `registerToolRenderer`; prefer presentation hooks rather than execution-tool replacement. Full transcript hiding must not be promised without verified API support. Undocumented internals, if needed, require explicit compatibility review. Any third-party code reuse requires license and attribution review.

### Confirmed plan/build direction

- Start in plan mode; display PLAN or BUILD continuously.
- Plan mode allows investigation, questions, approved planning-artifact writes, and registered scout tasks, but no production mutation, modifying-worker dispatch, or integration.
- Build mode permits only already-authorized work and dispatch. Pi remains coordinator, not a production developer.
- Shift+Tab changes interaction mode, not approval status. Missing or stale approvals still block execution; toggling does not auto-launch work.
- Returning to plan prevents new modifying dispatch immediately; ask for confirmation before pausing active modifying workers. Explain ongoing/unresolved operations; a badge must not falsely imply quiescence.
- Tab retains autocomplete. Shift+Tab replaces the thinking-cycle shortcut only in managed sessions; native `/thinking` remains available for coordinator control, with no additional alias.

Installed Pi 1.0.2 docs reviewed: README, extensions.md, tui.md, keybindings.md; plan-mode example README and entry point. Pi has shortcut/custom-editor extension surfaces, but Tab is already autocomplete. The example uses `/plan` and Ctrl+Alt+P, disables built-in edit/write while retaining other tools, and restores full tools for execution. It is inspiration, not suitable approval enforcement or containment for Radian.

## 2. Decisions required before overall plan finalization

1. Workflow gates are confirmed: PRD/spec, plan, and integration/merge approval, with a lightweight approved brief for small fixes. Still specify which edits invalidate which approvals.
2. Main-session topology: project-local versus workspace coordinator; one or multiple active runs/projects.
3. Isolation and operational access: concrete containment per runtime, filesystem/network/credential/process limits, dependency-install and service approvals, protected Git state.
4. Concurrency and budgets: modifying ownership, parallel task limits, time/token/spend caps, infrastructure recovery classification, investigation stopping conditions, quota wait scheduling.
5. Candidate integration: assembling independent tests, exact-candidate checks/review, target drift, conflict routing, dirty-checkout handling, cleanup/evidence retention.
6. Interface implementation: Calm compatibility scope/default and keyboard/editor integration. Shift+Tab toggling and confirmation before pausing active workers are confirmed; direct pane input cannot grant authority.
7. Installation/support contract: pinned releases versus local snapshots, explicit targets and owned configuration, supported runtime/backend versions, update/remove/rollback behavior.
8. Release acceptance: denial/isolation tests, stale identities, restart/quota/cancellation tests, metrics provenance, scanner/staged/history/release review.

Concrete isolation remains a required design decision, not something to defer silently to implementation. Version-specific feasibility research may inform these choices without launching workers or implementing tooling during planning.

## References

- [Direction](0001-direction.md)
- [Safety](0003-safety-and-publication.md)
- [Lifecycle and metrics](0006-lifecycle-and-improvement.md)
