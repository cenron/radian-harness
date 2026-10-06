# Session handoff — authorized unattended implementation

## Current authorization

The user has **stopped feasibility testing** and authorized a new **Claude Code / Opus 5.5/high** session to implement the harness without routine interaction. Start with the [implementation table of contents](implementation/README.md), then follow its ten milestone files in order. Mark each milestone complete as it finishes, commit and push each milestone, and run full verification at the end. Publication safety checks still precede every push.

[Proposal 0014](../proposals/0014-unattended-implementation.md) is the latest authorization checkpoint. It authorizes this implementation plan/preserved feasibility checkpoint commit and push, followed by implementation milestone commits/pushes to the existing upstream. It does not authorize target-workspace installation, release/package publication, safety bypasses, or model/auth fallback. Genuine safety/authorization blockers are recorded and stop the unattended run rather than causing interactive prompts or weakened containment.

[Proposal 0015](../proposals/0015-anthropic-runtime-policy.md) amends the runtime/auth policy before implementation: Anthropic workers use Claude Code only, never Pi or another adapter. Subscription OAuth alone does not prove plan-limit billing; reject prohibited/unknown profiles before credential exposure or launch, without silent rerouting or paid spillover. The Opus implementation session must therefore run in Claude Code, not Pi. This does not change Pi's product coordinator role.

The user declined an effort-command alias: use Pi's native `/thinking`. Authentication is subscription-backed OAuth only, not API-key/pay-as-you-go billing. No silent authentication-method fallback; stop direct provider endpoint probes and use runtime subscription paths for further validation. Shift+Tab toggles plan/build in managed sessions; Tab stays autocomplete.

Proposal 0012 remains the product decision checkpoint; proposal 0014 supersedes its feasibility-only implementation authorization. Historical feasibility summary follows, not instructions to resume testing. The planning baseline was committed and pushed as `8a5aa5f`. Feasibility has started with disposable filesystem probes: 11 initial checks passed, followed by 32 scoped-read/Git assertions plus controlled patch application/commit. The repeatable test is `tests/feasibility/macos-filesystem.sh`; see [results](../research/feasibility-results.md). Offline runtime startup/missing-auth tests now pass 10 probes; local-network tests pass five allow/deny/control checks. The tested native address filter rejects hostnames; the user explicitly approved ordinary outbound networking rather than destination isolation. All three runtimes passed opt-in local subscription readiness checks. Manual isolated Herdr startup was exercised. An independent synthetic watcher now passes identity-refusal, coordinator-crash, and heartbeat-stall probes, cleaning a registered detached child with escalation while preserving unfinished work. Actual model-task execution, token refresh/concurrency, full native-sandbox composition, actual-runtime supervision-loss recovery, and watcher-loss recovery remain unverified. The first opt-in Pi task attempt (`openai/gpt-6.1-sol`, medium) passed seven containment controls and local readiness but was blocked before assistant/tool events: CLI credential reads require the same auth-lock access denied to prevent refresh. Herdr's disposable socket-path-length issue was corrected without changing the boundary; no Pi detection or completed model task was observed. Two offline synthetic probes confirmed the public Pi SDK injectable read-only credential-store contract. No harness or installer has been implemented, and full native worker containment/runtime support remains unverified.

## Resume here after session reset

1. Read AGENTS.md, this handoff, proposals 0012–0015, the implementation index/milestone files, and feasibility results. Follow linked product requirements; do not treat historical planning-only headings as current authority.
2. Confirm Claude Code / Opus 5.5/high and its supported subscription path; do not use Pi's Anthropic extra-usage path; check Git branch/upstream/status/history. Preserve unrelated work; do not reset/clean/stash or force-push.
3. Execute milestones 01–10 without routine questions. Each file/index status must reflect pending/in-progress/complete/blocked truthfully. Commit/push each completed milestone after publication checks and verify upstream inclusion.
4. Do not restart feasibility or live provider/auth/model probes. Write tests with each implementation milestone; full automated verification is milestone 10. Actual runtime capabilities remain disabled when required evidence is missing.
5. Handle the Pi CLI auth-lock blocker deliberately. The public SDK injected credential-store contract is available, but SDK/CLI/interactive Herdr parity is unverified. No auth-lock relaxation disguised as refresh prevention.
6. Resolve explicit credential refresh ownership and independent supervision in code. Worker projection copies and killpg alone are insufficient; unknown ownership/termination blocks replacement.
7. Record ordinary implementation choices without asking. On material safety/authorization blockers, preserve work and stop with a sanitized blocker record. See the implementation execution contract for commit/push and final verification rules.

