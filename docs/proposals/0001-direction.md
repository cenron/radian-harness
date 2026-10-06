# 0001 — Pi-native engineering harness

**Status: draft for discussion. Not approved for implementation.**

## 1. Confirmed requirements

- Use Pi and its extensibility to fit the user's agentic engineering workflow.
- Maintain the harness separately and install it into explicitly selected workspaces.
- The user supports the direction of a Pi-native package exposing external harness capabilities to workspace/project sessions. This agreement does not approve implementation or the remaining workflow details.
- Pi is the coordinator and main human-facing conversation; workers may use Pi, Codex CLI, or Claude Code.
- Pi is the default worker runtime. JSON dispatch profiles select agent runtime, model, and effort per task.
- Ask the user before worker runtime/model fallback or effort escalation for now. Automatic fallback/escalation is not authorized; this policy may change through a future explicit decision.
- The final harness uses Herdr panes for subagents. Supporting multiple worker runtimes does not imply multiple terminal backends.
- Require durable state, worker identity, reliable delivery, healthy supervision, and safe cleanup as described below. Their concrete mechanisms remain subject to design review.
- Radian is an independent project with its own workflow, guardrails, and delegation contracts.
- Enforce worker role/area boundaries through guardrails, not prompts alone.
- Worker sandboxing/resource containment is mandatory by default. Weaker execution requires an explicit user-approved, scoped exception; no silent downgrade.
- Require public PII/secrets/machine-detail checks for this public harness; publication safety is separate from runtime containment.
- Stay in planning until the user finalizes the plan. Git setup and proposal documents are allowed.
- Do not create subagent panes for this planning discussion.

Everything below is a recommendation or an open decision, not an additional confirmed requirement.

## 2. Recommended product shape

**A Pi package plus a small workspace-management layer, not a replacement for Pi.**

Three responsibilities:

| Layer | Responsibility |
| --- | --- |
| Pi extensions | Approval transitions, role/tool policy, worker dispatch and reconciliation, verification evidence, status UI |
| Skills and prompts | Interview, spec annotation, milestone planning, delegation guidance, review and retrospective playbooks |
| Workspace management | Bind an external harness release to a workspace/project; safely install, inspect, update, and remove owned configuration |

Start with normal interactive Pi as the main interface. Pi already owns the model loop, sessions, tools, and terminal UI. Use its SDK only if a concrete requirement later needs an embedded session or separate supervisor process.

An extension is executable behavior; a skill is guidance. A critical gate must not depend on the model remembering a skill.

## 3. Installation and scope

### Proposed three layers

1. **Personal:** existing Pi credentials, providers, preferences, and user resources remain the user's property.
2. **Workspace:** shared engineering conventions and project registration for a folder of repositories.
3. **Project:** explicit harness binding, project-specific checks, specs, milestone plans, and run metadata.

Pi's project `.pi` configuration is tied to the working directory. Installing at a parent workspace must not assume its package declarations automatically apply to every nested repository or worker worktree. Project registration and worker launch must deliberately establish the required resources.

### Package binding options

- **Local development binding:** reference a package directory in the external harness checkout. Convenient, but edits there affect later resource loads.
- **Pinned release binding:** reference an immutable git commit or versioned package. More reproducible; recommended for ordinary engineering runs.

Recommendation: support local binding for harness development and pinned releases for normal use. Record the harness version/configuration used by each run; prohibit harness-managed updates while runs are active. Mutable local resources need an explicit limitation or a per-run snapshot before claiming reproducibility.

### Installer contract to agree before implementation

- Explicit target, preview/dry-run, and clear summary of changed paths.
- No blanket overwrite of `AGENTS.md`, `.pi/settings.json`, or user resources.
- Merge only owned settings entries; use namespaced files and stable ownership markers.
- Track installed version and original installed hashes for owned files.
- Automatically update unchanged owned files; preserve and surface locally modified files.
- Remove only provably owned, unchanged material; retain modified files and unrelated settings.
- Handle moved/missing harness sources, interrupted updates, and rollback deliberately.
- Canonicalize paths and validate symlinks before writing; do not treat string-prefix checks as sufficient containment.
- Do not silently grant project trust or copy credentials.

The command interface and exact directory names are intentionally undecided.

## 4. Recommended engineering flow

```text
Request / interview
    → Draft spec and acceptance examples
    → Annotation rounds
    → HUMAN: approve spec (+ design when relevant)
    → Milestone plan with verification commands
    → HUMAN: approve plan
    → Delegate implementation and independent testing
    → Verify + fresh review
    → Bounded repair loop, or escalate
    → HUMAN: approve integration/merge
    → Record outcome and short retrospective
```

Confirmed: require PRD/spec, plan, and integration/merge approval, with a lightweight approved brief for small fixes instead of a full PRD. Precise approval-invalidation and lightweight-brief mechanics remain to be specified.

