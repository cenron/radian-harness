# Technical research notes

Radian is an independent project. These notes cover its platform evidence and research limitations, not an instruction to port another harness. No harness code or dependencies have been implemented. Future third-party code reuse must preserve required licenses and attribution.

## Primary platform documentation

- Pi: https://pi.dev/docs/latest
- Herdr: https://herdr.dev/docs/how-to-work/

Online pages previously reviewed: Pi overview, extensions, and packages; Herdr how-to-work, agent automation, and session state/restore.

Use official docs as the primary design reference, with installed documentation, type declarations, and CLI help for version-specific capability checks. Observed installed versions were Pi `1.0.2` and Herdr `0.9.1`; online Herdr pages reviewed described `0.9.3`. Recheck versions before claiming compatibility.

## Pi: locally inspected extension surfaces

Documentation inspected from installed Pi `1.0.2` includes README; extensions, packages, configuration, settings, security, skills, prompt templates, SDK, CLI, TUI, and keybindings documentation; extension example documentation and plan-mode/subagent examples.

### Implications

- Packages can distribute extensions, skills, prompts, and themes. Local directory packages load from their original path without copying; project package declarations live in `.pi/settings.json`.
- Extensions can register tools and commands, intercept tool calls, persist session entries, and display status/widgets. They run with Pi's OS permissions.
- Skills and templates provide guidance, not enforceable approvals.
- Cross-session/run state needs external storage. Reconstruct branch-sensitive state from the active branch, not every historical entry.
- `agent_end` may be followed by retries or queued work. `agent_before_settle` is actionable; `agent_settled` is final and notification-only.
- Project trust is resource-loading consent, not filesystem isolation. Context files load independently of project trust.
- Plan-mode examples disable built-in edit/write while preserving other active tools; they are not complete write barriers or approval state machines.
- The subagent example demonstrates isolated Pi processes and usage reporting, not Radian's visible Herdr transport or mandatory containment.
- Non-interactive modes cannot rely on custom terminal UI. Missing approval blocks an action rather than granting implicit consent.

## Calm and plan/build feasibility

Pi 1.0.2 documents `registerToolRenderer`, shortcut registration, custom-editor factories, and status/widgets. Prefer these surfaces for presentation and mode controls. Verify the exact supported renderer coverage; do not promise a global transcript filter or use execution-tool replacement merely to hide output.

Tab currently performs autocomplete. Radian's confirmed interaction gives active completion precedence; otherwise Tab toggles plan/build. The stock plan-mode example uses `/plan` and Ctrl+Alt+P and restores full tools for execution; Radian must instead preserve role/approval restrictions in both modes.

Any use of undocumented exported-class internals requires compatibility review and targeted testing. Calm must preserve model context, execution, input delivery, session data, and exports; presentation filtering is not context reduction.

## Herdr

Observed CLI support includes Pi agents and separate pane creation and agent-start operations. Terminal activity/settlement is not a task verdict: idle/done does not prove success, and unknown does not prove termination.

Record returned pane IDs, preserve focus, and control only owned panes. Use durable structured results as the task protocol; terminal reads remain diagnostic.

Recovery distinctions from online documentation:

- Client detach leaves server and pane processes running. Server restart does not preserve the original processes.
- Layout restoration is not process restoration. Native session restore needs valid integration-reported references and supported integration versions.
- Radian's fresh-context policy is distinct from native conversation restore. Re-establish role configuration, authorization, resource ownership, and run lease before mutation.
- Prompt timeout does not prove input was not delivered. Reconcile identity/state before retrying to avoid duplicate dispatch.
- Live handoff may interrupt waits and subscriptions even when processes survive.
- History-read capabilities vary by version. None makes terminal scraping an authoritative result channel.

Live verification of Radian's contracts has not occurred. Do not start worker panes during planning.

## Native macOS containment feasibility — preliminary inspection

Local CLI/documentation inspection observed Codex CLI `0.160.0` and Claude Code `2.1.285`; these are evidence versions, not a finalized support range. No worker/model session or enforcement test was run.

- `sandbox-exec` is available, but its installed manual explicitly marks it deprecated. A whole-worker wrapper is a candidate requiring compatibility testing, not a proven or durable Apple-supported integration contract.
- Codex top-level help exposes read-only/workspace-write policies and no-daemon execution. Its sandbox help describes Seatbelt execution, explicit readable roots, network disabling, and Unix-socket allowances. CLI presence does not prove confinement across its daemon/tool channels.
- This Codex version uses `codex sandbox [COMMAND]`, not a `sandbox macos` subcommand. An inspection using the latter syntax attempted to execute a nonexistent command and failed; no agent or enforcement test was launched. Always inspect current help before using assumed version-specific syntax.
- Claude Code help exposes explicit tool sets, setting-source selection, restricted mode, permissions, and MCP configuration controls. These controls are not evidence of a verified whole-process OS boundary. Restricted mode suppresses command-running tools unless explicitly added, so build/test compatibility must be checked.
- Pi security documentation states that the host process, extensions, and subprocesses share account permissions without an external boundary. Tool guards are not whole-process containment.

Next feasibility checks must cover scoped runtime authentication/refresh, subprocess inheritance, shared worktree Git metadata, file/path denials, task scratch/cache access, process cancellation, local services, and network controls. Destination-specific network policy may require more than a filesystem sandbox; do not claim hostname enforcement from generic network enable/disable switches. No silent downgrade if the selected mechanism cannot meet required restrictions.

## Safety and publication evidence

Role prompts, worktrees, shell-command matching, and same-user hooks are not hostile-process containment. Select and test a concrete native/OS/container boundary for each worker runtime. Test traversal, symlink escapes, alternate tools, delegation, protected Git operations, policy tampering, and missing enforcement directly.

An external generic text-pattern scanner previously reported the planning documents clean. The private denylist was absent, and no scanner/hooks/CI were installed. That historical result does not cover subsequent edits, staged-only content, Git history/metadata, ignored/binary files, or release artifacts.

The public scanning contract is specified independently in [proposal 0003](../proposals/0003-safety-and-publication.md). Scan errors must not be treated as clean results, and diagnostics must not disclose matched secrets.
