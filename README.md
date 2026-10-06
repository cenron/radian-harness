# Radian Harness

A proposed Pi-native harness for agentic software engineering, maintained outside the workspaces where it is used.

**Status: plan approved; first feasibility milestone authorized. No harness or installer has been implemented yet.**

## Direction

- Extend Pi rather than replace its agent runtime or terminal interface.
- Provide a spec-driven engineering workflow with reliable worker supervision.
- Install into explicitly selected workspaces without taking over personal Pi configuration.
- Keep Pi as the coordinator; support Pi, Codex CLI, and Claude Code workers in visible Herdr panes.
- Default workers to Pi, with JSON task-based runtime/model/effort dispatch profiles.
- Maintain durable state, worker identity, reliable delivery, healthy supervision, and safe cleanup.
- Separate human approvals, automated verification, and agent instructions.
- Enforce worker role boundaries, require resource containment by default, and require public PII/secrets checks as the publication baseline.

## Planning documents

- **[Start here for the next session](docs/planning/session-handoff.md)** — agreed decisions and the sub-agent discussion agenda.
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
- [Technical research notes](docs/research/reference-notes.md)

Confirmed decisions are distinguished from recommendations in each proposal. The user has finalized the plan and authorized the first bounded feasibility milestone; proposal 0012 supersedes historical planning-only status notes. Worker-runtime support must pass the stated validation gates before it is advertised.

Repository: `git@github.com:cenron/radian-harness.git`
