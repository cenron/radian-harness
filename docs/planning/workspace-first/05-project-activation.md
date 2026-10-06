# W05 — Activation and background ownership

**Status: pending.** Dependency: W04; follow the public-API design proved in W01.

## Work

1. Activate transactionally at a safe idle boundary: capture old identity/context, validate new registry/path/trust/config, prepare isolated conversation/instructions/tools, and publish selection only on success. Cancellation/failure leaves the old valid view or an explicit dashboard/blocker, never half-switched state.
2. Do not carry A's transcript, queued prompts, pending calls, summaries, compaction, or workspace navigation into B. Returning to A restores only A's validated context. Bind overlapping switches and late results to owner/generation.
3. Revalidate identity, target, moved/missing/duplicate paths, instructions, trust, configuration, and context references on activation/restore. Untrusted project extensions stay unloaded; do not load all projects' resources.
4. Retain originating-project background runs, leases, supervision, capacity, approvals, and results independently of selected view. Notify about A while B is selected without injecting A's private payload into B's model context. A's questions/quota/approvals remain decisions in A.
5. Preserve approved check definitions across candidate repair/context restore and current launch authorization through delayed start. Never change policy beneath active workers or reroute a pending A launch to B.
6. Include unknown-termination retained work in ownership/status/monitoring/shutdown. An empty active-handle list is not termination proof. Prevent duplicate coordinator acquisition when revisiting a retained run; multiple Pi sessions cannot steal selection/context/lease.
7. Separate view switching from real shutdown/reload. Maintain supervision across view replacement; real shutdown uses verified/unknown ownership rules, generation-safe cleanup, and no dispatch after safety loss. Direct-project entry stays interoperable without mixing conversations.

## Acceptance/tests

Native offline and fake-host A/B tests prove transcript/instruction/tool/path/config/approval/result/compaction isolation in the same process/interface with fixed workspace cwd. Cover cancellation and failure at activation phases, overlapping switches, queued inputs, late A results, untrusted/missing/moved B, restore, two coordinators, shared capacity, active/paused/unknown A while B selected, and shutdown/reload.

Include unknown cleanup before later watcher/lease loss, shutdown with only retained work, command substitution after repair/restore, and approval rejection between authorization and delayed startup during a switch. Final closure of all independent findings is judged in W06, not assumed here.

## Completion record

Not started.
