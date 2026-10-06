# Session handoff — workspace-first merged; independent safety review pending

## Current checkpoint — resume here

- **Newest (2026-10-06): MVP pivot, user decision (proposal 0017).**
  - Workers now run like claude-kit: each is its runtime's normal interactive session (Claude Code, Codex, or Pi) in an owned Herdr pane and git worktree, with model, effort, role system prompt, tools, and the first task message on the command line.
  - Completion is a complete `result.json`. Radian then stops the session with verified termination and closes the pane.
  - **Removed on the user's instruction:** `sandbox-exec` containment, credential projection, the capability gate and its verification tooling, worker tools, the Pi SDK bridge, and the feasibility suites.
  - Workers use the user's own logins and environment, minus API-key, endpoint, and proxy variables.
  - `AGENTS.md`, the user guide, the README, and the release checklist are updated.
  - Offline: typecheck, unit, and integration suites pass. Not yet run live in the new mode.
  - Possible first-run prompts: Claude Code or Codex may ask to trust a new worktree folder in the worker pane, and the user can answer there.
  - The entries below describe the earlier, now-superseded isolation work and are kept as history.

- **Latest (2026-10-06, user-authorized commits/pushes to `main`):**
  - `7d3d7bf`: coordinator skill fix. The model had invented a task id, so approvals failed with `unknown task`.
  - `aa14a83` / `b6a5236`: [proposal 0016](../proposals/0016-guided-approvals.md) guided approvals (option A). The coordinator requests PRD/spec, start (plan + Build), and merge dialogs that Radian renders from disk, with Cancel first. Tasks are created on PRD approval. The three approval points are unchanged.
  - Then the W06 follow-up F03 correction: the guard-to-commit window. See the [W06 record](workspace-first/06-safety-revalidation.md#completion-record).
  - Offline: typecheck, unit 203/203, integration 12/12, run sequentially. Generic publication checks pass; private-denylist coverage is absent.
  - Not run: the interactive TUI dialogs in a real terminal, live probes, and the six feasibility suites.
  - **Later the same day:**
    - F02 follow-up corrected: integration is judged against the current approved plan's exact checks.
    - F04 follow-up probes found no counterexample.
    - Dispatch accepts trailing-slash write roots such as `scenes/`, never widening `//` to the whole checkout.
    - **Integration flake explained and fixed (test-side):**
      - the fixtures' unchecked `setModel` (Pi returns `false` while a replaced runtime's provider is not usable yet) left Pi on its "unknown" model;
      - the RPC helper ignored the resulting prompt rejections.
      - Result: 12/12 clean aggregate integration runs.
    - Possible product follow-up: Radian's `applyCarry` re-applies the model once, and only warns if Pi refuses.
  - **Remaining before live verification:** independent review of the F02/F03 corrections written in this session.
  - **Capability verification (user-authorized live run, 2026-10-06):** `npm run verify:capabilities -- --tier 1|2|3` and the interactive `/radian capabilities verify` (records only passed items, only on the user's explicit Record choice).
    - Run from this coordinating session on this Mac: Tier 1 7/7, Tier 2 2/2, Tier 3 5/5 for Claude Code 2.1.285.
    - Tier 3 used three tiny Haiku tasks, one owned Herdr pane, and the `Claude Code-credentials` Keychain item read only by the host `security` tool. The login was reported as claude.ai / firstParty / `pro`.
    - **No evidence was recorded by this session**; the user records it per project in Pi.
    - Pi, Codex, and the `sandbox-exec` deprecation remain open.
  - Typed confirmations (`/radian approve` etc.) still use Pi's `confirm`, where Enter means Yes (noted in 0016).
  - Capabilities are 0/26 verified. Live verification needs separate authorization.
  - The installed session was not restarted or driven; Herdr was used only to read its pane at the user's request.

- Subsequent user-authorized crash fix (commit/push authorized): the Calm resolver installed `renderResult` even when a tool lacked that callback, returning `undefined` instead of leaving Pi's native fallback active. A network-denied offline test of Pi's public `ToolExecutionComponent` reproduced the exact `MouseRegion.render` exception before the fix. The resolver now preserves absent callbacks; unit and native rendering regressions pass for Calm off/on, expanded/partial/error output, and narrow/wide widths. Typecheck and 194 unit tests passed. The first aggregate integration run failed W05's project-context marker assertion while unit tests ran concurrently; W05 passed in isolation and all 12 integration tests passed on the subsequent aggregate run. This transient failure is not explained or fixed by the Calm patch. Generic publication and whitespace checks passed; private-denylist coverage is absent. The installed session was not restarted or driven; the local-development binding will load the fix on the user's next restart/resume.

- The user explicitly authorized merging everything into `main`. The entire `workspace-first` branch was fast-forward merged at `a1ee1d1`, including W01–W07 and the configured worker model/routing policy. The user subsequently authorized committing/pushing `main`, updating the existing development workspace to this checkout, and removing the sibling feature worktree after verifying the new binding. `main` was pushed and remote equality verified at `6d3cd41`. The existing development workspace was then rebound through the supported installer: exactly three actions updated the workspace/project package entries and ownership manifest to the coordinating checkout at `6d3cd41`. Status confirmed the source available, ownership unchanged, and no interrupted operation. The clean, fully merged feature worktree was removed without force; its branch/history remain preserved. No Pi session was restarted and no project task or worker was executed.
- Dispatch policy (changed 2026-10-06 at the user's request, for higher Claude plan usage): workers run Anthropic models through Claude Code only.
  - Haiku 4.5 / low for mechanical scouting and testing.
  - Sonnet 5.5 / medium for development (the default) and substantive testing.
  - Sonnet / medium for ordinary review; Opus / high for safety review.
  - OpenAI remains available as explicit `developer-pi`, `tester-analysis-pi`, and `-codex` choices.
  - Previously: Luna/low and Sol/medium through Pi. Rules require explicit coordinator/approved-plan selection; without one, every role uses `developer-standard`.
- Before the merge, independent offline checks on the feature worktree passed: typecheck, 193 unit tests, 11 integration tests, generic publication scan, and whitespace checks. The dispatch-specific expectations were observed failing before the configuration update and passing afterward. The private denylist remains absent. This run did not rerun the six historical feasibility suites.
- Independent source/safety review of W06 remains incomplete. Merge/publication and the specifically requested development-source update are not runtime clearance: capabilities remain disabled; live provider/model/auth probes, real credential reads, capability enablement, unrelated target installation, and releases remain unauthorized.
- W01–W07 cover empty non-Git workspace installation, `/projects`, `/workspace`, `/new-project`, `/add-project`, same-process project selection with isolated context, and process-wide background ownership. Claude reports F01–F04 reproduced/corrected in W06. Its aggregate run passed on tree `96bee7e4…` (191 unit, 11 integration, publication/package checks, six feasibility suites). See the [plan](workspace-first/README.md) and [W07 record](workspace-first/07-verification.md#completion-record).
- The pre-merge coordinating reset checkpoint is preserved below as historical evidence, superseded by this current checkpoint. Its original contents are also retained in the scoped Git stash.

## Historical reset checkpoint — before the authorized local merge

- Workspace-first Claude execution finished: `workspace-first` / `origin/workspace-first` at `38578624507faa028c232cd5ea39973233b5d72a`, in the sibling source worktree `../radian-harness-workspace-first`. Remote branch equality was independently checked. The coordinating checkout remains on `main` at `8fe5637`; no feature merge occurred. Both worktrees were clean before this handoff update.
- Claude reports W01–W07 complete and F01–F04 reproduced/corrected. Its final offline run tested `bb46659`, tree `96bee7e4020945002d145ff8207b10a65dbc45f3`: typecheck, 191 unit tests, 11 integration tests, publication/archive checks (101 files), and six offline feasibility suites passed. The final commit changes documentation only relative to that tested revision. Read the feature worktree's milestone records and `docs/research/implementation-verification.md`; the main checkout contains the planning baseline, not the new implementation.
- The coordinating session read Claude's completion report and verified clean worktree/branch/remote state, but **has not independently rerun the new tests or completed a source/safety review**. Do not treat Claude's completion claims as independent clearance. No further input was sent to Claude after its completion.
- The user installed the feature worktree's `install.sh` into a separate workspace and reports that workspace setup worked. A subsequent apparent PLAN/BUILD issue was resolved: a project must be selected first; Shift+Tab is project-scoped. Calm is currently `/radian calm on|off`, not standalone `/calm`. The user confirmed this behavior. This is user-reported installation/UI smoke evidence, not complete runtime/safety verification. No code fix was required or made.
- The local-development installation loads the feature source in place. Do not remove that worktree, modify/restart the installed session, or operate on its projects as a test without authorization. Dashboard discoverability and a standalone Calm alias were discussed only; neither is a new implementation authorization.
- Next safe step: independently review the feature source and W06 fixes/offline evidence before proposing a merge. No main merge is authorized. Runtime capabilities remain disabled; live model/auth/provider probes, real credential reads, capability enablement, and releases remain unauthorized. Private-denylist coverage remains absent.
- This reset checkpoint is saved locally in the coordinating checkout; it is not yet committed or pushed. Preserve it and reconcile both worktrees/status/history on resume.

## Historical authorization and baseline follow-up

The review of `e28d3db` found seven safety defects: coordinator command-helper escape, planning-write symlink escape, unchecked tested-candidate identity, launch-time approval revocation gaps, partial-launch ownership release, missing active watcher-loss response, and model-controlled round accounting. A user-started Claude Code (Opus 5.5/high, claude.ai subscription) remediation session implemented corrections on 2026-10-06 with failing-then-passing regressions, then ran aggregate offline verification. Independent follow-up review reproduced the existing passes but did not accept full safety clearance: see the [review findings and evidence](../research/remediation-follow-up-review.md). See the [remediation plan and completion records](remediation/README.md) and the [verification report](../research/implementation-verification.md).

- Implementation commit `41b0f3f` (verified tree `5e075f95…`) and the following report/checkpoint commit are pushed to `origin/main`. Typecheck, 146 unit tests, 5 integration tests, publication/package checks, and six offline feasibility suites passed; the private denylist is still absent.
- **Independent review:** at `6d71988`, typecheck, 146 unit tests, 5 integration tests, and full offline verification passed again. Additional fixture probes exposed outside-directory creation on planning-write refusal (F01), lost check argument vectors after repair (F02), stale approval authorization before delivery/start (F03), and retained unknown attempts omitted from later supervision loss/shutdown (F04).
- **Next (user-authorized):** execute the workspace-first plan W01–W07 in a fresh source worktree. The user moved F01–F04 revalidation/correction to **W06 at the end of feature implementation**, followed by W07 aggregate verification. The earlier feature-prerequisite block is superseded; unresolved safety findings still block final completion. Do not replay original milestones/remediation, begin live verification, enable capabilities, or install into actual workspaces.

The user separately performed a local development installation/UI smoke check in a disposable project. Package/skill loading, Plan/Build, Calm/status, and the unverified-capability display were exercised. This is not runtime/authentication/containment/workflow verification. Do not modify or restart that installed session as part of remediation; local source bindings may pick up edits on later loads.

## Workspace-first authorization (historical; now implemented — see the status above)

The user selected option B: an empty workspace is the Pi control root, `/new-project` creates a minimal Git + Radian project, and project selection/work stays in the same Pi interface with isolated project context. The [plan](workspace-first/README.md) and [handoff prompt](workspace-first/new-session-prompt.md) define W01–W07. The user authorized cleaning/committing/pushing the planning checkpoint, preparing a fresh source worktree, and handing it to the existing Claude Code pane for uninterrupted implementation, offline verification, and focused implementation-branch commits/pushes. W01 is a hard supported-public-API gate; W02–W05 build the feature; W06 rechecks and fixes any still-present F01–F04 findings; W07 verifies the final tree. Do not silently substitute separate project Pi processes, global working-directory changes, or weaker guards. Target installation, live tests, capability enablement, main-branch merge, and release publication remain unauthorized.

## Historical implementation checkpoint

All ten milestones of the [implementation plan](implementation/README.md) are **complete**, committed, and pushed to `origin/main` (milestone commits `0d401c2`, `fcee8f6`, `f868b40`, `f34b9fb`, `be6984a`, `7f8f3bc`, `5a4bcb1`, `8f8fa8a`, `fed4562`, and the milestone 10 commit that adds this record — see Git history). The [verification report](../research/implementation-verification.md) records the final offline run: type check, 114 unit tests, 5 integration compatibility tests, publication and package-archive checks, and six offline feasibility regression suites all passed. The private denylist was **not supplied**, so private-term coverage is absent.

**Runtime support and release readiness: NOT READY.** No runtime capability has recorded verification evidence, so every worker launch is refused with `CAPABILITY_UNVERIFIED` before credentials are read. Live task execution, sandbox composition, credential refresh behavior, binding, cancellation, supervision loss, and Herdr pane behavior remain unverified for Pi, Codex CLI, and Claude Code. All three runtimes remain in scope. No release, tag, or package publication has been performed. The original implementation pass did not install into target workspaces; the user's subsequent local smoke check is recorded above.

The original unattended implementation authorization ([proposal 0014](../proposals/0014-unattended-implementation.md)) covered milestones 01–10. The user-started remediation prompt supplies the separate focused follow-up authority. The later workspace-first authorization above covers the new source/offline plan and implementation-branch pushes; it does not authorize live probes, actual workspace installation, main merge, or release. [Proposal 0015](../proposals/0015-anthropic-runtime-policy.md) remains in force: Anthropic workers use Claude Code only; subscription OAuth only; no API-key billing, paid spillover, fallback, or effort escalation.

## Resume here after session reset

1. Read AGENTS.md, this handoff, proposals 0012–0015, the [verification report](../research/implementation-verification.md), and the [user guide](../user/README.md).
2. Check live Git status/history; preserve unrelated or unfinished work.
3. Follow the user-authorized workspace-first W01–W07 plan in the fresh implementation worktree. Revalidate/correct F01–F04 in W06, not as a separate prerequisite pass; final safety acceptance remains mandatory. Do not replay historical milestones/remediation. Separate user decisions remain on the open items: authorizing live, isolated capability verification per runtime/profile (and how evidence is recorded), supplying a private denylist, choosing a license, the long-term containment mechanism given `sandbox-exec` deprecation, and acceptance of the Pi SDK bridge's missing TUI/Herdr-detection parity.
4. Do not mark capabilities verified from synthetic or offline evidence.

## Saved repository checkpoint

- `main` tracks `origin/main`; each milestone commit was pushed after a bounded publication check and verified on the remote. Remote CI (publication job) passed for milestones 01–09.
- Implementation layout: `src/` (contracts, config, state, git, isolation, runtimes, coordinator, ui, workspace, publication), `extensions/radian.ts`, `config/`, `workers/`, `skills/`, `scripts/`, `tests/unit/`, `tests/integration/`, preserved `tests/feasibility/`.
- Verification commands: `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run publication-check`, `npm run verify`.
- No worker, watcher, Herdr pane, or test process was left running; disposable fixtures were removed.

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
- [Review remediation plan and progress](remediation/README.md)
- [Claude Code remediation-session prompt](remediation/new-session-prompt.md)
- [Historical implementation table of contents and milestone progress](implementation/README.md)
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

Historical: the adversarial reviewer originally judged the plan NOT READY. Resolution direction is now accepted; current assessment is READY WITH CONDITIONS for this feasibility-first sequence, not production support. A read-only Opus 5.5/high review pane was explicitly authorized, then exited and closed; no review worker remains intentionally running.

## Publication and repository safety

Keep raw prompts, credentials, personal paths, private denylist values, and raw runtime logs outside public material. Sanitize fixtures and evidence. The publication scanner (`npm run publication-check`), optional owned pre-push hook, and CI generic checks cover generic patterns; private-denylist coverage must be disclosed, not assumed. Review staged content, commit metadata, and release artifacts separately.

The repository has an origin on the public hosting service. Implementation milestone pushes are complete; no release or target installation is authorized. Check live Git status/history rather than relying on a handoff snapshot.
