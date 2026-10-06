# Milestone 08 — Pi coordinator interface

**Status: pending** · Depends on: 07

## Objective

Expose the coordinator through supported Pi extension surfaces without replacing Pi or weakening product authority.

## Deliverables

- Thin `extensions/radian.ts` package entry point backed by reusable `src/` services.
- Explicit user-facing run/status/approve/dispatch/pause/cancel/resume/integrate/retrospective controls with stable names and sanitized summaries.
- Visible Plan/Build status, Shift+Tab switching, ordinary Tab autocomplete, and unchanged native `/thinking`.
- `/calm` presentation-only behavior using documented rendering surfaces; substantive answers, decisions, blockers, failures, activity, approvals, and durable state remain intact.
- Coordinator tool restrictions that deny routine target production writes in both modes while permitting approved planning artifacts and narrow controlled integration.
- Noninteractive behavior that blocks on missing product approvals and does not fabricate dialog responses.

## Implementation tasks

1. Read installed Pi extension, TUI, keybinding, security, package, and relevant example docs completely. Use public APIs; document version-specific limitations rather than undocumented monkey-patching.
2. Make the extension a thin integration layer, not a second lifecycle database or duplicate orchestrator.
3. Keep approval writers behind explicit human commands/UI. Do not expose them as model-callable tools or interpret assistant/worker text as human consent.
4. Start managed runs in Plan. Returning to Plan immediately denies new modifying dispatch; display live work and request human confirmation before pausing existing modifying workers. In noninteractive mode, preserve those live workers unless a prior scoped pause authority or safety-loss condition applies.
5. Register Shift+Tab only for managed sessions, with reversible settings/shortcuts and no implicit takeover of personal keybindings. Do not add a thinking/effort alias.
6. Implement Calm through verified presentation hooks, not execution-tool replacement or model-context deletion. Preserve input ordering, session/export data, logs, authorization, and runtime execution.
7. Keep meaningful worker evidence references/identity, pending approvals/questions, and blocked/unknown states visible. Do not make an idle indicator mean complete.
8. Add role-safe registered tools for plan/brief/artifact/status operations; cover user shell/nested/MCP channels or disable unsupported paths. Missing guards block controlled actions.
9. Author extension/TUI fakes for human-only approval, mode dispatch guards, live pause confirmation, keybinding restoration, calm invariance, reload/resume, and no-UI execution.

## Completion criteria

- Pi entry point/package metadata match real resource files.
- UI changes are reversible and cannot change task authority or silently approve work.
- No production target session is modified or worker launched. Full automated verification is deferred to 10.
- Run publication checks before push; do not advertise unverified rendering/runtime parity.

## Commit boundary

Mark this milestone/index complete; commit/push `feat: milestone 08 — Pi coordinator interface`.

## Completion record

- Completed: not yet
- Implementation decisions: not yet
- Checks before publication: not yet
- Deferred verification / limitations: public-API compatibility and final UI contract verification

## Requirements

[Interface](../../proposals/0007-interface-and-finalization.md) · [Superseding decisions](../../proposals/0012-review-resolution.md) · [Safety](../../proposals/0003-safety-and-publication.md)
