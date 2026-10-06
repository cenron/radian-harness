# Milestone 08 — Pi coordinator interface

**Status: complete** · Depends on: 07

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

- Completed: 2026-10-06. Thin package entry `extensions/radian.ts` (with ambient declarations for host-provided packages in `extensions/host-modules.d.ts`) over `src/ui/`: interface controller with user commands, model-callable tools, mode switching, human-only decisions, status and widgets (`controller.ts`), composition root for managed sessions and runs (`session.ts`), managed editor (`editor.ts`), Calm renderer and preference (`calm.ts`), coordinator tool guard (`guard.ts`), and structural host types (`pi-host.ts`). Workspace layout conventions (`src/workspace/layout.ts`) and an updated binding check (`src/state/binding.ts`); coordinator `pause`, live-assignment listing, and required-check evidence. `package.json` now declares the extension, the `pi-package` keyword, and optional `"*"` peer dependencies for Pi's host packages. Tests in `tests/unit/ui/`.
- Documentation read before relying on APIs: installed Pi 1.0.2 extensions, TUI, keybindings, slash commands, packages, and security docs; the plan-mode, modal-editor, minimal-mode, and built-in-tool-renderer examples; exported `ExtensionAPI`, `ToolRenderers`, `InputSource`, `ExtensionContext`, and `CustomEditor` declarations; and the extension runner's shortcut-conflict rules.
- Implementation decisions:
  - Shift+Tab: Pi reserves `shift+tab` for `app.thinking.cycle`, so an extension shortcut would be skipped. Radian instead installs, only in managed sessions, a subclass of Pi's public `CustomEditor` (the documented modal-editor pattern) that consumes Shift+Tab for Plan/Build and forwards every other key — Tab autocomplete and all app actions included — to the base editor. Personal `keybindings.json` is never edited; the default editor is restored on shutdown. Native `/thinking` stays available; no alias was added.
  - Managed sessions start in Plan, show PLAN/BUILD and live-worker counts in the status line, and list tasks, assignments, and open decisions in a widget. Entering Plan immediately blocks new modifying dispatch; live modifying workers are paused (stopped with work preserved and a resume decision) only after an interactive confirmation; noninteractive sessions leave them running.
  - Calm uses `registerToolRenderer` only: tool calls stay visible; successful, non-partial, unexpanded results collapse to one muted line; errors, partial output, expanded views, messages, approvals, and blockers are untouched. Execution tools are never replaced. The preference lives in Radian's project state, not personal settings.
  - Approvals, rejections, decisions, integration, round grants, recovery authorizations, and retrospective decisions are `/radian` user commands only. Each requires an interactive TUI, rejects RPC/extension-originated input, and asks for an explicit confirmation that shows the exact artifact hash (and, for integration, candidate, target, checks, review, risks, and gaps). Without an interactive UI they return `NONINTERACTIVE_APPROVAL_REQUIRED`; nothing is fabricated.
  - Model-callable tools are `radian_status`, `radian_write_artifact` (drafts under `.radian/planning/` only; writing never approves), `radian_dispatch` (validated plans; runs in the background through the orchestrator with all its guards and reports the outcome), and `radian_assemble`.
  - The coordinator guard (both modes) allows read/search tools, Radian tools, planning-artifact writes, and a narrow set of simple read-only commands without shell metacharacters; it blocks production edits, other shell commands, MCP/codemode, and unknown tools with stable rule IDs. It is a mistake/prompt-injection guard inside Pi, not an OS boundary.
  - Runs start only on explicit user action (`/radian start`) and require a registered protected target, a configured Git commit identity, a Herdr pane, and the project lease; the independent watcher starts with the run. On shutdown with live workers the heartbeat is dropped so supervision loss stops owned work (preserving it); otherwise the watcher is released.
  - Workspace layout: Radian state for each project lives under `<workspace>/.radian/projects/<id>/` outside every checkout; the binding check requires exactly one enclosing workspace whose record matches its location and exactly one registry entry for the project's canonical path.
- Checks before publication: private denylist **not supplied** (private-term coverage absent); bounded publication check and exact staged-diff review before commit. Milestone-local sanity run: `tsc --noEmit` clean (the extension type-checks against Radian's structural host declarations); full unit suite passed, including eight interface tests with a fake Pi host (not the milestone 10 run).
- Deferred verification / limitations: public-API compatibility with a real Pi process (extension load, editor replacement, renderer coverage, slash-command input events) and final UI contract verification are deferred to milestone 10 and live interactive behavior is not claimed. Another extension that also replaces the editor would conflict with the managed editor. Whether slash commands emit `input` events is unverified; approvals therefore also require the TUI confirmation dialog.

## Requirements

[Interface](../../proposals/0007-interface-and-finalization.md) · [Superseding decisions](../../proposals/0012-review-resolution.md) · [Safety](../../proposals/0003-safety-and-publication.md)
