# 0006 — Worker lifecycle, recovery, and harness improvement

**Status: planning only. Lifecycle, metrics, and quota-recovery direction confirmed below. No implementation approval.**

## 1. Confirmed lifecycle direction

Assignment lifecycle: prepared, preflight, running, result submitted, result validated, retired; with explicit blocked, interrupted, failed, and cancelled states. Assignment completion does not approve a candidate.

Before launch, persist the brief/authority/profile/identity/round, establish exclusive mutable-resource ownership, check runtime/auth/containment/input/capacity readiness, launch a fresh Herdr worker, and confirm its assignment binding before mutation. Failed readiness blocks rather than authorizing fallback or weaker containment.

Mechanically detect routine activity; notify Pi for decisions, meaningful failures, results, and unhealthy supervision. Questions are durable and remain open until explicitly resolved. Idle panes do not prove completion. Timeouts require controlled interruption and diagnosis.

Persist results before notification. Validate identity, artifacts, revisions, and evidence before accepting them. Preserve the handoff, revoke authority, verify termination, and close the pane. Checkout deletion is separate.

## 2. Confirmed interruption and recovery policy

- Questions pause affected work; safe unrelated in-scope work may continue.
- User pauses preserve work; resumed work starts a fresh attempt/pane.
- Crashes require resource/process/checkout reconciliation and fresh-context recovery.
- Distinguish client disconnect from loss of healthy supervision. Do not launch duplicate workers.
- Unknown worker status blocks replacement writes until termination or containment is established.
- Cancellation revokes authority, terminates owned execution, and preserves evidence and unfinished work.
- Direct worker-pane instructions do not grant authority. Scope/profile/requirement changes must be recorded through Pi before affected work proceeds.

Candidate rounds and execution attempts are distinct. Failed candidate testing/review consumes the round. Pre-work launch/auth failures do not. Infrastructure interruption may create a replacement attempt within the same round after reconciliation.

Allow at most one automatic recovery attempt per assignment; a second infrastructure failure requires a human decision. Recovery uses the same authorized runtime/model/effort and containment in a fresh context. It does not authorize fallback, escalation, or silent policy relaxation.

## 3. Quota recovery

### Confirmed requirement

Handle exhausted provider/runtime quota as a recoverable blocker, preserving work rather than losing the task. Existing ask-first runtime/model fallback and effort-escalation policy remains in force.

### Confirmed quota-recovery policy

- Classify a known quota/rate-limit condition separately from generic crashes, authentication failure, and unknown errors. Record a safe error category and reset/retry time only when reliably supplied; unknown availability stays unknown.
- Persist a quota blocker and checkpoint, then retire the old worker safely. Never replay a request blindly when its effects are uncertain.
- Present options through Pi: wait for quota, explicitly authorize a different profile, or cancel/pause.
- Waiting does not consume a candidate round. An actual relaunch counts toward the assignment's recovery allowance, regardless of whether its trigger was crash or quota exhaustion.
- Default to human approval before resuming after quota exhaustion. A scoped user approval may authorize one supervised retry at a reliably reported reset time with the same profile. This does not authorize indefinite retries or fallback; do not infer authorization from a generic retry budget.
- Retry only after fresh readiness checks, in a fresh attempt/pane, with the preserved candidate and bounded handoff. A passed preflight is not proof of unlimited remaining quota.
- Do not poll providers through model calls or launch repeated probe workers. No automatic purchase, account/key rotation, runtime/model switch, or weakened containment.
- Runtime/profile replacement requires explicit approval, old-authority revocation, verified quiescence, and a new attempt identity. Preserve partial work and revalidate candidate evidence as appropriate.

Transient throttling versus exhausted quota, maximum wait duration, and deferred retry scheduling remain to be specified. Any deferred retry requires healthy supervision and explicit scoped authorization.

## 4. Confirmed metrics direction

Collect lightweight local metrics from durable events:

- Delivery quality: first-round acceptance, rounds used, cap exhaustion, testing/review defects.
- Efficiency: active time, human-blocked time, infrastructure downtime, observable usage/cost.
- Reliability: preflight failures, crashes/recoveries, stale results, cancellation failures, supervision gaps, quota failures by profile, quota-blocked time, and quota recovery outcomes.
- Coordination: clarification requests, scope changes, handoff omissions, repeated findings, human interventions.

Every metric report must identify the harness version actually running, along with the immutable source revision or per-run snapshot identity, configuration revision, and whether the source is locally modified. Record this provenance at run/attempt creation rather than reading the currently installed version when generating a later report; mixed-version reports must preserve per-run attribution.

Support comparisons between harness versions to assess whether a new version improves on the previous one. Compare delivery quality, rework, efficiency, reliability, and coordination outcomes, accounting for task type/risk, runtime/model/effort, configuration, sample size, and measurement coverage. Report regressions and uncertainty, not an unsupported overall claim that a release is better. A mutable version label alone is insufficient reproducibility evidence.

Include role, task type, resolved profile, and evidence provenance. Unknown measurements remain unknown. Speed, finding counts, and small incomparable samples do not justify agent rankings. Attribution of rework causes is reviewed judgment, not certain automated fact.

Keep raw prompts, private code, and logs out of public harness metrics. Retention, aggregation, cost limits, and metric schema remain open.

## 5. Confirmed improvement loop

Durable outcomes → local metrics → on-demand retrospective → evidence-backed proposal → human approval → separate harness-development task → regression checks → adoption between runs.

Proposals describe the problem/evidence, proposed change, expected benefit, regression risk, evaluation, and rollback. No autonomous changes to harness rules. Never automatically weaken guardrails, approvals, round limits, or provider restrictions to improve metrics. Private evidence requires explicit anonymization and review before entering public material.

## Related proposals

- [Roles and round cap](0004-subagent-design.md)
- [Task contract](0005-task-contract.md)
- [Dispatch and ask-first fallback](0002-worker-dispatch.md)
- [Containment and publication safety](0003-safety-and-publication.md)
