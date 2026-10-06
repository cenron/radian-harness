# Historical prompt for the first review-remediation session

This first pass finished at `6d71988`; do not replay this prompt. Current user-authorized work follows the [workspace-first plan and prompt](../workspace-first/README.md), including final F01–F04 revalidation/correction in W06. The original instructions below are preserved as historical scope/evidence.

Open the **harness-source checkout** in **Claude Code**, select **Opus 5.5 / high** through documented native controls, and use its supported claude.ai subscription path. Do not run Opus through Pi, enable paid extra usage, change authentication, or substitute another profile. The installed sandbox project is not the source checkout and is not the test target for this pass.

Paste this prompt:

```text
Implement the seven-finding Radian Harness review-remediation plan in this source repository.

I authorize this focused source remediation, its offline regression/full verification, and remediation commits/pushes to the existing upstream. This is not authorization for live model/auth/provider tests, actual capability enablement, target-workspace operations, new product features, weaker containment, releases, or host-global changes.

First confirm Claude Code / Opus 5.5 / high and the supported subscription path from native session state. If unavailable or the required billing path is unverified, preserve work and stop without fallback, account changes, or effort/authentication changes.

Read completely:
- AGENTS.md
- docs/planning/session-handoff.md
- docs/planning/remediation/README.md
- docs/proposals/0014-unattended-implementation.md
- docs/proposals/0015-anthropic-runtime-policy.md
- docs/research/implementation-verification.md
- docs/development.md
Then follow the plan's linked product requirements. Read installed Pi/runtime documentation and relevant examples completely before changing their integrations.

Check branch, upstream, status, and history. Preserve unrelated or unfinished work. Do not reset, clean, stash, rebase away changes, or force-push. Original milestones 01–10 are historical; do not rerun their implementation sequence or old prompt.

Execute R01–R07 in order, using the complete acceptance criteria in docs/planning/remediation/README.md:
R01: coordinator read-only command helper/output escapes.
R02: planning-write destination/parent/root symlink escapes and write-time races.
R03: mechanically verified exact candidate tree and check provenance.
R04: current approval/artifact validation for initial launch, recovery, resume, quota retry, and asynchronous launch windows.
R05: partial/uncertain launch ownership, delayed-launch revocation, cleanup, and verified termination before releasing resources.
R06: ongoing watcher and coordinator-lease health monitoring with bounded stop of all affected owned execution.
R07: durable candidate-cycle accounting that the model cannot bypass with newCandidateRound.

Write and run a regression exposing each original defect before fixing it, then implement the correction and demonstrate green. Record sanitized red/green evidence, decisions, and residual limitations in the progress index. Tests must cover the production orchestration/tool paths, not merely isolated validators. Do not weaken assertions or claim race resistance/termination/tested-tree identity from inadequate evidence.

Use only offline fake runtimes/transport, synthetic credentials, fake clocks/probes, and disposable fixtures. Bounded owned synthetic processes are permitted for supervision tests; executable candidate fixtures remain contained. Do not read real credentials, mark installed runtime capabilities verified, create/control existing Herdr panes, or install/update/remove target workspace bindings. The user's sandbox UI smoke test is not live runtime verification. Anthropic workers remain restricted to Claude Code; no paid spillover or automatic fallback.

Make ordinary reversible choices without routine questions. Keep the pass limited to these fixes and necessary contracts/tests/docs. Do not implement workspace-only initialization or unrelated features. If an essential safety property cannot be met within scope, preserve work, record a sanitized blocked row and safe next action, and stop without bypassing it or marking incomplete work complete.

Finish R08: rerun the interacting regressions, typecheck, unit tests, offline integration tests, and full offline verification. Record exact tested revision/tree and all passes/failures/skips/not-run checks. Update the verification report, handoff, plan status, and relevant guidance. Preserve historical evidence and keep runtime/release support NOT READY with actual launches disabled.

Review exact staged content/metadata, run publication and whitespace checks before every authorized push, disclose absent private-denylist coverage, and commit the focused remediation plus final verification checkpoint to the existing upstream without force. Verify remote inclusion. If a push fails, retain the local commit and report the blocker; do not rewrite it to conceal failure.

Finish with finding statuses, regression/full verification outcomes, exact tested revision/tree, commit/push results, publication coverage, remaining safety/runtime/release blockers, and preserved unfinished work. Stop after reporting; do not begin live verification or further features.
```
