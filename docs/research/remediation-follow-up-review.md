# Independent remediation follow-up review

**Date: 2026-10-06. Result: safety dependency NOT CLEARED.**

This review was user-authorized after the Claude remediation session finished. It reviewed the implementation and reporting commits without changing source, tests, capabilities, or installed workspaces. This review initially authorized documentation updates only. The user subsequently authorized committing/pushing the planning checkpoint and workspace-first source implementation in a fresh Claude worktree, with the four findings revalidated/corrected at the end (W06) before aggregate acceptance (W07). No source fix was performed by this reviewing session.

## Revision and evidence boundary

- Reviewed implementation: `41b0f3f0c97449e0b12c312690d0aae835d44c79`, tree `5e075f950869b4b569ef767869e0fba1a109fa53`.
- Reviewed checkpoint/independently tested HEAD: `6d71988341a20211f2083a3afb62a1c88ec608c5`, tree `cc7797d117fa99e2989383ee70ceacd78d311e4f`.
- The checkpoint changes only reporting/status documents. During independent tests, source/tests/scripts/configuration/workers/skills matched HEAD; the uncommitted workspace-first documents and handoff addition were present. Later changes in this review are documentation only.
- Local `origin/main` includes both commits, consistent with Claude's completed pane report. The independent verification did not contact the remote to verify server inclusion or push remediation commits; subsequent planning-checkpoint publication is a separately authorized action.
- Claude's recorded pre-fix failures were examined but not replayed on a separate baseline checkout. Independent verification below is a post-fix rerun plus additional counterexample probes, not new proof of every historical red run.

## Independent verification

Test modes and relevant test bodies were inspected first. No live model task, real credential read, refresh, provider endpoint probe, installed-workspace operation, capability enablement, or Herdr mutation was performed. Herdr was used only to discover/read/wait for the existing remediation agent. Synthetic native fixtures and fake drivers/transport were used for checks.

