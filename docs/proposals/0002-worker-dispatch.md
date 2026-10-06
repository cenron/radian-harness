# 0002 — Multi-runtime workers and task-based dispatch

**Status: draft design. Product direction agreed; implementation not authorized.**

## 1. Confirmed direction

- Pi is always the coordinator and the main conversation the user works with.
- Herdr is the terminal backend for visible worker panes.
- Supported worker runtimes are Pi, Codex CLI, and Claude Code.
- Pi is the default worker runtime.
- Agent runtime, model, and effort can be selected per task using Radian's JSON dispatch configuration.
- For now, ask the user before runtime/model fallback or effort escalation. Do not automatically switch after quota/auth problems or repeated failures. This policy may become configurable in a future approved revision.

This is multi-agent-runtime support, not multiple terminal backends or interchangeable coordinators. tmux, Zellij, remote hosts, and alternative coordinators are outside this direction.

## 2. Architecture boundary

```text
Human ↔ Pi + Radian coordinator
              │
              ├── Task/approval state and dispatch policy
              ├── Runtime-neutral task and result contracts
              └── Herdr pane transport
                      ├── Pi worker adapter
                      ├── Codex CLI worker adapter
                      └── Claude Code worker adapter
```

The Pi package owns coordinator tooling and can carry worker adapter resources. A non-Pi worker does not load Pi extensions. Each adapter must establish its runtime's own instructions, permissions, lifecycle reporting, session references, and result handling.

Separate these dimensions:

| Dimension | Meaning |
| --- | --- |
| Role | Developer, tester, reviewer, scout, etc. |
| Agent/runtime | Pi, Codex CLI, or Claude Code |
| Model/provider | The concrete model and connection supported by that runtime |
| Effort | Native thinking/reasoning effort supported by that runtime/model/version |
| Authority | Approved scope, tool/path constraints, and permitted operations |
| Transport | Herdr pane and agent controls |

Choosing a more capable model never grants broader authority. Using Codex models through Pi is still a **Pi worker**; selecting Codex CLI is a different runtime with different lifecycle and policy surfaces.

## 3. Proposed JSON shape

**Illustrative only. This is not a runnable configuration or finalized schema.** Model/provider strings below are placeholders to be replaced with locally configured, validated identifiers.

Use named profiles so rules select known configurations rather than inventing launch arguments:

```json
{
  "version": 1,
  "profiles": {
    "pi-default": {
      "agent": "pi",
      "provider": "configured-pi-provider",
      "model": "configured-pi-model",
      "effort": "medium"
    },
    "codex-build": {
      "agent": "codex",
      "model": "configured-codex-model",
      "effort": "high"
    },
    "claude-review": {
      "agent": "claude-code",
      "model": "configured-claude-model",
      "effort": "high"
    }
  },
  "default": "pi-default",
  "rules": [
    {
      "id": "complex-build",
      "roles": ["developer"],
      "when": "A substantial multi-file implementation or risky refactor.",
      "use": ["codex-build", "pi-default"],
      "why": "Prefer the configured coding profile for this class of task."
    },
    {
      "id": "independent-review",
      "roles": ["reviewer"],
      "when": "Review a candidate for correctness and architecture risks.",
      "use": ["claude-review", "pi-default"],
      "why": "Use an independent review profile."
    }
  ],
  "selection": {
    "strategy": "coordinator",
    "onUnavailable": "ask"
  }
}
```

The profile choices are examples of user preference, not claims that one vendor is always better for a role. Independence still requires fresh context and evidence; using another vendor alone does not establish it.

### Routing semantics

Separate intent judgment from mechanical profile validation. A classifier service or quota resolver is not required for initial routing.

Use intent-based rules with named profiles, stable rule IDs, explicit Pi defaults, and auditable resolutions. Array semantics must be explicit: in the draft above an array is a candidate set for coordinator selection, **not** an automatic failover order. Fallback requires its own approved policy.

## 4. Resolution flow

1. Snapshot the effective routing configuration for the run.
2. Respect an explicit user task override, then an approved plan assignment, then applicable rules, then the default. All choices remain subject to authority and capability checks.
3. Apply exact role/project restrictions in code. Pi interprets natural-language `when` conditions and chooses among configured candidates; it records the rule/profile and rationale. Ambiguous matches must be disclosed, not hidden behind undefined ordering.
4. Resolve model aliases/provider configuration and validate runtime availability, authentication readiness, effort support, and required policy capabilities without logging credentials.
5. Persist the requested and resolved profile, runtime version, available model provenance, role, authority, task/attempt identity, and config revision before dispatch. If the actual served model is not observable, record it as unverified rather than claiming certainty.
6. Build a validated native argument vector through the adapter; never execute a model-generated shell launch string.
7. Launch through Herdr and establish semantic lifecycle and the shared task/result contract.

