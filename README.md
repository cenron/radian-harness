# Radian Harness

A Pi-native harness under implementation for agentic software engineering, maintained outside the workspaces where it is used.

**Status: MVP.** Install into an empty workspace, then create, select, and switch projects in one Pi interface. Workers run like claude-kit: each is the normal interactive session of its runtime in its own Herdr pane and git worktree, with the right model, effort, and role prompt. Worker isolation (an OS sandbox) and capability verification were removed for the MVP and are deferred ([proposal 0017](docs/proposals/0017-interactive-worker-sessions.md)). No release exists.

| Runtime | Worker session | Offline evidence |
| --- | --- | --- |
| Claude Code (only route for Anthropic models; the default) | interactive `claude` | Emitted flags match the installed CLI |
| Codex CLI | interactive `codex` | Emitted flags match the installed CLI |
| Pi (non-Anthropic subscription profiles) | interactive `pi` | Emitted flags match the installed CLI |

- **[User and operations guide](docs/user/README.md)** — installing into a workspace, configuration, the Pi interface, how workers run, workflow, budgets, diagnostics, and limitations.
- [Release acceptance checklist](docs/user/release-acceptance.md) and [development guide](docs/development.md).

## Direction

- Extend Pi rather than replace its agent runtime or terminal interface.
- Provide a spec-driven engineering workflow with reliable worker supervision.
- Install into explicitly selected workspaces without taking over personal Pi configuration.
- Keep Pi as the coordinator; support Pi, Codex CLI, and Claude Code workers in visible Herdr panes.
- Default eligible non-Anthropic workers to Pi, with JSON task-based runtime/model/effort dispatch profiles. Anthropic models run only through Claude Code's supported subscription path; invalid pairings block without silent rerouting or paid fallback.
- Maintain durable state, worker identity, reliable delivery, healthy supervision, and safe cleanup.
- Separate human approvals, automated verification, and agent instructions.
- Enforce worker role boundaries through tool sets and approved write scopes (OS-level isolation is deferred past the MVP), and require public PII/secrets checks as the publication baseline.

## Planning documents

- **[Workspace-first implementation plan](docs/planning/workspace-first/README.md)** — current W01–W07 sequence, same-interface project control, final safety corrections, and offline verification.
- [Original implementation milestones](docs/planning/implementation/README.md) — historical completion records; do not replay.
- **[Start here for the next session](docs/planning/session-handoff.md)** — current authorization, saved evidence, and handoff.
- [Initial proposal and open decisions](docs/proposals/0001-direction.md)
- [Multi-runtime workers and task-based dispatch](docs/proposals/0002-worker-dispatch.md)
- [Worker guardrails and public-harness safety](docs/proposals/0003-safety-and-publication.md)
- [Sub-agent roles and round limits](docs/proposals/0004-subagent-design.md)
- [Task and result contracts](docs/proposals/0005-task-contract.md)
- [Lifecycle, recovery, and improvement](docs/proposals/0006-lifecycle-and-improvement.md)
- [Coordinator interface and finalization](docs/proposals/0007-interface-and-finalization.md)
- [Local macOS execution and worktrees](docs/proposals/0008-local-isolation.md)
- [Approval validity, integration, and cleanup](docs/proposals/0009-approval-and-integration.md)
- [Workspace installation and removal](docs/proposals/0010-workspace-binding.md)
- [Installer operations and release acceptance](docs/proposals/0011-installer-and-release-acceptance.md)
- [Review resolution and readiness checkpoint](docs/proposals/0012-review-resolution.md)
- [Repository layout](docs/proposals/0013-repository-layout.md)
- [Unattended implementation authorization](docs/proposals/0014-unattended-implementation.md)
- [Anthropic workers through Claude Code only](docs/proposals/0015-anthropic-runtime-policy.md)
- [Implementation verification and capability checkpoint](docs/research/implementation-verification.md)
- [Feasibility evidence and known gaps](docs/research/feasibility-results.md)
- [Technical research notes](docs/research/reference-notes.md)

Confirmed decisions are distinguished from recommendations in each proposal. Proposal 0014 authorized implementation and milestone commits/pushes; proposal 0012 retains the product decisions. Worker-runtime support must pass its validation gates before it is advertised.

Repository: `git@github.com:cenron/radian-harness.git`
