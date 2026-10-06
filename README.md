# Radian Harness

A Pi-native harness under implementation for agentic software engineering, maintained outside the workspaces where it is used.

**Status: unattended implementation plan authorized; feasibility testing stopped. No production harness or installer has been implemented yet, and worker-runtime support remains unverified.**

## Direction

- Extend Pi rather than replace its agent runtime or terminal interface.
- Provide a spec-driven engineering workflow with reliable worker supervision.
- Install into explicitly selected workspaces without taking over personal Pi configuration.
- Keep Pi as the coordinator; support Pi, Codex CLI, and Claude Code workers in visible Herdr panes.
- Default eligible non-Anthropic workers to Pi, with JSON task-based runtime/model/effort dispatch profiles. Anthropic models run only through Claude Code's supported subscription path; invalid pairings block without silent rerouting or paid fallback.
- Maintain durable state, worker identity, reliable delivery, healthy supervision, and safe cleanup.
- Separate human approvals, automated verification, and agent instructions.
- Enforce worker role boundaries, require resource containment by default, and require public PII/secrets checks as the publication baseline.

## Planning documents

- **[Implementation table of contents and milestones](docs/planning/implementation/README.md)** — authorized sequence, completion tracking, and commit/push contract.
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
- [Feasibility evidence and known gaps](docs/research/feasibility-results.md)
- [Technical research notes](docs/research/reference-notes.md)

Confirmed decisions are distinguished from recommendations in each proposal. Proposal 0014 authorizes implementation and milestone commits/pushes, superseding feasibility-only restrictions; proposal 0012 retains the product decisions. Full verification is scheduled at the end, while publication checks precede every push. Worker-runtime support must pass its validation gates before it is advertised.

Repository: `git@github.com:cenron/radian-harness.git`
