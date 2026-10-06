# Workspace-first implementation plan

**Status: W01–W07 complete for source implementation and offline verification on the `workspace-first` branch (tested tree `96bee7e4…`); F01–F04 were reproduced and corrected in W06. Runtime/release support: NOT READY; independent follow-up review required before any live verification.**

The user selected **option B** and authorized uninterrupted execution in the existing Claude Code pane from a fresh harness-source worktree, with implementation commits/pushes. The four independent remediation-review findings are to be revalidated and, if still present, corrected **at the end of feature implementation**, before aggregate acceptance. This supersedes the earlier W02–W06 prerequisite block, not safety requirements or runtime capability gates.

## User workflow

```text
mkdir workspace && cd workspace
/path/to/radian/install.sh
pi
/new-project my-app
# Confirm location, initial branch, minimal bootstrap, and initial commit.
# Work through Radian on my-app in the same Pi interface.
/projects
# Select another explicitly registered project.
```

Command syntax is planned, not available today. The workspace is the control root and need not be a Git repository. It may contain zero projects.

- Pi stays at the workspace root in the **same interface/process**. Selected-project identity explicitly routes engineering operations; no global `chdir`, separate project Pi processes, private Pi APIs, or replacement coordinator.
- Each project has isolated conversation context, instructions, tools, configuration, planning artifacts, approvals, and run identity. Workspace navigation and another project's history cannot enter its engineering context.
- `/new-project` creates a minimal independent Git + Radian project. `/add-project` registers an existing repository; `/projects` lists/selects registered projects; `/workspace` returns to the dashboard.
- One selected project per Pi session; one engineering run per project initially. Switching focus does not cancel owned background work. Workspace concurrency remains three by default, configurable within existing policy.
- New-project bootstrap confirms the initial branch (`main` may be offered), minimal files, and initial commit. Existing repositories require an explicitly chosen commit-backed protected target. No guessed Git identity, framework scaffolding, application dependencies, remotes, product approvals, or automatic worker launch.
- Direct Pi entry inside a registered project remains supported through explicit project-local bindings. Do not assume parent Pi settings are inherited.
- Installation previews an explicit target and confirms the exact plan; noninteractive apply requires its reviewed hash. Preserve unrelated/edited configuration and private evidence. No global installation, trust forgery, authentication change, or unpinned source.

## Milestones

| ID | Deliverable | Dependency | Status |
| --- | --- | --- | --- |
| W01 | [Supported Pi context contract](01-context-contract.md) | Native session/source checks | complete |
| W02 | [Empty-workspace installer](02-installation.md) | W01 | complete |
| W03 | [Dashboard and project-scoped routing](03-dashboard-and-routing.md) | W02 | complete |
| W04 | [Project creation and registration](04-project-lifecycle.md) | W03 | complete |
| W05 | [Activation and background ownership](05-project-activation.md) | W04 | complete |
| W06 | [Final safety revalidation and remaining corrections](06-safety-revalidation.md) | W01–W05 | complete |
| W07 | [Aggregate verification and publication checkpoint](07-verification.md) | W06 | complete |

Execute in order using the [session prompt](new-session-prompt.md). W01 is a hard supported-API gate: if safe same-interface isolation cannot be demonstrated, record a blocker and stop rather than substitute option A. W06 rechecks the findings on the assembled feature source; W07 cannot complete with an unresolved safety finding.

## Baseline and end-of-plan safety work

The first remediation produced implementation `41b0f3f` and reporting checkpoint `6d71988`. Independent review reproduced typecheck, 146 unit tests, 5 integration tests, and full offline verification, but exposed [four remaining failures](../../research/remediation-follow-up-review.md):

| Finding | Property to revalidate in W06 |
| --- | --- |
| F01 / R02 | Refused planning writes must not create an outside directory through a missing-parent race. |
| F02 / R03 | Required check argument vectors/approval provenance survive candidate repair and context restore; the same id cannot substitute a new command without approved revision. |
| F03 / R04 | Approval remains current through actual delivery and delayed startup; stale authorization cannot start a new worker. |
| F04 / R05–R06 | Retained unknown-termination work remains monitored and included in loss cleanup/shutdown; an empty active-handle list is not verified termination. |

Do not assume these failures survive a refactor or disappear because existing tests pass. Before fixing a still-present finding in W06, expose it with a failing production-path regression. If it was already eliminated by necessary feature work, demonstrate the equivalent regression passing and explain the mechanical correction; do not fabricate a red run. Preserve earlier evidence as history.