### Proposed roles

- **Coordinator/architect:** main conversation; gathers decisions, plans, delegates, triages, and presents evidence. No production-code ownership by default.
- **Developer:** implements the approved scope and owns unit/integration checks.
- **Tester:** authors acceptance tests from the approved behavior contract; cannot change production code.
- **Reviewer:** fresh context, reviews the exact candidate diff; writes only its report.
- **Designer/UX reviewer:** optional later roles if UI workflow is central.

Runtime, model, and effort are configurable per task, with optional role-based rules and Pi as the default. Worker launch must specify a resolved profile rather than silently using the host's defaults. See [multi-runtime worker dispatch](0002-worker-dispatch.md) for the adapter boundary, illustrative JSON, and validation/fallback policy.

Independence should be operationally meaningful: separate contexts, scoped tools/paths, and explicit evidence inputs. A role name or prompt alone does not enforce it.

## 5. Approvals and durable state

Proposed milestone states:

```text
spec_draft → awaiting_spec_approval → planning
    → awaiting_plan_approval → building → verifying
    → awaiting_merge_approval → completed
```

`blocked`, `cancelled`, and `failed` are explicit outcomes. Repair transitions are capped at three total candidate cycles per task: initial implementation plus two repairs. Additional cycles require explicit human authorization; new panes/tasks cannot silently reset the cap.

Approval binds to a specific artifact revision, approved scope, and relevant configuration. A material change invalidates the affected approval. Merge approval also binds to the candidate commit and verified target/base; a changed candidate or target requires revalidation.

- Only an explicit human control may grant approval; worker reports and assistant prose cannot do so.
- Persist approvals and transitions outside conversation memory, with an auditable actor and reason.
- Do not approve because a pane became idle or an agent wrote “done.”
- Resume by reconciling disk state, repository state, and worker identity; do not infer state from the last chat message.
- Distinguish Herdr client detach (processes stay live) from server restart (processes may need native session restore). A restored conversation must re-establish role policy, launch configuration, and authorization before mutation.
- Enforce one coordinator/writer lease per run, with safe recovery rules.
- In non-interactive use, missing approval means blocked, not implicit consent.

Exact storage format and Pi session-branch semantics need a focused design before implementation.

## 6. Herdr workers and coordination

Herdr is the execution/visibility surface, not the task database.

- Create background panes without stealing focus; identify them by returned IDs and record ownership.
- Launch each worker with an explicit role, model, working directory, resource configuration, and task ID.
- Keep prompts bounded: approved scope, relevant artifact revisions, allowed paths, expected checks, and result contract.
- Return structured task results and reference full reports/logs on disk.
- Include run/task/attempt identity, verdict, candidate commit, executed checks and exit codes, artifacts, and blockers.
- Validate identity and reject stale/duplicate results. The coordinator, not the worker, advances milestone state.
- Treat terminal reads as diagnostics; do not scrape a rendered transcript as the primary result protocol.
- Reconcile idle, blocked, unknown, crashed, and interrupted workers separately. Never equate terminal `done` with successful task completion.
- Cancel and clean up only harness-owned panes, processes, ports, and worktrees. Preserve evidence before cleanup.
- Event-driven notifications should avoid repeated model calls just to ask whether work finished.

Recommendation: isolated worktrees for modifying workers; read-only investigation may use the existing checkout. Worktrees avoid file collisions but are **not** sandboxes.

Developer and tester worktrees require an explicit integration step. Independent tests must eventually run against the same candidate code that will be reviewed and merged. No worker merges into the protected target; coordinator integration stays within approved authority. Ports, services, and output directories also need per-task ownership.

### Reliability and supervision principles

- **Deterministic bookkeeping, model judgment:** ordinary code observes lifecycle and check events, maintains state, and detects timeouts. Wake Pi for decisions and interpretation, not repeated progress polling. Cheap watching does not mean judgment uses zero tokens.
- **History versus current state:** fold durable events into current task state and keyed unresolved decisions. Later progress cannot close or bury a question; resolution names the decision and authorized answerer.
- **Supervision obligation:** active workers require healthy supervision or an explicit paused/handoff state. Check supervisor identity and heartbeat; bound restoration attempts and escalate visibly rather than looping forever.
- **Identity and ownership:** bind run/task/attempt, worker session, pane, worktree, and extension generation. A stale callback or superseded worker must not mutate the current run. Labels are display metadata, not authority.
- **Reliable delivery:** persist outcomes/events before notification and acknowledge after validation/handling. Use identity-based deduplication and reconciliation for missed/duplicate messages; do not promise exactly-once terminal transport.
- **Separate task data from lifecycle control:** messages and briefs are a data channel; interrupt, cancel, resume, and teardown are scoped control operations with verified postconditions.
- **Safe completion and cleanup:** implemented, verified, approved, integrated, and safe-to-clean are separate states. Preserve dirty or unintegrated work and full evidence; closing a pane does not authorize deleting deliverables.
- **Responsive coordinator:** await subprocess work and serialize state transitions explicitly; do not block Pi's terminal render/input path with long synchronous operations.
- **Attention isolation later:** evaluate a separate supervision conversation only after the single-coordinator task lifecycle is reliable. Routine event filtering comes first; any secondary supervisor requires explicit task leases and bounded authority.

