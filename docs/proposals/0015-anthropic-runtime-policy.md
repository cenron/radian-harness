# 0015 — Anthropic workers through Claude Code only

**Status: explicitly requested by the user before implementation.**

## Decision and rationale

The user reported Pi's warning that Anthropic subscription authentication in a third-party harness draws from extra usage billed per token, rather than Claude plan limits. Subscription OAuth alone therefore does not satisfy the no-pay-as-you-go requirement.

- Anthropic worker models, including Opus, Sonnet, and Haiku, must run through **Claude Code only**, using its supported claude.ai subscription path.
- Anthropic through Pi, Codex CLI, custom providers/proxies, or another worker runtime is prohibited. Provider aliases and model aliases must not bypass this restriction; unresolved provider/model provenance blocks dispatch.
- Pi remains coordinator and the default worker runtime for eligible non-Anthropic subscription profiles. Codex CLI remains in scope. This is a compatibility restriction, not a fallback policy or an interchangeable-coordinator design.
- Validate the resolved runtime/provider/model pairing after every configuration override and alias resolution, then recheck immediately before credential projection and launch. Reject prohibited profiles with a structured blocker before exposing credentials or starting a worker. Do not silently rewrite the runtime to Claude Code.
- Credentials for Anthropic must not be projected into Pi or Codex workers. Claude Code subscription authentication must not fall back to API keys, custom endpoints, or separately billed provider paths.
- Claude Code is the permitted route, not evidence that an account has available plan capacity or that extra usage is disabled. Missing required authentication/billing-path evidence blocks execution. Do not enable extra usage, change account settings, suppress warnings, or promise free/unlimited usage.
- Quota exhaustion remains a blocker under the existing bounded recovery/approval policy; no automatic paid spillover, runtime/model fallback, or effort escalation.

## Implementation and verification

Milestone 02 implements profile validation and structured rejection. Milestone 05 restricts credential projection. Milestone 06 rechecks the policy at adapter preflight/launch. Milestone 10 verifies the rules using offline fixtures, including aliases, custom-provider disguises, overrides, unknown provenance, credential non-exposure, and no silent rerouting. A permitted Claude Code profile remains subject to every containment, authentication, supervision, and capability gate.

Historical feasibility/auth-readiness results are preserved; they do not override this policy or prove plan-limit billing. No new live provider/auth/model probes are authorized.

## Implementation-session handoff

The previously authorized **Opus 5.5 / high** implementation session must use **Claude Code**, not Pi's Anthropic provider. Confirm runtime/model/effort through native session state and use the supported Claude subscription path. If unavailable or the required billing path is unverified, stop; do not switch this Pi session's model/authentication or substitute another profile. This one-off harness-source implementation session does not change Pi's product coordinator role.

This amendment supersedes conflicting runtime/authentication and implementation-session instructions in proposals 0012/0014 and the earlier handoff. All other implementation, publication, approval, and safety boundaries remain unchanged.
