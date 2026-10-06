# Milestone 10 — Final automated verification and capability checkpoint

**Status: complete** · Depends on: 01–09

## Objective

Run the full automated verification once the implementation is assembled, correct in-scope defects, and publish an evidence-backed implementation/support checkpoint. This is not permission to restart live feasibility tests.

## Deliverables

- Final static/type/build, unit, contract, integration, publication, and package-content verification commands and CI jobs.
- Contained disposable fixture verification for workflow/Git/installer/native boundaries where prerequisites are available.
- A sanitized `docs/research/implementation-verification.md` report tied to source/config/runtime/toolchain versions and exact verification revisions.
- Updated README/handoff/support matrix, completed milestone records, and final commit/push summary.

## Verification matrix

| Area | Required automated evidence |
| --- | --- |
| Package/contracts | Type checks/build, schemas, config precedence, exact profiles/effort, Anthropic-only-through-Claude-Code policy across aliases/custom providers/overrides, unknown-provenance rejection and no silent rerouting, invalid input and deterministic provenance |
| Publication | Planted generic/denylist findings, safe examples, partial staging, unreadable/error behavior, redaction, actual staged/committed tree, author metadata, package/archive inclusion |
| Authority | Human-only approval, revision invalidation, stale generations/results, noninteractive missing-approval refusal, coordinator production-write denial |
| Capacity/budgets | Cross-process reservation contention, live blocked slots, duplicate project binding, lease reclaim refusal, execution/blocked accounting, three-round and recovery exhaustion |
| Git/candidates | Hooks/helpers neutralized, shared metadata denials, exclusive worktrees, patch/base validation, exact assembled checks/review, dirty/drift refusal, exact approved fast-forward |
| Containment/auth | Scoped synthetic reads/writes/symlinks/children, dependency declarations, capability fail-closed, fresh/expired synthetic credential behavior, serialized ownership, no personal-store writes, no Anthropic credential exposure to Pi/Codex or prohibited profiles |
| Supervision | Registration interruption, detached children, coordinator/watchdog loss, escalation, identity mismatch, unknown termination blocking replacement, preserved artifacts/resources |
| Adapters/transport | All three fake/native-protocol fixtures, bounded startup/events, trust/auth/quota blockers, exact identity/profile, structured results, stale/duplicate transport, recovery/fresh context |
| Workflow | Fake-runtime developer → tester → exact candidate check → reviewer → human-approved integration; repair/exhaustion/quota/crash/pause/cancel paths |
| Pi UI | Plan/Build guards, Shift+Tab/Tab/native thinking, reversible shortcuts, Calm execution/context/input invariance, blocked noninteractive approvals |
| Binding | Disposable preview/install/status/update/remove, owned settings/hashes, local edits, active runs, symlinks/moved targets, interrupted recovery |
| Metrics | Actual version/config provenance, event durability, unknown usage/cost, no private-data export or autonomous policy changes |

## Execution and stopping rules

1. Run the full suite through documented reproducible commands; use fake clocks/runtimes for deterministic core coverage. Run candidate executable checks in a fail-closed contained environment, with read-only coordinator policy/state and owned scratch/processes. No unrestricted candidate-code execution.
2. Use disposable synthetic repositories/workspaces only. Native tests must explicitly skip with prerequisites/reason when unavailable; a skip is not a pass. Do not manipulate unrelated user panes or signals.
3. Do not invoke the opt-in live Pi task prototype, real-auth readiness options, provider endpoint probes, live refresh, or live model tasks. Existing feasibility suites may be used only as offline regression inputs to this final verification, not as a renewed experimental campaign.
4. Package/build verification may use an archive in private scratch, with scripts explicitly controlled; inspect the actual bytes/manifest before any claim. No registry publication or release/tag creation.
5. Fix ordinary in-scope defects without interaction; rerun affected tests and the final suite after fixes. Do not weaken assertions, bypass containment, replace runtimes/models, or add unapproved architecture to make checks green.
6. If containment prerequisites prevent safely running a required check, record `not run`/`blocked` and keep affected execution disabled. If a required implementation property cannot be met within authority, mark this milestone blocked and stop with preserved work.
7. Account for verification revisions: checks must identify the candidate actually tested. After changes, prior evidence is historical; rerun affected checks. Final reporting-only changes can reference the preceding verified source revision without claiming an untested executable change was verified.
8. Keep raw diagnostics private; publish sanitized outcomes, commands/exit codes, version/provenance, and reasons. No credentials, account details, host paths, private project prompts, or private denylist values.

