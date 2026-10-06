# Repository working agreement

## Current phase: authorized unattended implementation

- Read `docs/planning/session-handoff.md`, proposals 0014–0015, and `docs/planning/implementation/README.md` before continuing. Proposal 0014 supersedes feasibility-only authorization and later-push restrictions; proposal 0012 remains the product decision checkpoint.
- The user stopped feasibility testing and authorized a new Claude Code Opus 5.5/high session to implement the milestone plan without routine interaction. Confirm that model/effort through native session state; if unavailable, stop rather than fall back or change authentication/effort.
- Implement milestones in order, mark each complete in its file and the index, then commit and push each milestone to the existing upstream. The planning/feasibility checkpoint commit and push are authorized now. No force-push, release/tag/package publication, or unrelated Git changes.
- Write tests alongside implementation; defer full behavioral/build verification to the final milestone. Publication scans, staged-content/metadata review, and minimal whitespace checks still precede every push.
- Ordinary reversible implementation choices are delegated. On a material safety/authorization blocker, preserve work, record a sanitized blocked milestone, and stop without interactive approval or bypass. Do not mark incomplete work complete.
- Harness-source implementation is authorized; installation into target workspaces, host-global/elevated operations, stronger isolation, weaker containment exceptions, live provider/model/auth probes, and product-scope expansion are not.
- Keep actual worker execution fail-closed on missing/unverified capabilities. Previous synthetic feasibility evidence does not prove supported runtime containment/auth/refresh/cancellation. Distinguish implementation completion from verification and runtime/release support.
- Runtime/model fallback and effort escalation require explicit approval. Use supported subscription paths only, not API-key/pay-as-you-go or paid extra-usage billing; OAuth alone does not prove plan-limit usage. Anthropic worker models require Claude Code exclusively; reject other runtime pairings and unknown provider provenance before credential projection/launch, without silent rerouting. No direct provider endpoint probes. Native `/thinking` remains sufficient; no alias.
- Do not manipulate unrelated Herdr panes/processes. Preserve dirty/unintegrated work and private evidence; use disposable fixtures only during authorized final verification.
- Keep public material free of PII, secrets, machine-specific details, and private project artifacts. Private denylist values/raw auth diagnostics stay outside this repository. Disclose absent private-denylist coverage; scanner/hooks/CI are to be implemented in milestone 01.
- Read installed Pi documentation/examples completely and follow relevant cross-references before implementing Pi integrations. Use supported public APIs and preserve required third-party licenses/attribution.

## Product boundary

Radian Harness is maintained separately from target workspaces and uses Pi's extensibility for local agentic engineering. Pi remains coordinator and primary chat. Workers use Pi by default for eligible non-Anthropic subscription profiles; Anthropic models use Claude Code only. Codex CLI and Claude Code remain in scope; JSON profiles select runtime, model, and effort. Herdr is the terminal backend. Initial execution targets macOS with Git worktrees and native OS containment. Required containment is fail-closed, with explicit scoped user-approved exceptions only.

Default concurrency is three active workers across the installed workspace, configurable with multiple workers per role. Tasks have three total candidate rounds; assignments have bounded recovery and execution time. Fresh worker contexts, revision-bound user approvals, contained candidate checks, and exact verified integration are required.

Radian is independent; keep requirements and public documentation self-contained. Future third-party code reuse must preserve required licenses and attribution.
