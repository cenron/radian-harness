# Release acceptance checklist

No release, tag, or package publication is authorized yet. Before Radian is advertised as usable, or any runtime as supported, each item below must be demonstrated with recorded, sanitized evidence for the exact source revision and runtime versions. Offline automated tests are necessary but not sufficient; items marked **live** need explicitly authorized live verification.

## Workflow (all three runtimes in scope)

- [ ] Complete developer → tester → candidate check → reviewer → human-approved integration flow (**live**, per runtime).
- [ ] Fresh-context repairs, three-round exhaustion, crash recovery, and quota recovery.
- [ ] Workspace-wide concurrency enforcement and execution-time accounting.
- [ ] Safe cancellation, pause/resume, stale-result rejection, and preservation of unfinished work.

## Containment and runtimes

- [ ] Native containment verified per runtime/version: scoped reads/writes, protected Git/state/policy, credential stores unreadable, children and symlinks covered (**live**).
- [ ] Role restrictions verified per runtime (reviewer read/report only; no unregistered delegation) (**live**).
- [ ] Non-refreshing credential access and subscription billing path verified per runtime; no API-key or paid spillover (**live**).
- [ ] Semantic assignment binding and cancellation of actual runtime processes, including detached descendants (**live**).
- [ ] Independent watcher stops actual workers on coordinator crash and stall; watcher loss handled (**live**).
- [ ] Owned Herdr pane creation, command delivery, and closure in an isolated session (**live**).
- [ ] Capability evidence recorded only after the checks above, bound to versions.

## Interface

- [ ] Extension loads in the reviewed Pi version; managed editor, Shift+Tab, Tab autocomplete, and native `/thinking` behave as documented (**live**).
- [ ] Calm hides only routine successful output; execution, context, input order, and exports unchanged.
- [ ] Approvals impossible from model tools, worker reports, RPC, or noninteractive modes.

## Installer and workspace

- [ ] Preview/install/status/update/remove/recover on disposable workspaces, including empty non-Git workspaces, existing settings, local edits, active runs, symlinks, moved and duplicate bindings, interrupted operations, and previewed migration of project-first manifests.
- [ ] Same-interface project creation, registration, selection, restore, and restart with isolated context, verified in the interactive terminal (**live**), in addition to the offline RPC evidence.

## Metrics and provenance

- [ ] Metrics carry the running harness version, revision, local-modification state, and config hash; unknown usage remains unknown; no private data in reports.

## Publication

- [ ] Publication scan clean on the exact release tree, staged content, and commit metadata; private denylist supplied and loaded by the maintainer (its absence disclosed otherwise).
- [ ] Package/archive contents reviewed against the package-content allowlist; no run artifacts, credentials, raw logs, private configuration, or project content.
- [ ] License selected by the owner and third-party notices present where required.
- [ ] Release notes state verified, unverified, and unavailable capabilities separately.
