# Repository working agreement

## Current phase: MVP, workers like claude-kit

- The user chose an MVP in which each worker is the normal interactive session of its runtime (Claude Code, Codex, or Pi) in its own Herdr pane and git worktree, started with the right model, effort, and role system prompt (proposal 0017). Worker OS isolation (sandbox-exec), credential projection, and capability verification were removed on the user's instruction and are deferred past the MVP. Do not reintroduce them without a new user decision.
- Workers use the user's own runtime logins and environment, minus API-key, custom-endpoint, and proxy variables. Radian's remaining guards stay: human approvals bound to artifact revisions, the revision-bound start gate, approved write roots for delivery, required checks from the approved plan, candidate cycle limits, supervision and verified stop, and merge only after the user's approval.
- Read `docs/planning/session-handoff.md` for the current checkpoint. Historical milestones (01–10), remediation (R01–R08), and workspace-first (W01–W07) records are history; do not replay them.
- Fix defects with a failing regression first, then the fix; run the targeted tests, then typecheck, unit, and integration suites. Publication scans, staged-content/metadata review, and whitespace checks precede every push. Commit and push only when the user asks. No force-push, release/tag/package publication, or unrelated Git changes.
- Ordinary reversible implementation choices are delegated. Distinguish implementation from verification; never mark incomplete work complete.
- Runtime/model fallback and effort escalation require explicit approval. Use supported subscription paths only, not API-key/pay-as-you-go or paid extra-usage billing. Anthropic worker models require Claude Code exclusively; reject other runtime pairings and unknown provider provenance before launch, without silent rerouting. No direct provider endpoint probes. Native `/thinking` remains sufficient; no alias.
- Do not manipulate unrelated Herdr panes/processes. The user's `pi-workspace` is a throwaway test workspace; drive it only when the user asks. Preserve dirty/unintegrated work.
- Keep public material free of PII, secrets, machine-specific details, and private project artifacts. Private denylist values/raw auth diagnostics stay outside this repository. Disclose absent private-denylist coverage.
- Read installed Pi documentation/examples completely and follow relevant cross-references before implementing Pi integrations. Use supported public APIs and preserve required third-party licenses/attribution.

## Product boundary

Radian Harness is maintained separately from target workspaces and uses Pi's extensibility for local agentic engineering. Pi remains coordinator and primary chat. Anthropic models use Claude Code only; OpenAI models run through Pi or Codex by explicit profile choice; JSON profiles select runtime, model, and effort. Herdr is the terminal backend. Execution targets macOS with Git worktrees. OS-level worker isolation is deferred past the MVP.

Default concurrency is three active workers across the installed workspace, configurable with multiple workers per role. Tasks have three total candidate rounds; assignments have bounded recovery and execution time. Fresh worker contexts, revision-bound user approvals, launcher-run candidate checks, and exact verified integration are required.

Radian is independent; keep requirements and public documentation self-contained. Future third-party code reuse must preserve required licenses and attribution.