## Completion versus support

Mark this milestone **complete** only when the automated implementation verification is finished, in-scope failures are resolved, and the final report honestly identifies every pass/skip/not-run/blocker. Previously missing live-provider/runtime evidence may remain explicitly unverified with execution disabled; this does not authorize a release/support claim.

A failing required implemented safety property makes the milestone **blocked**, not complete. Lack of live authentication/refresh/task/cancellation evidence makes runtime support/release **not ready**, even if offline implementation verification completes. All three runtimes remain in scope; no silent scope reduction.

## Commit boundary

Update this file, the index, verification report, README, and handoff. Run exact staged/committed publication checks and metadata/package review; commit/push `test: milestone 10 — final verification and capability checkpoint`. Verify remote inclusion and a clean intended working tree. Report all milestone commit hashes, completion state, check summary, unverified capabilities, and retained work. Do not install, release, or continue testing automatically afterward.

## Completion record

- Completed: 2026-10-06. Added the final verification runner (`scripts/verify.ts`, `npm run verify`), offline runtime compatibility tests (`tests/integration/runtime-compat.test.ts`, `npm run test:integration`), a macOS `behavior` CI job (type check, unit, and integration tests), the Pi bridge verify-only mode and a network-deny option for verification fixtures, and the [verification report](../../research/implementation-verification.md). Updated README, handoff, and the user guide's references.
- Verified source/config revisions: base commit `fed4562` plus the staged milestone 10 code changes, Git index tree `5ad0aa77357d795e4b2c8ce9f71601f7d50d12d1`; the milestone 10 commit adds only reporting/status documentation on top of that tree. Toolchain: Node v25.9.0, TypeScript 7.0.2, Git 2.56.0, macOS 27.0.1; runtimes present for offline checks only: Pi 1.0.2, Codex CLI 0.160.0, Claude Code 2.1.285, Herdr 0.9.1.
- Automated results: type check passed; unit tests 114/114 passed (0 skipped); integration tests 5/5 passed (0 skipped); publication check (staged, working tree, `HEAD` tree, full commit metadata, package manifest, whitespace) passed with the private denylist not supplied; package archive (90 files) entirely inside the package-content boundary; offline feasibility regressions passed (filesystem 34, runtime startup 10, loopback network 5, processes 3, supervision 3, Pi credential store 2). Defects fixed during verification: narrow OpenSSL configuration reads for Pi's Node interpreter and the bridge's `package.json` read; no assertion weakened and no containment relaxed otherwise.
- Not run / capability gaps: live model tasks, real authentication/refresh/expiry, provider endpoints, the opt-in live Pi task prototype, `--real-auth` readiness checks, real Herdr pane operations, interactive Pi TUI behavior (only an isolated `--help` extension load ran), Codex/Claude sandbox composition, actual-runtime cancellation and supervision loss, ShellCheck (not installed), and private-denylist scanning (not supplied). None of the 26 runtime capabilities has recorded evidence, so all worker launches stay disabled.
- Publication/remote checkpoint: bounded publication check before commit and on the committed tree/metadata before push; remote inclusion verified after push. Remote CI for the milestone 10 commit (including the first `behavior` job run) is reported in the final session summary, not in this record.
- Release/runtime support assessment: **not ready** — implementation and offline verification complete; live, separately authorized evidence for every runtime, a private-denylist scan, and an owner-selected license remain release gates. No release, tag, package publication, or target installation was performed.

## Requirements

[Release gates](../../proposals/0011-installer-and-release-acceptance.md) · [Known gaps](../../research/feasibility-results.md) · [Unattended authorization](../../proposals/0014-unattended-implementation.md) · [Execution contract](README.md)