| Command/check | Independent result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm test` | exit 0; 146 pass, 0 fail, 0 skipped, 0 cancelled |
| `npm run test:integration` | exit 0; 5 pass, 0 fail, 0 skipped, 0 cancelled |
| `npm run verify` | exit 0; typecheck, same unit/integration counts, generic publication check, 91-file package-content boundary check, and all six offline feasibility suites passed |
| Offline feasibility counts | filesystem 34; runtime startup default mode 10; loopback 5; process ownership 3; synthetic supervision 3; synthetic Pi credential-store 2 PASS lines |
| Additional independent probes | four counterexamples reproduced, detailed below; run as an ephemeral inline Node script, not added as passing regression tests |

Toolchain: Node 25.9.0, Git 2.56.0, macOS 27.0.1; installed Pi 1.0.2, Codex CLI 0.160.0, Claude Code 2.1.285, Herdr 0.9.1. CLI presence/help and offline synthetic integration are not runtime support.

The generic publication scanner passed; **private denylist not supplied, private-term coverage absent**. The archive check verifies the package-content boundary, not complete private-term scanning of archive bytes. Live/real-auth/real-pane/target-installation modes were not run; ShellCheck was not run. No skip was reported by the executed suites.

## Findings

### F01 — Refused planning writes can mutate an outside directory (R02, P1)

**Location:** `src/util/confined-fs.ts:113–140`, especially path-based `mkdirSync` at line 125.

The final file open correctly refuses symbolic-link traversal, but parent creation is still check-then-mkdir. If a validated parent is replaced by a link immediately before creating its missing child, the child directory is created outside the anchor; the later no-follow validation refuses only after that mutation. This is already disclosed in the R02 completion record, but conflicts with the original requirement to keep unrelated paths intact and avoid partially applying a refused write. It must not be treated as a generally race-resistant creation primitive for workspace installation/project bootstrap.

**Independent reproduction:** inside one disposable fixture, create `anchor/planning/` and an unrelated `outside/`. Intercept the Node filesystem `mkdirSync` import only at `anchor/planning/child`; rename `planning` and replace it with a link to `outside`, then invoke the original mkdir. Call `writeConfined(anchor, 'planning/child/file.md', 'synthetic')`. Restore the import and remove the fixture afterward.

Observed:

```json
{"refused":true,"outsideDirectoryCreated":true,"outsideFileCreated":false}
```

No outside content was written; the outside directory namespace nevertheless changed. This probe does not establish protection against other concurrent rename/hard-link scenarios.

**Required follow-up:** prevent every parent-creation operation from escaping, or conservatively refuse missing parents until safe directory creation exists. Add a regression before mkdir, not only the existing `beforeOpen` seam. Preserve the no-follow final open and non-macOS fail-closed behavior.

### F02 — Repair assembly loses check definitions, allowing a substituted command (R03, P1)

**Locations:** `src/coordinator/orchestrator.ts:175–198` (`setRequiredChecks`), `:725` (`assemble` evidence reset).

Assembly retains `requiredChecks` ids but drops `requiredCheckArgv`. Consequently the next dispatch can redefine an existing check id after repair without changing or reapproving the plan. The launcher faithfully executes the new vector, and the coordinator records it as a pass under the old required id. Verified checkout identity alone does not prove the approved check was run.

**Independent reproduction:** use `world`, `plan`, and `candidateRound` from `tests/unit/helpers/coordinator-world.ts` (real coordinator/state/Git; fake driver). Assemble a first candidate, run check id `unit` with `['npm', 'test']`, then assemble a repair candidate. Request `unit` with `['/usr/bin/true']` under the same artifact approvals. No actual check command or candidate code is executed by this fake-driver probe.

Observed:

```json
{"originalDefinitionRecorded":true,"definitionLostOnRepair":true,"changedCheckAccepted":true,"boundArgv":["/usr/bin/true"]}
```

**Required follow-up:** preserve revision-bound required argument vectors across assembly/replay, invalidate only outcomes/reviews for a changed candidate, and require an explicit approved plan revision for changing a definition. Add repair and restart tests that reject changing a check's command. Also validate how model-supplied initial check definitions are mechanically bound to the human-approved plan; a first-seen vector is not, by itself, approval provenance.

### F03 — Approval authorization is stale before actual delivery/start (R04, P1)

**Locations:** `src/runtimes/session.ts:139–142` (await preparation then delivery), `:248–257` (last authorization), and `src/isolation/launcher.ts` launch gate.

The last `authorize()` call occurs inside an awaited preparation helper. Its result can become stale before `runInPane` is invoked. There is no approval revision token checked by the launcher: it checks capability/spec identity and explicit stop revocation, not product-approval currency. An accepted but delayed launch may therefore begin after approval rejection without triggering cleanup. The recorded limitation that already-delivered *running* work need not stop does not address a worker that has not yet begun.

**Independent reproduction:** use the production `launchAttempt` with the disposable runtime-session fixtures, synthetic capabilities/credential source, and a fake Herdr runner that executes nothing. The third authorization call returns success and queues a microtask setting the synthetic approval state to rejected. The preparation await yields; the fake delivery runner then observes rejection. Cleanup uses `stopAttempt` with no runtime process started.

Observed:

```json
{"authorizations":3,"deliveredWhileRevoked":true,"launchReportedSuccess":true}
```

This demonstrates the actual session control-flow window using its authorization seam; it is not a live provider or real human-approval test. Code inspection additionally shows no approval-currency gate at delayed launcher start.

**Required follow-up:** establish revision-bound launch authorization at the actual delivery/start boundary, including accepted-but-delayed delivery. Revocation must prevent delayed execution or force owned uncertain-launch reconciliation. Add barriers after the final authorization, during transport delivery, and before launcher start. Moving one callback alone is not evidence that the remote startup window is closed.

### F04 — Unknown-termination owned attempts leave active supervision coverage (R06/R05, P1)

**Locations:** `src/coordinator/orchestrator.ts:477–491` (`release`), `:553–570` (`supervisionLost`), `:574–588` (monitor), `:890–892` (`liveAssignments`); `src/ui/controller.ts:411–416` (shutdown watcher choice).

Unknown termination correctly retains the slot, worktree claim, and handle, but moves the entry out of `handles` into `unresolved`. Health monitoring and `supervisionLost` enumerate only `handles`; `liveAssignments` also excludes retained attempts. Thus work that may still be alive is no longer included in detected safety-loss cleanup. With only retained attempts, the session-shutdown path can choose orderly watcher release rather than heartbeat loss because the live list is empty.

**Independent reproduction:** through a real coordinator/fake driver, return an uncertain launch and unknown stop. Confirm the attempt is blocked and its slot retained. Then invoke `supervisionLost` and compare stop calls. Explicitly cancel the synthetic retained attempt afterward; all fixtures are removed.

Observed:

```json
{"initialOutcome":"blocked","capacityStillRetained":1,"additionalStopsOnLoss":0}
```

The shutdown consequence is from code inspection, not a native shutdown probe. Retaining capacity is good but does not satisfy ongoing supervision of potentially alive work.

**Required follow-up:** treat unresolved potentially alive attempts as owned execution for safety polling, loss response, shutdown, and UI counts. Retry/reconcile stops generation-safely without repeated finalization, retain unknown resources, and do not orderly-release the last watcher while uncertain owned work exists. Test unknown stop *before* watcher/lease loss and shutdown—not only unknown termination produced by the loss response itself.

## Assessment and safe next action

R01's shell removal/dedicated inspection, R05's partial-launch ownership/revocation, and R07's durable accounting materially improve the reviewed paths. No additional independent counterexample was established for those specific fixes in this pass; that is not a universal proof or live support clearance. F04 crosses R05/R06 ownership handling.

The recorded test counts and aggregate pass claims were independently reproducible. **The broader claim that all required safety properties are corrected is not accepted:** F01–F04 leave R02/R03/R04/R06 and the R08 safety exit gate unresolved. Existing completion records remain historical evidence rather than being rewritten to imply these cases passed.

The user subsequently changed sequencing: the [workspace-first plan](../planning/workspace-first/README.md) is authorized for W01–W05 source implementation first, then W06 must revalidate each finding and fix any still present before W07 aggregate acceptance. This supersedes the initial feature-prerequisite block; it does not clear the findings or authorize unsafe runtime use. W01 remains a hard supported-Pi-API gate. No live test, capability enablement, actual installed-workspace operation, or alternate architecture is authorized. Do not replay historical remediation/implementation milestones; follow the new plan and preserve this review as baseline evidence.
