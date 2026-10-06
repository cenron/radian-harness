# Prompt for the implementation session

Start this implementation session in **Claude Code**, select **Opus 5.5 / high** using its documented native controls, and confirm the actual runtime/model/effort. Use Claude Code's supported claude.ai subscription path, not Pi's Anthropic OAuth/extra-usage path. Do not enable paid extra usage, change authentication, or fall back if the requested profile or required billing-path evidence is unavailable. Pi remains the product coordinator; this is a harness-source implementation session.

```text
Implement Radian Harness in this repository using Claude Code with Opus 5.5 at high effort.

The user has approved the implementation plan, unattended execution, and a commit/push for each completed milestone. Feasibility testing is finished; do not restart it. Full verification runs at the end. This authorization applies to harness-source development, not installing into target workspaces or publishing a release.

First confirm the actual session model/effort and read:
- AGENTS.md
- docs/planning/session-handoff.md
- docs/proposals/0014-unattended-implementation.md
- docs/proposals/0015-anthropic-runtime-policy.md
- docs/planning/implementation/README.md
- docs/research/feasibility-results.md
Then read the linked product requirements and each milestone file before implementing it. Read installed Pi/runtime documentation and relevant examples before relying on their APIs.

Implement milestones 01 through 10 in order. Do not stop for ordinary design/coding questions; make conservative reversible choices within the plan and record them. Write tests alongside the code, but defer the full behavioral/build verification run to milestone 10. Publication scans, exact staged-content/metadata review, and whitespace checks must still precede every push.

For each milestone:
1. Mark it in progress and implement all deliverables and safety/refusal paths.
2. Record choices, completion date/summary, and deferred verification in its milestone file.
3. Mark that file and the implementation index complete when the implementation is actually finished.
4. Review the exact staged diff, run publication checks, commit the milestone, and push it to the existing upstream without force.
5. Verify the remote contains the commit and continue automatically to the next milestone.

Preserve unrelated/dirty/unintegrated work. Do not reset, clean, stash, rebase away changes, or manipulate unrelated panes/processes. Do not install into target workspaces, perform host-global/elevated operations, launch live provider/model/authentication tests, change runtime/model/authentication/effort, add a proxy, or weaken containment. Anthropic workers must use Claude Code only; reject Pi/other-runtime pairings, alias/custom-provider disguises, and unknown provenance before credential exposure or launch. Do not silently reroute or use paid spillover. Keep actual worker execution fail-closed whenever required capability evidence is missing. Implementation completion is not a runtime-support or release-readiness claim.

If a genuine safety/authorization/toolchain/Git-auth blocker makes the plan impossible, preserve work, record a sanitized blocked milestone and safe next action, and stop rather than interactively asking or bypassing it. Push a safe blocker checkpoint only if publication is still possible; otherwise report the local checkpoint. Do not mark incomplete milestones complete.

In milestone 10, run the planned automated verification in disposable contained fixtures, fix in-scope defects, and update the verification report, support matrix, README, and handoff. Do not count skipped or unrun checks as passed. Missing live-runtime evidence must remain explicit with affected capabilities disabled. Do not perform releases, installation, or further experiments afterward.

Finish with a concise summary of milestone statuses, commit hashes and verified pushes, automated verification outcomes, remaining capability/release blockers, and preserved unfinished work. Start now and proceed without routine interaction.
```
