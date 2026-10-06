# Adversarial plan review — pre-implementation checkpoint

**Status: reviewer findings and coordinator synthesis, not newly approved requirements. Implementation remains unauthorized.**

## Review provenance

The user explicitly authorized a Herdr review pane for this planning checkpoint, superseding the no-planning-panes rule for this one review only. Claude Code `2.1.285` was launched with `claude-opus-5-5` and high effort; its visible banner displayed Opus 5.5 with high effort. These are requested/displayed values, not independent provider-side model attestation.

The reviewer had only Read/Glob/Grep tools in restricted mode, with no configured MCP servers or shell/write tools. It reported reading README, AGENTS, the handoff, proposals 0001–0011, and technical notes (15 files), with no modifications. No live containment/authentication/denial tests were performed. Native tool restriction for this review is not validation of the eventual harness's OS containment.

## Reviewer verdict

**NOT READY** for unrestricted implementation against the current plan. Product direction is coherent, but boundary and lifecycle decisions should be resolved before code depends on them. A bounded feasibility-first implementation stage could become READY WITH CONDITIONS after user decisions and explicit authorization.

## Findings to resolve before relying on the architecture

1. **Containment and network policy (critical):** no concrete verified OS boundary for the default Pi worker. Native network switches do not establish destination-level enforcement. Decide primary mechanism, failure behavior, and whether network allowlisting is enforced or merely policy. No silent downgrade; deprecated sandbox-exec is not automatically unusable, but availability is not proof.
2. **Shared Git metadata (critical):** broad Git metadata write access can modify hooks/config and influence later coordinator Git execution. Define permitted worker Git operations; consider patch delivery with coordinator-owned commits. Keep hooks/config/other-task refs protected and ensure controlled Git operations do not execute worker-influenced helpers/hooks.
3. **Candidate execution owner (high):** explicitly require builds/tests/installers for assembled candidates to run inside contained assignments, not unrestricted coordinator execution. Assignments consume worker capacity.
4. **Human approvals and coordinator writes (high):** specify user-only commands/UI as approval writers, revision/hash binding and change handling, who chooses lightweight briefs, and production-path denial for coordinator tools. Review data must never grant integration authority.
5. **Coordinator loss (high):** choose worker stop/pause on exit versus a minimal independent watchdog. Graceful shutdown alone does not cover crashes; enforce loss-of-supervision behavior. Deferred quota retry needs healthy supervision.
6. **Exact integration (high):** define a controlled Git operation that preserves the verified candidate. Reviewer recommends fast-forward to the exact verified commit with target/dirty-state checks; do not silently squash/rebase/stash into an unverified result.
7. **Tab with active workers (medium-high):** accidental mode switching can stop live workers. Reviewer proposes confirmation before pausing active workers while immediately blocking new dispatch. This changes a confirmed interaction and requires user agreement.

## Validation gates before support claims

8. Runtime authentication/refresh inside the selected boundary, including Keychain/file access and credential separation.
9. Worker resource/policy loading from coordinator-owned paths, without candidate pollution or worker-writable enforcement config; project trust behavior.
10. Proven termination of subprocesses/daemonized children; process groups alone are not a comprehensive guarantee.
11. Runtime/native sandbox composition and Herdr launch/detection compatibility.

## Accounting and documentation findings

12. Clarify human-approved quota relaunch versus automatic recovery allowance; start execution time at confirmed assignment binding rather than while queued; insufficient remaining time should block rather than silently extend the budget. Define conflict/test-defect round accounting.
13. Workspace-wide reservations need cross-coordinator locking, identity/heartbeat reconciliation, and safe reclaim. Decide duplicate project registration across workspaces.
14. Consolidate superseded early draft statements: stale sub-agent agenda, configurable versus fixed round cap, already-settled open questions, mandatory testing/review per candidate cycle versus optional role use. Define run/task/assignment/attempt state levels.
15. Paused runs need pinned harness/config artifacts or an explicit migration policy so updates do not silently change resumed authority.

## Simplification opportunities

16. Minimize installer ownership (avoid AGENTS.md edits); ship metric provenance/raw events/simple per-version summaries before elaborate comparative analysis. Clarify whether an incremental release may label an unvalidated runtime unsupported without dropping it from agreed product scope. These are recommendations, not scope changes approved by the review.

## Coordinator synthesis

Most issues can be resolved by short policy choices, not a larger architecture. Some reviewer wording is stronger than the evidence: deprecation does not itself prove sandbox failure; scoped Git writes need not grant the entire shared metadata tree; existing ask-first/fail-closed policies already define part of the failure response. The gaps are concrete enforcement selection, safe execution/integration ownership, and supervision-loss handling—not a requirement to introduce containers or independent clones.

Recommended next step: obtain user decisions for findings 1–7, consolidate the decision record, then explicitly authorize a disposable native-containment/auth/worktree feasibility stage with a go/no-go checkpoint before worker runtime tooling depends on it. No automatic permission to implement or weaken containment follows from this review.
