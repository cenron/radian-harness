# 0014 — Unattended implementation authorization

**Status: explicitly requested and authorized by the user after stopping feasibility testing.**

## Confirmed instructions

- Stop the feasibility-testing phase; do not continue its experimental agenda.
- Prepare an implementation plan with a table of contents and a separate file for each milestone.
- A new session will use **Claude Code / Opus 5.5 at high effort** for implementation. [Proposal 0015](0015-anthropic-runtime-policy.md) amends the runtime requirement after the user's Pi extra-usage warning; do not run this Opus session through Pi.
- Implementation should proceed without routine interaction.
- Mark each milestone complete as it finishes; commit and push each milestone.
- Run full verification at the end.
- Commit and push the implementation plan now, then provide a prompt for the new session.

The executable handoff is [the implementation index](../planning/implementation/README.md). The preserved feasibility evidence is [here](../research/feasibility-results.md).

## Scope and interpretation

This authorization supersedes the feasibility-only implementation restriction and the earlier requirement to obtain a separate push approval for every later repository milestone. It authorizes development and milestone commits/pushes to this repository's existing upstream. It does not authorize releases, installing into target workspaces, operating production systems, discarding user work, or force-pushing.

Unattended implementation means the session may resolve ordinary reversible coding details within this plan without asking. It does not grant missing product approvals, weaker containment, additional model/runtime profiles, authentication changes, live provider tests, or host-global/elevated changes. On a material safety or authorization blocker, preserve evidence and stop with a sanitized blocker record rather than interactively prompting or bypassing the requirement.

Full verification is deferred to the final milestone. Publication scans and exact staged-content review still precede every push. The user previously required public safety scanning; deferring that until after public pushes would defeat its purpose. A private denylist is currently absent: disclose the missing private-term coverage rather than claiming it or creating personal values in the repository.

All three runtimes remain in product scope. Their adapters may be implemented now, but unsupported capabilities stay disabled/fail-closed until demonstrated. Completion of implementation is separate from successful verification and runtime/release support. Prior native-sandbox and subscription evidence remains preliminary; do not convert it into a support claim.

## Known implementation constraints

- Pi CLI credential reads require auth-lock creation. Denying that lock blocks startup; allowing it does not by itself prevent refresh. A public SDK injected read-only `CredentialStore` contract passed offline synthetic tests. Decide the actual Pi bridge deliberately; report SDK/CLI and interactive/JSON parity separately.
- Independent credential projections can diverge under token rotation. Implement explicit ownership and refusal paths before concurrent or long-running authenticated workers rely on them. No silent personal-store overwrite.
- Group cancellation misses detached children. Independent supervision and owned-resource reconciliation are necessary; ambiguous ownership/termination must block replacement.
- Native `sandbox-exec` is deprecated. Availability is not complete containment. No automatic weaker mode, proxy, or stronger-isolation architecture is approved.
- Herdr detection/idle is not authentication, assignment binding, completion, or termination evidence.

## Related decisions

- [0012 — Product decisions and historical feasibility authorization](0012-review-resolution.md)
- [0013 — Repository layout](0013-repository-layout.md)
- [Implementation plan and execution contract](../planning/implementation/README.md)
