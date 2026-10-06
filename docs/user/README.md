# Radian Harness — user and operations guide

**Status:** the harness is implemented, but **no worker runtime is verified or supported yet**. Every worker launch is refused until all of its required runtime capabilities have recorded verification evidence (see [Capabilities](#capabilities-and-why-workers-are-blocked)). Planning, approvals, status, and installer operations work without workers. Nothing here is a release.

Radian extends [Pi](https://pi.dev/docs/latest) as the coordinator of a spec-driven, human-approved engineering workflow. Workers run in visible [Herdr](https://herdr.dev/docs/how-to-work/) panes using Pi (non-Anthropic subscription profiles), Codex CLI, or Claude Code (the only route for Anthropic models).

## Requirements

| Component | Reviewed version | Notes |
| --- | --- | --- |
| macOS | 27 | Native `sandbox-exec` containment (deprecated by Apple; see limitations) |
| Node.js | ≥ 22.18 | Runs Radian's TypeScript directly |
| Git | 2.42+ (2.56 reviewed) | `--attr-source` and `merge-tree --write-tree` are required |
| Pi | 1.0.2 | Coordinator and default worker runtime |
| Herdr | 0.9.1 | Terminal backend; the coordinator must run inside a Herdr pane |
| Codex CLI | 0.160.0 | Optional worker runtime |
| Claude Code | 2.1.285 | Optional worker runtime; required for Anthropic models |

Adapters accept only the reviewed runtime versions. A different version returns `RUNTIME_VERSION_UNSUPPORTED` until the adapter is reviewed.

## Install into a workspace

A workspace is a folder you create to hold your projects. It need not be a Git repository and may start empty. Radian keeps its records in `<workspace>/.radian/`, adds one owned package entry to the workspace's own `.pi/settings.json` (so Pi started at the workspace root loads Radian), and adds one owned entry to each **explicitly registered** project's `.pi/settings.json` for direct project entry. It never edits `AGENTS.md`, personal Pi settings or keybindings, credentials, or other settings entries, never binds repositories you did not name, never grants Pi trust, and never installs tools globally.

```sh
mkdir my-workspace && cd my-workspace
/path/to/radian-harness/install.sh   # shows the target, previews the plan, applies only that plan after you confirm
pi                                   # Pi asks once whether to trust the workspace; Radian opens its dashboard
```

`install.sh` targets the current directory unless you pass `--workspace <dir>`, checks Node ≥ 22.18, Git ≥ 2.42, and Pi 1.0.2 read-only (missing tools block; nothing is installed), and applies only after you confirm the exact previewed plan in a terminal, or with `--apply <plan-hash>` non-interactively. The same operations are available as `npm run workspace -- install|update|remove|status|recover --workspace <dir> …`; every mutating command previews first and applies only the exact plan you reviewed (`--apply sha256:<plan-hash>`).

- `--local <harness>` binds a local development checkout (Pi loads it in place; edits affect later loads). `--source git:<repo>@<40-hex-commit>` or `--source npm:<name>@<x.y.z>` binds a pinned release. Unpinned sources are refused.
- `--project <repo>=<refs/heads/branch>` (optional) registers an existing repository root inside the workspace with an **explicit protected target** at install time; normally you add projects from Pi (below).
- `status --workspace <dir>` reports the source, projects, owned entries (unchanged/modified/missing), owned files, active runs, and interrupted operations.
- `update` changes the source between runs. Locally modified owned entries are preserved and reported. Paused runs keep their recorded harness version and configuration until you approve a migration.
- `remove` deletes only unchanged owned material. Runs, evidence, metrics, worktrees, workspace overrides, the harness checkout, projects, and credentials are retained. It is refused while any run is active or paused, a coordinator is live, or capacity is reserved.
- `recover` completes an interrupted operation: steps already at their planned result or still at their expected prior state proceed; anything else is reported and left alone.
- Installations made before workspace-first (project-first `radian.manifest/1`) keep working; `status` reports them as legacy, and a previewed `install` migrates the manifest (adding the workspace entry, keeping project identities, bindings, and state). An active or unverifiable run blocks migration and updates.
- All installer writes go through link-refusing, namespace-safe file operations: a directory or file swapped for a link mid-operation is refused without changing anything outside the workspace.

## Projects in the workspace

Pi stays at the workspace root in one interface and one process; Radian switches the conversation, not Pi's working directory.

- `/projects` lists explicitly registered projects (missing or moved ones are marked) with their targets and runs; `/projects <name>` selects one. `/workspace` returns to the dashboard.
- `/new-project <name> [--branch <branch>]` creates a minimal project after you confirm the exact plan: a new Git repository on the confirmed branch (`main` is offered as the default), one initial commit by your configured Git identity containing only `README.md`, `.gitignore` (which ignores only the machine-specific direct-entry binding), and `.radian/planning/README.md`; then the ignored binding and the registration. No dependencies, frameworks, hooks, remotes, specifications, approvals, or workers. Git runs without hooks, templates, filters, signing, or your global configuration; a missing Git identity blocks instead of being invented. Interrupted creation is journaled: `/new-project --recover` finishes it, never deleting the directory and never committing your edits.
- `/add-project <path> --target refs/heads/<branch>` registers an existing repository with an explicit commit-backed protected target (a picker is offered if you omit it); nothing is committed and dirty work is preserved.
- Each project has its own conversation, instructions (`AGENTS.md` as Pi would load them at the project root), Plan/Build mode, approvals, run, and tool scope. Selecting a project at an idle moment starts or restores only that project's conversation; queued input never moves between projects, and your model and thinking level stay as they were. A project's own `.pi` extensions, skills, prompts, settings, and MCP servers are not loaded in the workspace interface (Radian tells you); use direct entry with Pi's own trust for them.
- Background work continues when you switch: results for another project wait for it (you get a notice without its content), and quitting Pi stops or leaves unfed only work Radian owns, under the verified/unknown rules below.
- Direct entry still works: start Pi inside a registered project to use it on its own (with its own Pi trust decision). One Pi process holds a project's context at a time; a second one is refused.
- With no project selected only workspace status and confined workspace reads are available. A recognized but invalid workspace (unreadable registry, moved record, unregistered directory) is blocked: every tool is refused until you fix it.

### Workspace layout

```text
<workspace>/.pi/settings.json               owned Radian package entry (loads Radian at the root)
<workspace>/.radian/workspace.json          workspace identity (owned)
<workspace>/.radian/manifest.json           ownership manifest (owned)
<workspace>/.radian/config/                 your workspace overrides (yours)
<workspace>/.radian/state/projects.json     explicit project registry (owned)
<workspace>/.radian/state/capacity/         workspace-wide worker reservations
<workspace>/.radian/projects/<id>/state/    runs, approvals, supervision, metrics, context reference and lock (private)
<workspace>/.radian/projects/<id>/exchange/ worker briefs and results
<workspace>/.radian/projects/<id>/worktrees/ owned worktrees (outside your checkout)
<project>/.radian/config/                   optional project overrides (yours)
<project>/.radian/planning/                 coordinator planning drafts (specs, briefs, plans)
<project>/.pi/settings.json                 owned direct-entry binding (ignored in new projects)
```

## Configuration

Shipped defaults live in the harness `config/`. Overrides merge in this order: shipped → `<workspace>/.radian/config/` → `<project>/.radian/config/` (objects merge by key; arrays and scalars replace). The effective configuration is validated after each layer and snapshotted with layer hashes per run.

`harness.json` (defaults): `concurrency.maxActiveWorkers` 3 (workspace-wide, all roles and runs), `assignment.executionLimitMinutes` 30, `assignment.candidateRounds` 3 (cannot be raised), `assignment.automaticRecoveries` 1 (cannot be raised), `assignment.startupTimeoutSeconds`, `supervision.leaseSeconds`, `supervision.terminationGraceSeconds`, `interface.calmDefault`. Fail-closed execution policy fields cannot be weakened.

`dispatch.json` holds named profiles (`runtime`, `provider`, `model`, `effort`), `aliases` (`"@name"` references), and routing `rules` whose `use` lists are **candidate sets for the coordinator to choose from, never fallback chains**. `selection.onUnavailable` accepts only `block`. The configured starting policy is:

| Profile | Model | Runtime | Effort |
|---|---|---|---|
| `scout-fast` | `gpt-6-luna` | Pi | low |
| `tester-fast` | `gpt-6-luna` | Pi | low |
| `tester-analysis` | `gpt-6.1-sol` | Pi | medium |
| `tester-analysis-codex` | `gpt-6.1-sol` | Codex | medium |
| `developer-standard` (default) | `gpt-6.1-sol` | Pi | medium |
| `developer-codex` | `gpt-6.1-sol` | Codex | medium |
| `reviewer-standard` | `claude-sonnet-5-5` | Claude Code | medium |
| `safety-review` | `claude-opus-5-5` | Claude Code | high |

Compatibility names `pi-default`, `codex`, and `claude-code` remain configured for standard work. Model access was user-confirmed; the policy is not a measured quality/usage ranking and does not establish entitlement for other installations or runtime capability/billing verification. Worker execution remains fail-closed on missing verification.

Rule conditions are coordinator guidance, not an automatic classifier. Each assignment must explicitly select its rule/profile with a rationale, assign a profile in the approved plan, or use a human override. With no selection, **every role uses the global `developer-standard` default**. Use `tester-fast` only for prescribed check execution; regression design and nontrivial diagnosis use `tester-analysis`. Safety-critical review uses `safety-review`. Pi is preferred for OpenAI; Codex counterparts are explicit choices, never fallback chains. Model/runtime changes or effort escalation require explicit approval.

For example, an override can explicitly change the global default to Codex:

```json
{
  "default": "developer-codex"
}
```

Provider rules (proposal 0015): Anthropic models (Opus, Sonnet, Haiku, Fable, any Claude model) run only through Claude Code with provider `anthropic`. Pi and Codex profiles naming an Anthropic model — directly, through aliases, or through another provider name — are refused with `ANTHROPIC_REQUIRES_CLAUDE_CODE`. Unknown providers, native aliases (for example `opus`), `provider/model` prefixes, `:thinking` suffixes, and endpoint/key/proxy fields are refused. Effort values are checked per runtime and never clamped. There is no automatic runtime, model, or effort fallback.

## Using Radian in Pi

Start Pi at the workspace root (or inside a registered project for direct entry). Worker runs additionally need Pi to run inside a Herdr pane. Project sessions start in **PLAN**; the status line shows PLAN/BUILD, the project, live workers, Calm, and workspace capacity.

**Quick flow (proposal 0016):** select a project with `/projects <name>`, shape the PRD in conversation, and approve it when the coordinator asks. Then say "start" and approve the plan, and later approve the merge. Each decision is a Radian dialog built from the files on disk: it shows the file, its content hash, the task, and for a start the exact check commands and worker profiles, or for a merge the integration summary. **Cancel** is the initial selection, so Enter alone or Escape records nothing. Approving the PRD creates the task, so you never type task ids or paths. Approving the start also switches that project to Build. A run opens automatically. Dialogs need an interactive terminal; the coordinator can only request them. Until runtime capabilities are verified, dispatch after a start is still refused with `CAPABILITY_UNVERIFIED`.

The typed commands below remain available:

- **Shift+Tab** toggles Plan/Build in managed sessions only (Tab stays autocomplete; native `/thinking` stays available). Mode changes never approve or start work. Entering Plan blocks new modifying dispatch immediately and asks before pausing live workers.
- `/radian status`, `/radian start` (optional: runs open automatically), `/radian task add <title>`.
- `/radian approve|reject <spec|brief|plan|integration> <task> <artifact-path>` — interactive only, with a confirmation showing the artifact hash (and, for integration, the exact candidate, target, checks, review, risks, and gaps). Add `lightweight` after a brief to choose the lightweight-brief path for a small fix.
- `/radian decide <decision-id> <answer>`, `/radian integrate <task>`, `/radian pause|cancel <assignment>`, `/radian grant-rounds <task> <n>`, `/radian authorize-recovery <assignment>`, `/radian retro`, `/radian capabilities`, `/radian calm on|off`.

The coordinator model can read and search with Radian's confined `read`, `grep`, `find`, and `ls` (same names as Pi's; every path is resolved inside the selected project, links are never followed, and other projects and Radian's private state are out of reach), inspect Git through the fixed read-only `radian_git_inspect` tool (status, log, diff, show with exact commit ids), write drafts under `.radian/planning/` only through `radian_write_artifact` (which refuses any link in the path), call `radian_status`, `radian_dispatch`, and `radian_assemble`, and request decision dialogs with `radian_request_approval`, `radian_request_start`, and `radian_request_integration` (model-only tools; they cannot be called from other tools). It has no shell: every `bash` call is blocked in both modes, because commands that look read-only can still start helpers or write files outside worker containment. It cannot approve anything itself, use Pi's `write`/`edit`, edit production files, or use MCP/codemode, tool search, other extensions', or unknown tools in managed sessions (also when called from inside another tool); only the allowed tools are declared to it. Artifacts that are links are never hashed or approved. Without an interactive terminal, approvals and decisions return `NONINTERACTIVE_APPROVAL_REQUIRED`.

**Calm** hides routine successful tool output (one muted line per call) through Pi's tool renderers. Errors, partial output, expanded views, messages, approvals, blockers, and questions stay visible. Execution, model context, logs, and exports are unchanged.

## Workflow, roles, and budgets

PRD/spec (or a human-chosen lightweight brief) → plan → developer and independent tester deliveries → one exact candidate → contained candidate checks → fresh read-only review → human-approved integration by controlled fast-forward. Roles: developer, tester, reviewer (read/report only), scout (investigation; allowed in Plan). See [`workers/`](../../workers/) for role guidance.

- **Rounds:** three total candidate cycles per task, derived from the task's durable state rather than from anything the coordinator model says: developer/tester work before assembly shares a cycle, the first such assignment after a candidate starts the next cycle (once, even for concurrent repairs), each cycle records one candidate, and checks, reviews, and infrastructure recovery never consume a cycle. A fourth is refused (`ROUNDS_EXHAUSTED`); only `/radian grant-rounds` adds more. An open accounting decision blocks new candidate work until you resolve it.
- **Execution time:** 30 minutes per assignment, starting at confirmed binding; queue, preflight, questions, quota waits, and pauses are excluded and recorded separately. Recovery attempts inherit the remaining time.
- **Recovery:** one automatic fresh-context recovery after a verified infrastructure failure; more need `/radian authorize-recovery`.
- **Questions** pause the assignment until you decide; it resumes in a fresh attempt.
- **Quota exhaustion** preserves work and opens a decision. One retry with the unchanged profile needs your authorization and a reliably reported reset time. No paid spillover, fallback, or background retry.
- **Unknown termination** (a worker that could not be proven stopped) keeps its capacity slot, blocks replacement until reconciled, stays monitored and counted as live work, is stopped again on supervision loss, and keeps Pi from orderly releasing the watcher when you quit.
- **Required checks** come only from the approved plan: declare them in a `radian-checks` block (one `id: ["argv", …]` per line). A check the approved plan does not declare, or a different command under the same id, is refused — also after repairs and restarts; changing one needs a newly approved plan revision.
- **Candidate checks** run on the exact current candidate with source, tests, and config read-only (only declared untracked output directories are writable). The contained launcher runs each approved check command itself, without credentials, and records its exit status; Radian counts a check only from that record, after verified termination and after confirming the checkout still holds exactly the candidate.
- **Approvals are rechecked at every launch**, including recovery, resume, and quota retry: a rejected, invalidated, edited, or deleted spec/brief/plan stops a new attempt from starting. This holds up to the actual start: an approval change first revokes every launch that has not started yet, and the launcher re-checks the approved artifacts immediately before it starts anything; a worker that had already started keeps running.
- **Supervision loss** (the watcher exiting or stalling, a heartbeat failure, or the coordinator losing its project lease) stops every live worker the coordinator owns and blocks new dispatch until the session is restarted; nothing restarts automatically.
- **Integration** requires your approval bound to the exact candidate and target, passing evidence for every required check on that candidate, a review of the same candidate without blocking findings, an unmoved target, and a clean target checkout. Radian never stashes, rebases, squashes, resets, or cherry-picks.

## Capabilities and why workers are blocked

Before any worker launch, Radian requires recorded verification evidence — bound to the OS major version, runtime version, toolchain, and policy template — for every capability the runtime and role need: native containment (filesystem, process signals, network, dependency audit), independent supervision (watcher, descendant termination, watcher-loss response), the runtime's contained launch, tool restrictions, assignment binding, and cancellation, non-refreshing credential access, the subscription billing path, and owned Herdr panes. **None are verified in this release**, so every launch returns `CAPABILITY_UNVERIFIED` before any credential is read. No command records capability evidence; verification is a release gate requiring explicitly authorized live tests. `/radian capabilities` lists the gaps.

What the containment layer does when enabled: a deny-default `sandbox-exec` profile with task-scoped reads and writes, private output and scratch, protected Git metadata, coordinator state, policy and credential projections, no personal credential stores, ordinary outbound networking (no destination isolation is claimed), owned local ports, and the assigned terminal only. Credentials are projected read-only for the selected subscription provider only; workers never refresh them.

## Evidence, privacy, and metrics

Run state, approvals, briefs, results, supervision registries, captured runtime events, metrics, and retrospectives stay in the workspace's private `.radian/projects/<id>/` tree. Metrics record identifiers, categories, counts, durations, and the run's harness version/revision/local-modification state and config hash — never prompts, code, logs, or credentials. Unknown usage stays unknown; no subscription spend is invented. Retrospectives are private proposals that require your decision and never change the harness automatically.

## Diagnostics

Refusals are structured blockers with stable codes (for example `APPROVAL_STALE`, `CAPACITY_FULL`, `TARGET_DRIFT`, `CAPABILITY_UNVERIFIED`) and a safe next action. Coordinator guard denials name rules such as `RH-COORD-PRODUCTION-WRITE`; containment diagnostics name rules such as `RH-DENY-PROTECTED`. Nothing is retried, rerouted, or widened automatically.

## Maintaining the harness

```sh
npm ci --ignore-scripts
npm run typecheck && npm test && npm run test:integration
npm run publication-check
```

See the [development guide](../development.md) for the toolchain, publication safety, and package boundaries, and the [release acceptance checklist](release-acceptance.md) for what must be demonstrated before any runtime is advertised as supported.

## Known limitations

- `sandbox-exec` is deprecated; availability is not proof of complete containment. Path metadata is readable.
- Process identity uses sampled `ps` start times; descendant discovery is not exhaustive. Processes found only by working directory are never signalled and make termination `unknown`.
- Candidate and integration checkouts do not run project filter drivers (for example large-file smudge filters).
- Worker panes show launcher-rendered event summaries, not the runtimes' interactive UIs; Herdr does not detect them as agents.
- The managed editor conflicts with any other extension that replaces Pi's editor.
- Switching projects is exercised offline through Pi's RPC mode (the same session replacement as the terminal UI); the terminal UI itself is not automated. Directory listings and delegated searches re-resolve paths after validation, so only a concurrent change to the project by you (never by the coordinator) could race them.
- Each namespace-safe file step starts a short-lived Node process (project creation takes about a second).
