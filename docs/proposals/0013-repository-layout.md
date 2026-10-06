# 0013 — Recommended repository layout

**Status: proposal requested during feasibility; not yet an instruction to scaffold the full harness.**

## 1. Design goals

Make declarative configuration, worker responsibilities, guidance, executable code, and tests easy to distinguish. Use Pi's familiar resource names at the top level. Keep private project/run data outside the public source repository. Avoid creating empty layers before they have a purpose.

## 2. Recommended layout

```text
radian-harness/
├── AGENTS.md
├── README.md
├── package.json                  package metadata and Pi resource declarations
├── config/
│   ├── harness.json              defaults: concurrency, timeout, execution policy
│   ├── dispatch.json             named runtime/model/effort profiles and task rules
│   └── schemas/                  config validation schemas, when needed
├── workers/
│   ├── developer.md
│   ├── tester.md
│   ├── reviewer.md
│   └── scout.md
├── extensions/
│   └── radian.ts                 thin Pi extension entry point
├── src/
│   ├── coordinator/              approvals, lifecycle, dispatch, reservations
│   ├── runtimes/                 Pi, Codex, Claude adapters
│   ├── isolation/                native macOS boundary and scoped policy
│   ├── workspace/                binding and owned install/update/remove operations
│   ├── metrics/                  event/provenance aggregation and reports
│   └── ui/                       Calm, mode switch, status/decisions
├── skills/
│   └── <skill-name>/SKILL.md      guidance/playbooks, not enforcement
├── prompts/                      reusable PRD, planning, review, retrospective prompts
├── scripts/                      thin maintenance/check entry points only
├── tests/
│   ├── feasibility/              current disposable native probes
│   ├── unit/
│   ├── integration/
│   └── fixtures/                 neutral synthetic data only
└── docs/
    ├── planning/
    ├── proposals/
    └── research/
```

This is a target organization, not a requirement to create every folder now. Release/user documentation can be added when behavior exists.

## 3. Placement rules

- `config/` holds public, non-secret shipped defaults. Worker ceiling and timeout belong in `harness.json`; routing profiles/rules belong in `dispatch.json`. Never duplicate the same setting across files.
- User workspace/project overrides live in those explicitly bound targets, not as personal edits to the harness source. Validate/resolve overrides and snapshot effective config for each run. Exact precedence remains to be specified.
- `workers/` holds runtime-neutral role contracts. Runtime-specific launch/enforcement lives in `src/runtimes/`, not duplicated per vendor in role documents.
- `extensions/` exposes Pi integration; reusable/testable behavior lives in `src/`. Avoid both a parallel `lib/` and `src/` hierarchy without a concrete reason.
- `skills/` contains agent-readable procedures; `prompts/` contains reusable starting briefs. Neither owns approval/containment enforcement.
- `src/workspace/` owns installer logic; `scripts/` is not a second application implementation. Final executable entry point/command names depend on the agreed package mechanism.
- Worktrees, approvals, runtime sessions, reports, metric records, raw logs, credentials, and effective private configuration belong in target workspace/project runtime storage with role-appropriate permissions, never in public harness `config/` or fixtures.
- Config key names, worker templates, and package metadata are written only as their milestone requires. The current feasibility test does not imply a finalized production sandbox.

## Related proposals

- [Workspace binding](0010-workspace-binding.md)
- [Authorized checkpoint](0012-review-resolution.md)
