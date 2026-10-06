# 0017 — Interactive worker sessions; isolation deferred past the MVP

**Status: decided by the user on 2026-10-06 and implemented.** Supersedes the headless worker launch (`claude -p`, `codex exec`, the Pi SDK bridge), the macOS `sandbox-exec` containment, credential projection, and the capability verification gate described in proposals 0008/0011 and milestones 05/06. Approvals, budgets, write scopes, checks, supervision, and integration are unchanged.

## Problem

The first live run opened a Herdr pane per worker, but the pane showed a launcher-rendered event log from a headless run, so the user could not watch the real agent or step in. Making interactive sessions work inside the OS sandbox kept producing new problems: terminal access, runtime config writes, the Keychain, blocked macOS services, Herdr agent detection, tool access such as Godot, and per-version capability evidence. The user judged the isolation layer over-engineered for the MVP.

## Decision

1. **Workers work like claude-kit.** Every worker (Claude Code, Codex, or Pi) is that runtime's normal interactive session in an owned Herdr pane and its own git worktree. Radian's launcher starts it on the pane's terminal with:
   - the exact model and effort (`--model`/`--effort`; `--model` with `-c model_reasoning_effort`; `--provider`/`--model` with `--thinking`);
   - the role guide as the system prompt (`--append-system-prompt`; `-c developer_instructions`; `--append-system-prompt`);
   - the role's tool limits and a non-prompting permission mode;
   - one first message: read the brief (which includes copies of the approved spec and plan) and write `result.json` from its template.
2. **No isolation for the MVP.**
   - No `sandbox-exec`, credential projection, or capability gate.
   - Workers use the user's own runtime logins and environment, minus API-key, custom-endpoint, and proxy variables.
   - Codex keeps its own sandbox mode by role.
   - Pi workers do not load project-local Pi files or extensions, so a worker never becomes a coordinator.
3. **Binding.** The launcher registers the session's process before anything else. The attempt is bound once that process has stayed up for 1.5 seconds; a session that exits on startup is never bound.
4. **Completion.** When a complete `result.json` appears, Radian stops the session, confirms it stopped, validates the result, and closes the pane. A session that goes idle without a result stays open for the user. Execution limits, cancellation, the watcher, and supervision-loss handling are unchanged.
5. **Stepping in.** Text the user types into a worker pane is the user's guidance to that worker. It cannot approve, integrate, or change Radian state.

## Consequences

- A confused or manipulated worker can read or change files outside its worktree while it runs, limited only by its runtime's tool and permission settings. It cannot get changes into the target branch without the user's merge approval.
- Herdr agent detection is not required: the first message is passed on the command line, and completion is detected from the result file.

## Deferred

OS-level isolation (a supported replacement for the deprecated `sandbox-exec`), scoped credentials, and runtime capability verification can return after the MVP as a separate decision.