## 7. Guardrails and their limits

| Policy | Proposed mechanism |
| --- | --- |
| No implementation before approval | State-checked dispatch and mutation tools; role/phase tool policy |
| Protected target branch | Deny routine agent mutations on protected branches; narrow approved integration operation |
| Reviewer/tester scope | Role-specific tool set and canonical path checks |
| No worker push/merge/cleanup | Deny these operations in worker policy; coordinator owns lifecycle |
| Completion requires evidence | Validate check results and review reports against the exact candidate |
| Bounded retries | Explicit repair budget, timeout, and blocked escalation |
| No stale authority | Revision-bound approvals and run/attempt identity checks |

Pi extensions run with the same OS permissions as Pi. Shell command matching, path checks, and tool-event interception can prevent mistakes, but are not a hostile-code security boundary. Arbitrary shell, other extensions, nested tools, MCP, user shell input, and outside processes need deliberate coverage or restriction.

Prefer scoped operations over exposing unrestricted shell to read-only roles. Unknown or failed authorization checks should block the controlled action. If strong isolation is required, add an OS/container boundary; do not claim that a worktree or project trust provides one.

Pi extensions cannot intercept tool calls inside independent Codex or Claude Code processes. Each worker adapter must establish its own supported enforcement mechanism or an external isolation boundary, and refuse assignments whose required restrictions it cannot meet. Herdr launch support is not permission-policy parity.

See [worker guardrails and publication safety](0003-safety-and-publication.md) for the proposed role matrix, shell/delegation coverage, protected policy/state, publication scanner coverage, and remaining isolation decisions.

## 8. Smallest useful implementation sequence — after approval

1. **Binding and safe mode:** one explicit project, non-destructive installation, planning state, revision-bound approval, and visible status.
2. **One worker end to end:** establish the shared contract through a Pi worker: Herdr pane launch, isolated worktree, explicit model/effort, structured result, cancellation, and restart reconciliation.
3. **Multi-runtime dispatch:** validated JSON profiles and Codex CLI/Claude Code adapters with equivalent required authority, result, lifecycle, and recovery contracts. All three runtimes are in scope; verify each before advertising support.
4. **One complete milestone:** developer + independent testing + fresh review, candidate verification, bounded repairs, and human-approved integration.
5. **Workspace ergonomics:** multiple registered projects, templates, summarized usage/rework metrics, and on-demand retrospectives.

Each milestone must test the harness itself, not only its prompts: installer conflict/remove cases, policy denials and tampering, approval invalidation, worker crashes, stale results, cancellation, restart, exact-candidate verification, and public-safety scanner coverage. Live Herdr tests should use an isolated test session rather than manipulating the user's ordinary session.

Deferred unless requested: remote workers, alternative terminal backends, worker runtimes beyond Pi/Codex CLI/Claude Code, alternative coordinators, unattended auto-merge, public relays, elaborate dashboards, and automated harness self-modification.

## 9. Historical discussion agenda

Later confirmed decisions in proposals 0004–0012 supersede this early agenda. Main-session location, approval gates, local execution, and installer direction have now been settled; remaining feasibility gates are listed in proposal 0012.

1. **Main-session location:** run Pi inside the selected project (recommended initially), at the parent workspace as a cross-project architect, or support both from the start?
2. **Approval workflow (confirmed):** require PRD/spec, plan, and integration/merge approval, allowing a lightweight approved brief for small fixes. Define precise approval-invalidation rules.
3. **Dispatch configuration:** runtime/model fallback and effort escalation must ask for approval for now. Settle profile defaults, rule/candidate selection semantics, and retry/spending limits without treating those limits as permission to switch.
4. **First priorities:** spec/milestone discipline, independent testing/review, guardrails, or restart/away supervision—which two matter most for the initial usable release?

Installation lifecycle, topology, isolation strength, model defaults, design tooling, and metrics retention can be settled after these product-level choices.

## References

Primary documentation: [Pi](https://pi.dev/docs/latest) and [Herdr](https://herdr.dev/docs/how-to-work/), supplied by the user. Target supported versions explicitly rather than relying on a moving “latest” API.

See [reference notes](../research/reference-notes.md) for inspected revisions, source evidence, version differences, and limits of the research.
