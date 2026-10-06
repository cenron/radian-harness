# Implementation verification and capability checkpoint

**Status: first remediation aggregate offline verification passed (2026-10-06); independent follow-up review found remaining safety blockers. Worker-runtime support and release readiness: NOT READY.** Every worker launch remains disabled because no runtime capability has recorded verification evidence; live runtime, authentication, refresh, cancellation, and Herdr behavior were not exercised (not authorized).

## Independent follow-up qualification

The [independent review at `6d71988`](remediation-follow-up-review.md) reproduced typecheck, 146/146 unit tests, 5/5 integration tests, and the full offline verification pass, but additional disposable-fixture probes exposed four acceptance failures: outside-directory creation on a refused planning write, lost check argv after repair, stale approval authorization before delivery/start, and retained unknown attempts omitted from later supervision loss/shutdown. Thus the test results below stand as historical evidence, but full correction/safety clearance is not accepted. The final safety gate is unresolved. The user subsequently authorized revalidating/correcting these findings at the end of workspace-first implementation in W06, followed by W07 aggregate verification; the earlier feature-prerequisite block is superseded. No executable source was changed by this review. Independent follow-up review remains required before live verification.

## First review remediation checkpoint (historical evidence)

A review of `e28d3db` found seven safety defects that the milestone 10 run below did not exercise. That run remains a historical record of the earlier tree; it is not retroactively corrected proof. Per-finding red/green evidence, design choices, and residual limitations are in the [remediation plan and progress index](../planning/remediation/README.md#completion-records).

| Item | Value |
| --- | --- |
| Date | 2026-10-06 |
| Reviewed baseline | `e28d3db` (milestone 10) |
| Verified code tree | Git index tree `5e075f950869b4b569ef767869e0fba1a109fa53`, committed unchanged as `41b0f3f` (remediation implementation). The working tree's source, tests, scripts, configuration, workers, and skills matched the index exactly during the run; this checkpoint commit adds only reporting and status documentation. |
| Command | `npm run typecheck`, `npm test`, `npm run test:integration`, then `node scripts/verify.ts` (`npm run verify`) |
| Toolchain | Node v25.9.0, TypeScript 7.0.2, Git 2.56.0, macOS 27.0.1 |
| Runtimes present (help/version/offline only) | Pi 1.0.2, Codex CLI 0.160.0, Claude Code 2.1.285, Herdr 0.9.1 |

| Step | Outcome | Exit | Detail |
| --- | --- | --- | --- |
| `npm run typecheck` | passed | 0 | clean |
| `npm test` (unit) | passed | 0 | 146 tests, 146 pass, 0 fail, 0 skipped, 0 cancelled (114 before remediation; includes 32 new regression and interaction tests in `tests/unit/remediation/`) |
| `npm run test:integration` | passed | 0 | 5 tests, 5 pass, 0 skipped (help-only CLI flag checks, isolated offline Pi extension load, offline Pi SDK bridge under a network-denied sandbox) |
| `npm run verify` — typecheck, unit, integration | passed | 0 | same counts as above |
| `npm run verify` — publication check (staged, working tree, `HEAD` tree, full commit metadata, package manifest, whitespace) | passed | 0 | 0 findings for covered generic patterns; **private denylist not supplied — private-term coverage absent** |
| `npm run verify` — package archive | passed | 0 | 91 files, none outside the package-content boundary |
| `npm run verify` — offline feasibility regressions (filesystem, runtime startup default mode, loopback networking, process ownership, synthetic supervision, Pi read-only credential store) | passed | 0 each | 34, 10, 5, 3, 3, and 2 PASS lines |
| Pre-commit publication check of staged content; post-commit check of the `41b0f3f` tree and unpushed metadata | passed | 0 | 0 findings; whitespace 0 issues; denylist absent |

Not run: live model tasks for any runtime, every `--real-auth` readiness option, the opt-in live Pi task prototype, token refresh, provider endpoint probes, real Herdr pane operations, installation into target workspaces, and ShellCheck (not installed). No skipped tests. Native-only tests (`sandbox-exec`, `O_NOFOLLOW_ANY`) ran on this macOS host; on other hosts they report skips, not passes.

### Per-finding regression evidence

Each regression was run against the code before its fix (red) and after (green); "baseline" for R05–R07 is the tree after the preceding corrections, where those defects were still present.

| Finding | Red (before) | Green (after) |
| --- | --- | --- |
| R01 coordinator command-helper escape | 34 of 50 shell commands accepted across Plan/Build, including all four reviewed examples | every `bash` call blocked; `radian_git_inspect` runs fixed vectors with no planted helper firing (positive control fires) |
| R02 planning-write symlink escape | all six linked forms written through; Pi `write` to planning allowed; linked artifact hashed for approval | all refused with protected and outside files unchanged; parent/destination substitution refused by the kernel open; linked artifacts not approvable |
| R03 exact tested candidate | tampered checkout accepted as evidence; whole tree writable; unknown termination and bare worker claims accepted | outcomes only from launcher-executed approved checks on a verified exact checkout after verified termination; source read-only (natively confirmed) |
| R04 approval revalidation | launches completed after rejection, during a capacity wait, and before recovery | refused at every boundary (before reservation, after setup, inside the session before credentials/pane/delivery) for initial, recovery, resume, and quota retry; nothing leaked |
| R05 partial-launch ownership | failed delivery treated as verified non-execution; interrupted registration reported verified; delayed launcher started the runtime | uncertain launches stopped and verified before release; unknown keeps ownership; revoked delayed launchers start nothing |
| R06 watcher/lease loss | unhealthy supervision did not stop live work; no loss response; released lease renewable; renewal results discarded | all live work stopped within the bound and blocked; halt latched; renewal failures reported; released or expired leases not renewed |
| R07 cycle accounting | fourth cycle via omitted/false flags; flagged developers consumed cycles; second candidate per cycle; ambiguous classification ignored | cycles derived from durable state under lock; flag ignored; one candidate per cycle; cap, grants, replay, and accounting decisions enforced |

Cross-finding interactions (`tests/unit/remediation/r08-interactions.test.ts`), all passing: approval revoked during an uncertain launch (stopped, verified, no recovery starts); watcher loss during partial-launch cleanup (one shared stop, no recovery, ownership per termination); candidate mutation in a check followed by repair (evidence refused, exactly one new cycle, reverified); a planning artifact swapped for a link after approval (launch refused until a regular file with the approved content returns).

### Remaining gaps after remediation

- Runtime support remains **not ready** and every launch stays disabled: no capability evidence is recorded and none was created by this work.
- Remaining limitations of the corrections are listed per finding in the completion records (for example: no execution record exists for live runtimes yet; check time precedes binding and is not charged to the execution budget; a delayed launcher process may run briefly before it reads the revocation; detection of a stalled watcher is bounded by status staleness; simultaneous watcher-and-coordinator loss and actual-runtime descendants are unverified).
- An independent follow-up review of these corrections is required before live verification is considered.
- Earlier blockers stand: live isolated capability verification per runtime/profile, a private denylist, a license choice, the long-term containment mechanism given `sandbox-exec` deprecation, and the Pi SDK bridge's missing TUI/Herdr-detection parity.

## Historical milestone 10 run (pre-remediation)

The remainder of this report is the original milestone 10 verification of tree `5ad0aa77…`. It did not exercise the seven defects above and is preserved unchanged as history.

## What was verified

| Item | Value |
| --- | --- |
| Date | 2026-10-06 |
| Base commit | `fed4562` (milestone 09) plus the staged milestone 10 code changes |
| Verified code tree | Git index tree `5ad0aa77357d795e4b2c8ce9f71601f7d50d12d1` (all source, tests, scripts, configuration, and CI as committed in milestone 10; the milestone 10 commit adds only reporting and status documentation on top of it) |
| Command | `node scripts/verify.ts` (`npm run verify`) |
| Toolchain | Node v25.9.0 (package requires ≥ 22.18), TypeScript 7.0.2, Git 2.56.0, macOS 27.0.1 |
| Runtimes present (help/version/offline only) | Pi 1.0.2, Codex CLI 0.160.0, Claude Code 2.1.285, Herdr 0.9.1 |

No live provider, model, authentication, refresh, or provider-endpoint activity occurred. No Herdr pane, agent, or session was created or modified. No target workspace or project was installed into; installer behavior used disposable fixtures only. Synthetic credentials only; no real credential was read.

## Results

| Step | Outcome | Exit | Detail |
| --- | --- | --- | --- |
| Type check (`tsc --noEmit`) | passed | 0 | clean |
| Unit tests (`node --test tests/unit/**`) | passed | 0 | 114 tests, 114 pass, 0 fail, 0 skipped |
| Integration tests (`node --test tests/integration/**`) | passed | 0 | 5 tests, 5 pass, 0 fail, 0 skipped |
| Publication check (staged, working tree, `HEAD` tree, full commit metadata, package manifest, whitespace) | passed | 0 | no findings for covered generic patterns; **private denylist not supplied — private-term coverage absent** |
| Package archive (`npm pack --ignore-scripts` into private scratch, `tar -tzf` inspection) | passed | 0 | 90 files, none outside the package-content boundary |
| Feasibility regression: filesystem (offline) | passed | 0 | 34 PASS lines |
| Feasibility regression: runtime startup (offline version/missing-auth, default mode) | passed | 0 | 10 PASS lines |
| Feasibility regression: loopback networking | passed | 0 | 5 PASS lines |
| Feasibility regression: process ownership | passed | 0 | 3 PASS lines |
| Feasibility regression: synthetic supervision | passed | 0 | 3 PASS lines |
| Feasibility regression: Pi read-only credential store (offline, synthetic) | passed | 0 | 2 PASS lines |
| Remote CI (publication job) on milestone commits 01–09 | passed | — | GitHub Actions `ci` completed successfully for each pushed milestone commit |

Not run: the opt-in live Pi task prototype, every `--real-auth` readiness option, live model tasks for any runtime, live token refresh, provider endpoint probes, and real Herdr pane operations (all outside the authorized scope). ShellCheck is not installed and was not run. The new `behavior` CI job (macOS type check, unit, and integration tests) first runs with the milestone 10 push; its result is not part of this report.

## Coverage by verification area

| Area | Automated evidence (where) | Result |
| --- | --- | --- |
| Package/contracts | Type check; strict schema validators; shipped defaults; precedence and provenance; invariant enforcement; exact profiles and effort; Anthropic-only-through-Claude-Code across direct names, aliases, custom providers, overrides, native aliases, prefixes, suffixes, and endpoint fields; unknown provenance; no rerouting (`tests/unit/config/`, `tests/unit/contracts/`, adapter and session tests) | passed |
| Publication | Planted generic and denylist findings, safe examples, partial staging, unreadable and oversized inputs, symlinks, binary exclusion, narrow allowances, redaction, commit metadata, hooks (`tests/unit/publication/`); full repository check and archive inspection | passed; private-term coverage absent |
| Authority | Human-only approval channel, forged channels refused, artifact/candidate/target binding and invalidation, stale generations and spoofed results, noninteractive and RPC approval refusal, coordinator production-write denial (`tests/unit/state/`, `tests/unit/ui/`) | passed |
| Capacity/budgets | Six-process reservation contention, live blocked slots, verified-only reclaim, duplicate/moved/nested bindings, lease reclaim refusal for live/unknown owners, binding-based execution time with blocked-time exclusion, three-round and recovery exhaustion (`tests/unit/state/`, `tests/unit/coordinator/`) | passed |
| Git/candidates | Planted hooks, filter/diff/merge drivers never executed; Git pointer tampering; out-of-scope paths and escaping symlinks; patch/base mismatch; exact single-parent candidates and conflicts; dirty and drifted targets; exact approved fast-forward; conservative cleanup (`tests/unit/git/`) | passed |
| Containment/auth | Real `sandbox-exec` denials on synthetic fixtures (scoped reads/writes, protected Git/state/policy, credential stores, symlinks, children); capability fail-closed and version binding; credential projection refused before any read for prohibited pairings or unverified capabilities; API keys, unknown and expiring credentials refused; rotation detection; no personal-store writes (`tests/unit/isolation/`); Pi SDK bridge under a network-denied sandbox: exact model/effort/tools, expired synthetic OAuth refused without refresh, API key refused, silent effort clamp refused (`tests/integration/`) | passed (synthetic only) |
| Supervision | Registration intent before spawn; unknown postcondition for interrupted registration, cwd-only suspects, or missing process table; protected PIDs; real detached TERM-ignoring child escalated and verified gone; independent watcher process stops registered work on heartbeat loss and is detected as unhealthy afterwards; lease-expiry (stall) handling (`tests/unit/isolation/`) | passed (synthetic processes only) |
| Adapters/transport | Flag/profile translation for all three runtimes, forbidden flags never emitted, role tool sets, event parsing and error classification, version gating; installed `codex exec --help` and `claude --help` contain every emitted flag; owned-pane transport with no resend; fake Codex-format runtime through the real contained launcher with semantic binding and verified stop (`tests/unit/runtimes/`, `tests/integration/`) | passed (no real runtime task or pane) |
| Workflow | Fake-runtime developer → tester → candidate → contained check → review → human-approved integration; Plan/stale-approval guards; repairs and exhaustion; questions; quota retry; crash recovery; unknown termination; drift; stale results; resume reconciliation (`tests/unit/coordinator/`) | passed (fake driver) |
| Pi UI | Plan default, Shift+Tab toggle with Tab pass-through, editor restoration, Plan with live workers, Calm invariance, human-only commands, noninteractive refusal (`tests/unit/ui/`); Pi 1.0.2 loads `extensions/radian.ts` in an isolated agent directory (`tests/integration/`) | passed (fake host; real load only) |
| Binding | Preview/apply-by-hash, settings merge and preservation, update/remove with local edits and retained state, active-run refusal, symlinks, nested/moved/duplicate bindings, interrupted-operation recovery, CLI (`tests/unit/workspace/`) | passed (disposable fixtures) |
| Metrics | Recorded harness version/revision/local-modification state and config hash, unknown usage kept unknown, private retrospectives with human decisions and no guardrail weakening (`tests/unit/coordinator/`) | passed |

## Defects found and fixed during verification

- Pi's Node interpreter could not start under the contained profile because it reads its OpenSSL configuration. Dependency resolution now grants the OpenSSL configuration file, certificate bundle, and certificate directory reported by the adjacent `openssl` tool — never the `private/` directory.
- Node reads the harness `package.json` to load the Pi bridge as a module; the Pi launch plan now grants exactly that file.
- The Pi bridge gained a verify-only mode (all setup and checks, credential resolution through the read-only store, no prompt) used by the offline compatibility check, and the profile generator gained a network-deny option for such fixtures. Production workers still receive the approved ordinary outbound networking.

No assertion was weakened, no containment was relaxed beyond these exact reads, and no runtime, model, or authentication setting was changed.

## Capability and support matrix

Runtime capabilities are gated by recorded evidence. **None of the 26 capabilities has evidence recorded**, so every worker launch is refused with `CAPABILITY_UNVERIFIED` before credentials are touched.

| Runtime | Implemented | Verified offline (synthetic) | Unverified (blocks launch) | Status |
| --- | --- | --- | --- | --- |
| Pi (non-Anthropic subscription profiles) | SDK bridge adapter, read-only credential store, contained launch, binding, stop | Public SDK compatibility, exact model/effort/tools, refresh refusal, API-key refusal, clamp refusal under a network-denied sandbox; extension load | Live task execution, outer-sandbox composition with networking, actual cancellation, subscription billing path in use, Herdr pane behavior; no interactive Pi TUI or Herdr agent detection for workers | **Disabled** |
| Codex CLI | `codex exec --json` adapter, contained launch, binding, stop | Emitted flags exist in the installed CLI; offline startup | Live task execution, Codex sandbox inside the outer sandbox, non-refreshing credential use, cancellation, billing path | **Disabled** |
| Claude Code (only route for Anthropic models) | `claude -p` stream-json adapter, safe mode, restricted reviewer, subscription-auth binding check | Emitted flags and choices exist in the installed CLI; offline startup | Live task execution, sandbox composition, non-refreshing credential use (file projection with Keychain denied), cancellation, billing path | **Disabled** |
| Herdr transport | Owned pane creation, delivery without resend, verified-termination close | Fake transport only | Real pane lifecycle in an isolated session | **Disabled** |
| Native containment | Deny-default profile generator, narrow dependency resolution | Synthetic filesystem/process/network denials | Dependency-access audit for real runtimes; `sandbox-exec` deprecation risk | Capability records unverified |
| Supervision | Registry, verified termination, independent watcher | Synthetic crash/stall, real detached child | Actual runtime descendants, watcher loss combined with coordinator loss | Capability records unverified |

## Release and runtime-support assessment

**Not ready.** Implementation and offline verification are complete, but the [release acceptance checklist](../user/release-acceptance.md) requires live, separately authorized evidence for every runtime (task execution, containment composition, credential behavior, binding, cancellation, supervision loss, and Herdr panes), a private-denylist publication scan, and an owner-selected license. All three runtimes remain in product scope; none is advertised as supported. No release, tag, or package publication was performed.

## Remaining blockers and safe next actions

1. Decide whether to authorize live verification in isolated fixtures, one runtime and profile at a time, to produce capability evidence (and how that evidence may be recorded).
2. Supply a private denylist outside the repository and rerun `npm run publication-check -- --require-denylist` before any release.
3. Choose a license.
4. Decide on a long-term containment mechanism given `sandbox-exec` deprecation.
5. Review the Pi SDK bridge's missing parity (no Pi TUI or Herdr agent detection in worker panes) before relying on it.