## Saved repository checkpoint

- Initial approved baseline `8a5aa5f` is committed and pushed; `main` tracks `origin/main`.
- The implementation-plan checkpoint includes the preserved later feasibility work: AGENTS.md/handoff updates, proposals 0008/0012/0013, `.gitignore`, feasibility-results.md, all files under `tests/feasibility/`, proposal 0014, and the implementation milestone files. Consult live Git history/upstream for the exact checkpoint commit and publication state; do not infer it from a pre-commit snapshot.
- `.gitignore` excludes Finder metadata; a local Finder file was left untouched, not treated as a deliverable.
- Current repeatable tests: filesystem/Git shell suite, offline/runtime-auth readiness Python suite, loopback networking Python suite, process ownership Python suite, and independent synthetic supervision Python suite. All prior default offline suites passed again; the supervision suite passed three probes (identity mismatch, crash, stall), and the later Pi credential-store suite passed two synthetic probes (fresh resolution, expired refusal before refresh). Shell syntax, Python parsing, whitespace checks, and generic publication scan passed. ShellCheck was unavailable; no dependency was installed.
- The private denylist was absent; no private-term scan is claimed. No scanner/hooks/CI integration exists.
- The isolated Herdr test server is stopped and its test pane closed. Tracked Pi/Codex/Claude/shell PIDs were verified absent. Synthetic process-test actors were cleaned up. No worker is intentionally left running. The later isolated live-Pi-attempt server and sampled runtime processes were also verified absent, and its credential projection was destroyed; failed artifacts were preserved privately.
- Retained failed/success-inspection fixtures and raw diagnostics are outside the repository. They are not required to resume: use the scripts and sanitized results. Private credential projections were destroyed; do not import raw host/session artifacts into the repository.

## Read these documents

- [0001 — Overall direction](../proposals/0001-direction.md)
- [0002 — Runtime-neutral dispatch](../proposals/0002-worker-dispatch.md)
- [0003 — Guardrails and publication safety](../proposals/0003-safety-and-publication.md)
- [0004 — Roles, fresh contexts, and round cap](../proposals/0004-subagent-design.md)
- [0005 — Task/result contracts](../proposals/0005-task-contract.md)
- [0006 — Lifecycle, quota recovery, and improvement](../proposals/0006-lifecycle-and-improvement.md)
- [0007 — Coordinator interface](../proposals/0007-interface-and-finalization.md)
- [0008 — macOS worktrees, permissions, and budgets](../proposals/0008-local-isolation.md)
- [0009 — Approval validity and integration](../proposals/0009-approval-and-integration.md)
- [0010 — Workspace installation/removal](../proposals/0010-workspace-binding.md)
- [0011 — Installer operations and release gates](../proposals/0011-installer-and-release-acceptance.md)
- [0012 — Review resolution and authorized milestone](../proposals/0012-review-resolution.md)
- [0013 — Repository layout recommendation](../proposals/0013-repository-layout.md)
- [0014 — Unattended implementation authorization](../proposals/0014-unattended-implementation.md)
- [0015 — Anthropic workers through Claude Code only](../proposals/0015-anthropic-runtime-policy.md)
- [Implementation table of contents and milestone progress](implementation/README.md)
- [Technical evidence and limitations](../research/reference-notes.md)
- [Adversarial review](../research/adversarial-plan-review.md)
- [Initial feasibility results](../research/feasibility-results.md)

## Confirmed product direction