Natural-language routing is judgment-based, not guaranteed deterministic. A future structured selector can support reproducible matching by role, risk, task type, or project. It should not require another classification service merely to dispatch a worker.

## 5. Adapter contract and capability checks

| Concern | Each runtime adapter must establish |
| --- | --- |
| Preflight | Supported CLI version, model/profile validity, authentication readiness, trust/approval blockers |
| Launch | Explicit model/effort, role instructions, cwd/worktree, policy resources, task identity |
| Lifecycle | Native or integration-backed activity/settlement and session identity; unknown when evidence is insufficient |
| Authority | Enforce the required role/phase policy using supported runtime controls or an external restriction |
| Result | Validated shared result envelope with report/evidence pointers; no dependency on rendered terminal text |
| Control | Scoped interrupt/cancel/resume operations with verified postconditions |
| Recovery | Reject stale generations, preserve work, re-establish role configuration and authorization |
| Accounting | Usage/cost provenance where supported; missing measurements remain unknown, not zero |

Concrete Codex and Claude Code CLI, sandbox, hook, and structured-output contracts must be researched against selected supported versions before implementation. Herdr recognizing an agent kind does not prove adapter parity.

In particular, Pi's `tool_call` interception cannot protect a separate Codex or Claude process. Prompts and a common report schema do not substitute for that enforcement. If a runtime cannot satisfy a required role restriction, reject that assignment, use an explicitly authorized suitable runtime, or require a stronger isolation boundary. Never silently downgrade a reviewer to unrestricted access.

The coordinator independently verifies check evidence and candidate identity; a syntactically valid worker result is not proof of correctness.

See [safety design](0003-safety-and-publication.md) for the shared role policy, adapter enforcement requirements, publication checks, and open isolation decisions.

## 6. Switching, fallback, and escalation

- Select different profiles freely for different tasks within approved policy.
- Model/effort escalation within a task requires explicit user approval for now, with the approved change recorded. A retry budget alone does not authorize escalation.
- Runtime switching mid-task creates a **new attempt**, not a pretend continuation of the other runtime's native conversation.
- Before replacement, quiesce the old worker, revoke its authority, preserve its diff/evidence, and establish a clean handoff. If its stopped state cannot be proven, block concurrent replacement writes.
- Handoff context comes from the approved brief and durable artifacts, not a complete pasted transcript.
- A missing CLI, auth failure, quota error, or unsupported effort must be surfaced. Unknown quota must not be treated as available capacity.
- Current agreed policy: ask before falling back to a different runtime/model. Candidate lists do not authorize automatic fallback. Optional pre-approved fallback lists are a future design possibility, not enabled behavior.
- Dispatch config edits affect future decisions, not silently rewrite the configuration of running attempts. Decide when a plan's assigned profile change needs renewed approval.
- Switching providers may change data exposure and cost; project policy can prohibit certain providers even when the CLI is installed.

Quota-aware selection is a useful later addition if reliable account-specific measurements exist. Do not make a quota service a mandatory dependency for the first version.

## 7. Delivery and verification

Build one end-to-end Pi worker path first, then implement Codex and Claude Code adapters against the same contract. All three are in the agreed product scope; sequencing is not a Pi-only scope reduction.

A runtime is supported only after contract tests and targeted live verification cover launch, role restrictions, explicit model/effort, task identity, native session recovery, results, cancellation, stale events, and bounded failure. Test unavailable agents/auth and unsupported effort as well as the happy path.

## 8. Open decisions

- Final schema and names; shared workspace defaults versus project overrides.
- Whether rule arrays are coordinator-selected candidates, explicit priority lists, or quota-balanced sets.
- Future policy evolution: fallback/escalation requires user approval now; any pre-authorized alternative must be explicitly agreed later.
- Per-task and per-run spending/retry limits, plus provider/privacy restrictions.
- Exact supported versions and enforcement capabilities for each runtime.

## References

- [Overall direction and supervision principles](0001-direction.md)
- [Reference research and inspected revisions](../research/reference-notes.md)
