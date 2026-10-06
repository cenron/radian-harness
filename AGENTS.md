# Repository working agreement

## Current phase: approved feasibility milestone

- Read `docs/planning/session-handoff.md` and linked proposals before continuing. Proposal 0012 is the latest decision and authorization checkpoint; it supersedes historical planning-only status notes.
- The user explicitly finalized the plan and authorized the first bounded feasibility milestone. Commit and push the planning baseline first, then begin feasibility work.
- Validate native macOS containment, runtime authentication/refresh, worktree/Git restrictions, candidate execution, Herdr launch/detection, and termination/supervision loss in disposable fixtures. Report go/no-go findings before full runtime tooling relies on an unproven boundary.
- Do not silently broaden this milestone into a complete harness, installer, or installation into target workspaces. Stronger isolation, weaker containment exceptions, or product-scope changes require explicit approval.
- Distinguish confirmed decisions, recommendations, unresolved details, and observed test evidence.
- Use isolated test sessions for Herdr feasibility; do not manipulate unrelated user panes. Preserve evidence and unfinished work before cleanup.
- Runtime/model fallback and effort escalation require explicit user approval. Native `/thinking` is sufficient; do not add an alias.
- Push/publication requires user approval. The initial baseline commit and push are explicitly authorized; subsequent pushes need approval.
- Keep repository/public material free of PII, secrets, machine-specific details, and private project artifacts. Require public PII/secrets/machine-detail scanning; private denylist values and raw auth diagnostics stay outside this repository. Scanner/hook integration has not been implemented yet.

## Product boundary

Radian Harness is maintained separately from target workspaces and uses Pi's extensibility for local agentic engineering. Pi remains coordinator and primary chat. Workers use Pi by default, with Codex CLI and Claude Code also in scope; JSON profiles select runtime, model, and effort. Herdr is the terminal backend. Initial execution targets macOS with Git worktrees and native OS containment. Required containment is fail-closed, with explicit scoped user-approved exceptions only.

Default concurrency is three active workers across the installed workspace, configurable with multiple workers per role. Tasks have three total candidate rounds; assignments have bounded recovery and execution time. Fresh worker contexts, revision-bound user approvals, contained candidate checks, and exact verified integration are required.

Radian is independent; keep requirements and public documentation self-contained. Future third-party code reuse must preserve required licenses and attribution.
