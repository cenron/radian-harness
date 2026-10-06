# 0004 — Sub-agent roles, context, and bounded work

**Status: planning only. Decisions below are confirmed where marked; implementation is not authorized.**

## 1. Confirmed decisions

- Initial worker roles: developer, tester, reviewer, and optional scout.
- Design work, when needed, belongs in PRD development. A separate standing designer/UX worker role is not required initially.
- Pi remains the coordinator, keeps its context as clean as possible, and routes implementation and semantic integration/conflict-resolution work to the appropriate worker rather than routinely editing production code.
- Scouts may investigate and propose plans. Pi consolidates proposals and seeks human approval; workers cannot approve plans or scope changes.
- Each agent starts fresh in a new Herdr pane rather than reusing a prior worker's pane and original conversation context. Old worker panes are closed rather than reused.
- Cap each task at **three total candidate cycles**: initial implementation plus at most two repair cycles, each including independent verification and fresh review.
- Every repair assignment starts in a fresh pane and context. The durable round counter belongs to the task, not the worker session; opening a pane does not reset it.
- If round three fails, stop automatic repair and bring the remaining findings, evidence, and preserved changes to the user. No automatic fourth round or escalation.

These are planning decisions, not approval to implement or create worker panes during planning.

## 2. Role responsibilities

| Role | Responsibility | Proposed write boundary |
| --- | --- | --- |
| Developer | Implement bounded approved changes and associated unit/integration tests | Assigned production/test files in its isolated checkout; own outputs |
| Tester | Derive acceptance checks from approved behavior and independently verify the candidate | Assigned acceptance tests and evidence; no production changes |
| Reviewer | Review the exact candidate for correctness, maintainability, security, and scope | Report only |
| Scout | Investigate uncertainty and propose evidence-backed options or plans | Report and explicitly permitted investigation artifacts |

The roles are available capabilities, not a requirement to launch every role for every task. Which checks and roles are mandatory for each task class remains open.

Design questions can be addressed while developing a PRD. The format, approval process, and assignment of that work remain open; this decision does not authorize a new design tool or runtime.

Keep role, task contract, execution profile, and attempt identity distinct. Effective authority is the intersection of role limits, approved task scope, project policy, and enforced runtime capabilities. A stronger model does not grant broader authority.

## 3. Fresh-context execution

### Confirmed direction

Use fresh worker contexts and new Herdr panes, not accumulating conversations reused across assignments. Keep detailed investigation, implementation, testing, and review work out of Pi's main conversation; Pi receives bounded summaries and evidence references.

### Confirmed assignment behavior

Each new assignment, including every repair assignment, starts a fresh worker conversation in a new pane.

### Recommended handoff and recovery details — not yet finalized
- Repair handoffs include the approved brief, exact candidate/base identity, relevant findings, remaining budget, and durable artifact references—not a wholesale previous transcript.
- Fresh context does not require discarding useful code, tests, or evidence. Reusing preserved artifacts or a checkout is a separate ownership and containment decision.
- Before closing an old pane, verify worker termination or quiescence, revoke its mutation authority, and preserve deliverables and evidence. Closing a pane is not permission to delete its checkout.
- A crash/restart must not silently restore the old conversation contrary to the fresh-context policy. Whether recovery always starts a new attempt and how it consumes the round budget remain open.
- New panes do not reset task/run limits or permit runtime/model fallback or effort escalation.

## 4. Three-round cap

### Confirmed counting and exhaustion policy

Bound each task with a maximum of three total rounds. A round is one candidate cycle: implementation or repair, independent verification, and fresh review. The initial implementation is round one; at most two repair cycles follow. This is not an automatic fallback, escalation, or containment exception policy.

- Track the count durably against the task, not the pane or conversation.
- A failed candidate consumes its round. Starting a fresh worker does not reset the count.
- Stop early on acceptable evidence, a blocker, cancellation, or another applicable limit.
- After round three fails, stop automatic repair and present the remaining findings and preserved work to the user. Pi cannot grant itself more rounds.
- Further work requires an explicit human decision, recorded with its scope and revised budget; it must not be hidden by renaming the same task.

Still open: whether verification infrastructure failures consume a round; whether independent review disagreements need a separate bounded resolution path; per-attempt time/token/spend limits; and bounded investigation/planning tasks that do not produce code candidates. Task decomposition must not be used to evade the agreed repair cap.

## 5. Next decisions

1. Define infrastructure-failure counting and limits for non-candidate investigation/planning tasks.
2. Define fresh-context behavior for interruption and crash recovery.
3. Define lifecycle and task/result contracts, including independence and exact-candidate verification.
4. Settle registered child-task requests, direct human pane intervention, and operational limits.
5. Select and test concrete containment for each runtime before claiming enforcement support.

## Related proposals

- [Overall direction](0001-direction.md)
- [Runtime-neutral dispatch and adapters](0002-worker-dispatch.md)
- [Guardrails and publication safety](0003-safety-and-publication.md)
