# Milestone 06 — Pi, Codex, Claude, and Herdr adapters

**Status: complete** · Depends on: 05

## Objective

Implement all three runtime adapters behind one contract and an owned Herdr transport. Implemented does not mean verified/supported.

## Deliverables

- Runtime adapter contract for version/capability preflight, exact profile, authority/policy loading, assignment binding, structured events/results, activity/blockers, interruption, termination, and recovery.
- Pi, Codex CLI, and Claude Code adapters using current documented APIs/CLI argument vectors and native role/tool restrictions composed with the outer OS boundary.
- Herdr transport for fresh pane creation, explicit owned IDs, no-focus launch, bounded command/event operations, and safe owned-pane retirement.
- Provider-safe error classification: quota, authentication, trust/permission, infrastructure, unknown; no fallback or profile changes.
- Requested/resolved profile, effective effort, runtime/native session identity, policy/config provenance, and honest unavailable vendor attestation.

## Implementation tasks

1. Read installed runtime docs/help before selecting flags. Avoid blanket native permission/sandbox bypass, undocumented auth fallbacks, and assuming Codex supports Claude hook shapes.
2. Recheck resolved runtime/provider/model policy before credential access and launch: Anthropic models require Claude Code's supported claude.ai subscription path. Reject forbidden or unresolved profiles before projecting credentials or creating panes; never silently reroute. Subscription OAuth alone does not prove plan-limit billing; do not enable paid extra usage or fall back to API keys/custom endpoints. Preflight all required runtime/tool/credential/containment capabilities before starting an assignment. Unsupported/unknown role capabilities reject the assignment.
3. Choose and document the Pi SDK/CLI boundary. A SDK bridge must use public interfaces, preserve runtime semantics, and explicitly report any missing interactive/Herdr detection parity.
4. Enforce reviewer read/report-only behavior without arbitrary shell/network/install tools; tester/developer/scout authorities intersect task scope. Disable unknown extension/MCP/nested/delegation channels unless controlled and registered.
5. Create fresh conversations/panes for every assignment/repair/recovery. Never auto-accept trust/onboarding/login prompts. Record a blocker instead.
6. Use returned Herdr pane IDs; do not derive them from layout or act on the UI-focused pane. Do not manipulate existing user panes during implementation.
7. Establish semantic assignment binding, not merely idle/detection. Persist structured results before notification, correlate identities/generations, and wait for genuine runtime settlement rather than rendered text or one transient event.
8. Preserve unknown/blocked/interrupted outcomes; bound startup/waits; avoid duplicate prompt delivery after uncertain transport timeouts. Scope interrupt/cancel to registered execution and verify postconditions through 05.
9. Author fake-runtime/socket/JSONL fixtures for all three adapters: flag/profile translation, Anthropic rejection outside Claude Code, unknown/aliased provider provenance, credential non-exposure and no silent rerouting, broken policy, unknown tools, startup/trust/auth blockers, quota, malformed/stale results, duplicate/missed events, cancellation, and fresh-context recovery.

## Completion criteria

- All three adapters and transport paths exist with genuine enforcement/refusal logic, not simulated success.
- Runtime support/capability status is explicit and defaults unverified paths to unavailable.
- No actual worker/model launch, personal credential use, or unrelated Herdr operations during this milestone.
- Publication checks now; contract/fixture verification runs in 10. Live provider tests are not authorized by this plan.

## Commit boundary

Mark this milestone/index complete; commit/push `feat: milestone 06 — runtime and Herdr adapters`.

## Completion record