Moving this work to the end permits offline feature implementation, **not unsafe runtime use**. Keep capabilities disabled; do not widen writes, approve stale launches, release unknown ownership, or introduce unsafe directory operations to make intermediate tests pass. Safe feature design may necessarily resolve a finding earlier; final validation is still mandatory.

## Architecture

Discover workspace identity independently of Git. Use explicit `unmanaged`, `workspace-dashboard`, `project-selected`, and `blocked` states; errors in a recognized workspace cannot fall through to unrestricted Pi execution.

A workspace controller owns navigation, registry, session-scoped selection, and project context references. Project services retain repository/config snapshots, approvals, worktrees, runs, leases, supervision, and capability gates. Separate selected-view lifetime from execution-owner lifetime: Pi context replacement must not shut down background ownership unintentionally.

Capture originating project identity and selection generation at invocation. Async results, approvals, and writes never resolve against the project selected after an await. Persist validated project/session-owner context references in private workspace state. Returning to a project restores only its context after identity/trust/configuration revalidation.

Reuse the no-shell coordinator policy, dedicated `radian_git_inspect`, immutable candidate source with declared output roots, launcher execution records, durable cycle accounting, and retained partial-launch ownership. Add real path confinement to read/grep/find/ls: their current name allowlist does not confine reads to a selected project. Validate project-local trust/resources explicitly; workspace trust does not grant child projects blanket execution authority.

```text
<workspace>/.pi/settings.json            owned workspace package entry
<workspace>/.radian/workspace.json       workspace identity
<workspace>/.radian/manifest.json        binding/bootstrap ownership
<workspace>/.radian/config/              user overrides
<workspace>/.radian/state/               registry and shared capacity
<workspace>/.radian/projects/<id>/       private context/run state and worktrees
<workspace>/<project>/.git/              independent repository
<workspace>/<project>/.pi/               explicit direct-entry binding
<workspace>/<project>/.radian/planning/  project planning artifacts
```

## Execution contract

- Use **Claude Code / Opus 5.5 / high** via its supported subscription path, confirmed through native state. Stop on unavailable/unverified required state; no fallback, paid spillover, authentication change, or effort escalation. Pi remains product coordinator; Anthropic workers remain Claude Code only.
- Work only in the supplied fresh harness-source worktree/implementation branch. Reconcile status/upstream/history and preserve unrelated work. Do not edit the coordinating checkout or the user's installed session. No reset/clean/stash/rebase/force-push or unrelated Git changes.
- Read installed Pi docs/examples completely and follow relevant cross-references before integration. Prove native offline semantics, not fake-host behavior alone; `newSession` does not imply `cwd` or project-resource changes.
- Make ordinary reversible choices without routine interaction. On material safety/API/authorization/toolchain/publication blockers, preserve work, record a sanitized blocked milestone, and stop without bypass or false completion.
- Add tests before behavior changes; run targeted tests immediately and interacting regressions when shared contracts change. Use disposable repositories, synthetic credentials, fake workers/transport/clocks, and contained native fixtures only. No live model/auth/provider probes, real credential reads, capability enablement, target-workspace installation, unrelated panes/processes, host-global operations, or releases.
- Local worktree dependencies may be installed using the lockfile with lifecycle scripts disabled; missing prerequisites block rather than cause global installation.
- Commit focused milestones/checkpoints to the implementation branch and push that branch to the existing origin after exact staged-content/metadata, publication, archive-boundary, and whitespace checks. Do not merge into main or publish tags/packages/releases. Preserve local commits and stop if push fails. Private denylist is absent unless separately supplied outside the repository: disclose the coverage gap.
- Record decisions, tests/outcomes, exact tested tree, skips, limitations, and blockers per milestone. `Complete` means acceptance evidence exists; final feature acceptance also requires W06–W07. Offline/UI success never implies runtime support.

## Final acceptance

A disposable fixture demonstrates empty non-Git workspace installation → trusted Pi workspace load → confirmed minimal project creation → project-scoped controls → isolated A/B switching/restoration in the same interface → safe background ownership → migration/update/remove/recovery. Direct project entry remains functional. All four W06 safety cases and interacting aggregate checks pass. Runtime/release support remains **NOT READY** pending separately authorized live capability verification and independent follow-up review.