- Independent external harness, explicitly bound to selected workspaces/projects through Pi's supported package mechanism. Project-local Pi coordinator; one active run per project initially.
- Pi default workers for eligible non-Anthropic subscription profiles; Anthropic models through Claude Code only, with Codex CLI and Claude Code in scope; visible Herdr panes, fresh contexts and bounded artifact handoffs.
- Developer, tester, reviewer, and optional scout. Design work belongs in PRD development when needed. Pi delegates production edits and semantic conflicts.
- PRD/spec, plan, and integration approval gates, with human-approved lightweight briefs for small fixes. User-initiated controls write revision/hash-bound approvals; worker reports cannot approve.
- Three total candidate cycles per task. Default configurable workspace-wide ceiling of three active workers, supporting multiple workers of each role. Reserve slots before launch; live blocked workers retain slots.
- Thirty-minute assignment execution limit. Start at confirmed assignment binding; exclude queue/preflight and question/quota waits. Recovery inherits remaining execution time.
- One automatic infrastructure recovery per assignment; additional attempts need explicit human authorization. Quota recovery preserves work and supports scoped approval to wait for a reliably reported reset and retry once with the same profile. No silent runtime/model fallback or effort escalation.
- macOS initially, Git worktrees, native OS containment; no container requirement. Fail closed if required restrictions cannot be established.
- Ordinary scoped checks/builds, locked local dependency installation, and task-owned local services are allowed. New dependencies must fit approved scope or ask. Host-global/elevated operations ask. The user approved ordinary outbound networking instead of destination allowlisting, with task-owned local services. No proxy or enforced provider/registry hostname isolation is claimed; unrelated production operations/credential access remain unauthorized.
- Protect shared Git metadata and coordinator policy/state. Prefer worker change delivery with controlled commits. Candidate checks execute inside contained assignments; exact-candidate review and controlled fast-forward integration, with target drift/dirty-state protection.
- `/calm` changes presentation only. Shift+Tab switches modes without approval; Plan blocks new modifying dispatch and asks before pausing live workers. Native `/thinking` remains available with no alias.
- Local durable metrics include actual harness version/revision/config provenance. On-demand improvement proposals require human approval; no autonomous rule changes or private-data export.
- Non-destructive install/status/update/remove, explicit targets/projects, owned configuration/hash tracking, preserved local edits, active-run guards, and safe interrupted-operation recovery. Pinned normal releases and explicit local-development bindings.

## Additional user request

After feasibility, recommend a clean AI/human-readable repository layout with clear config, worker, skill, and code boundaries. Proposal 0013 records the recommendation; do not scaffold the full tree merely to match the diagram.

## Historical feasibility milestone and checkpoint

Feasibility testing is stopped by user instruction. Its original disposable-fixture agenda was:

1. macOS containment mechanism and actual filesystem/process/network coverage.
2. Runtime authentication/refresh without broad credential exposure.
3. Allowed versus denied worktree/Git metadata operations.
4. Contained candidate execution and policy loading outside worker-writable scope.
5. Herdr launch/detection with selected runtime/native sandbox composition.
6. Termination, subprocess ownership, and supervision loss, including coordinator crashes.

Current checkpoint: the user explicitly approved ordinary outbound networking instead of destination allowlisting; no proxy. All three runtimes passed local authenticated readiness checks through scoped credential access, without model calls or refresh. Isolated Herdr terminal startup was exercised and the test server stopped. Detached-child cancellation exposed the need for registered ownership/watchdog reconciliation. A surviving independent fixture watcher now cleans registered actors after synthetic coordinator crash/stall; arbitrary descendant discovery, registration interruption, watcher loss, and actual-runtime cancellation remain open. Historical capability checkpoint: NO-GO for production support. The user has since ended feasibility testing and authorized implementation with required unverified capabilities kept fail-closed. See feasibility results for evidence and remaining gates.

Do not claim full parity from CLI help, read-only tools, or sandbox availability. `sandbox-exec` is available but deprecated. The user intentionally accepted ordinary outbound networking after the tested hostname filter limitation; do not reopen destination enforcement as a mandatory gate or silently add a proxy. Report capability gaps and obtain decisions before weakening containment or adding architecture such as a proxy.

The adversarial reviewer originally judged the plan NOT READY. Resolution direction is now accepted; current assessment is READY WITH CONDITIONS for this feasibility-first sequence, not production support. A read-only Opus 5.5/high review pane was explicitly authorized, then exited and closed; no review worker remains intentionally running.

## Publication and repository safety

Keep raw prompts, credentials, personal paths, private denylist values, and raw runtime logs outside public material. Sanitize fixtures and evidence. Required publication scanning covers generic patterns; private-denylist coverage must be disclosed, not assumed. Review staged content, commit metadata, and release artifacts separately. No scanner/hooks/CI integration exists yet.

The repository has an origin on the public hosting service. The user authorized the implementation-plan checkpoint and each implementation milestone commit/push; no release or target installation is authorized. Check live Git status/history rather than relying on a handoff snapshot.