- Completed: 2026-10-06. `src/runtimes/`: adapter contract (`contract.ts`), provider-safe error classification (`errors.ts`), version detection (`detect.ts`), Pi adapter and SDK bridge (`pi.ts`, `pi-bridge.ts`), Codex CLI adapter (`codex.ts`), Claude Code adapter (`claude.ts`), adapter registry and pane renderer (`registry.ts`), owned Herdr transport (`herdr.ts`), and per-attempt session orchestration with preflight, projection, launch, binding, event tailing, and stop (`session.ts`); launcher event capture and exit records in `src/isolation/`; tests in `tests/unit/runtimes/`.
- Documentation read before relying on APIs: installed Pi 1.0.2 docs (how-pi-works, CLI, CLI integration, JSON events, RPC, SDK, security, environment variables, settings, packages) plus SDK examples and the exported `CredentialStore`, `ModelRuntime`, and `createAgentSession` declarations; `codex --help` and `codex exec --help` (0.160.0); `claude --help` (2.1.285); `herdr --help`, pane/agent/api subcommand help, and `herdr --skill` text (0.9.1). No Herdr pane, agent, or session operation was performed.
- Implementation decisions:
  - All three runtimes run headless with structured JSONL inside the contained launcher (milestone 05) in a fresh owned Herdr pane per attempt. The launcher (outside the sandbox) appends raw records to protected state and renders a one-line summary in the pane. Workers receive a fixed first prompt pointing at the sealed brief file and the result path; no transcript is passed. Parity is reported explicitly: no interactive runtime UI and no Herdr agent detection.
  - Pi boundary: Radian's SDK bridge imports only Pi's package-root exports, injects a read-only `CredentialStore` whose `modify`/`delete` throw (Pi runs OAuth refresh inside `modify`), disables catalog network refresh, retry, compaction, and cache warming, loads no extensions/skills/prompts/context files (closing extension/MCP/codemode delegation channels), and verifies that the exact provider, model, thinking level (Pi otherwise clamps), and tool set took effect; it requires Pi's provider metadata to mark the OAuth path as subscription-backed. The Pi CLI is not used for workers because its credential reads require the refresh-capable auth lock.
  - Codex: `codex exec --json` with exact `--model`, `model_reasoning_effort`, `--sandbox read-only` for reviewers and `workspace-write` otherwise, `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, and `CODEX_HOME` set to the projection. Bypass/auto-approval/OSS/search/worktree flags are never emitted.
  - Claude Code (the only Anthropic route): `claude -p --output-format stream-json` with exact `--model`/`--effort`, a fresh `--session-id`, `--no-session-persistence`, `--safe-mode`, `--strict-mcp-config`, `--disable-slash-commands`, explicit `--tools`/`--allowedTools`, `--permission-prompts none`, `--permission-mode dontAsk`, settings denying web/Task/Agent/notebook tools, and `--restricted` for reviewers; `CLAUDE_CONFIG_DIR` points at the projection. `--bare` (API-key only), `--fallback-model`, and permission bypass flags are never used. Binding requires the init event's `apiKeySource` to be `none`.
  - Preflight order: proposal 0015 recheck → adapter/version detection (only the reviewed versions Pi 1.0.2, Codex 0.160.0, Claude Code 2.1.285 are accepted) → role tool restrictions → supervision health → every required capability verified for the detected versions. Only then are credentials projected. The pairing is rechecked again before the pane is created. Dependencies are resolved narrowly; anything missing blocks.
  - Binding is semantic: the launcher's process registration plus the runtime's own session-start and prompt-accepted events with matching session/model (and subscription auth for Claude Code). Uncertain pane-command delivery is never resent; missing evidence returns `BINDING_UNCONFIRMED`.
  - Errors are classified as quota, authentication, trust/permission, infrastructure, or unknown; reset times come only from explicit timestamp fields; summaries are bounded and scrubbed. Classification never triggers fallback.
  - Herdr transport splits an explicit parent pane with `--no-focus`, parses the returned pane ID, records ownership in protected state, runs commands only in owned panes with POSIX-quoted arguments, and closes owned panes only after verified termination.
- Checks before publication: private denylist **not supplied** (private-term coverage absent); bounded publication check and exact staged-diff review before commit. Milestone-local sanity run: `tsc --noEmit` clean; 89 unit tests passed, including an end-to-end fake Codex-format runtime launched through the real contained launcher via a simulated pane, semantic binding, verified termination, projection destruction, and pane close (not the milestone 10 run). No leftover processes were found.
- Deferred verification / limitations: SDK/CLI parity, actual runtime composition with the outer sandbox, actual authentication, binding, cancellation, and real Herdr pane behavior are unverified; every runtime's capabilities remain unverified, so real launches are refused. Event formats for Codex and Claude Code were taken from documented/observed shapes and are exercised only with fixtures. No worker or model was launched and no real credential was read.

## Requirements

[Dispatch](../../proposals/0002-worker-dispatch.md) · [Lifecycle](../../proposals/0006-lifecycle-and-improvement.md) · [Feasibility gaps](../../research/feasibility-results.md)
