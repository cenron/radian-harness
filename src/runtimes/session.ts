// Per-attempt runtime session: preflight → credential projection → contained
// launch in a fresh owned pane → semantic binding → monitoring → stop.
//
// Ordering guarantees:
// - The proposal 0015 pairing is rechecked before any credential source is read
//   and again before the pane is created.
// - Every required capability (containment, supervision, runtime, credential,
//   billing, transport) must be verified for the detected versions; otherwise
//   the attempt is blocked before credentials are touched.
// - The watcher learns about the attempt before the pane exists, and the
//   launcher registers the runtime process before binding can be confirmed.
// - Binding requires the runtime's own session-start evidence (matching
//   session/model, accepted prompt, and for Claude Code an auth source with no
//   API key) — pane idleness is never binding.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import type { ResolvedAuthority } from "../contracts/authority.ts";
import type { AssignmentIdentity } from "../contracts/identity.ts";
import type { SealedBrief } from "../contracts/brief.ts";
import { type ResolvedProfile, recheckResolvedProfile } from "../config/provider-policy.ts";
import { RUNTIME_FACTS } from "../config/runtimes.ts";
import { type CapabilityContext, CapabilityRegistry, requiredCapabilities } from "../isolation/capabilities.ts";
import { type CredentialBroker, type CredentialSource, type Projection, assertNoProhibitedEnv } from "../isolation/credentials.ts";
import { resolveDependencies } from "../isolation/dependencies.ts";
import type { ProcessOps } from "../isolation/processes.ts";
import { PROFILE_TEMPLATE_VERSION } from "../isolation/profile.ts";
import { SupervisionRegistry } from "../isolation/registry.ts";
import type { SupervisionClient } from "../isolation/supervision.ts";
import { terminateOwned, type TerminationOutcome } from "../isolation/terminate.ts";
import { type LaunchSpec, writeSpec } from "../isolation/launcher.ts";
import { ensureDir } from "../state/fsutil.ts";
import type { LaunchInput, RuntimeAdapter, RuntimeEvent, RuntimeInstall } from "./contract.ts";
import type { HerdrTransport } from "./herdr.ts";
import { piBridgeConfig, piLayout } from "./pi.ts";

export interface SessionDeps {
  adapters: Record<string, RuntimeAdapter>;
  capabilities: CapabilityRegistry;
  broker: CredentialBroker;
  transport: HerdrTransport;
  supervision: Pick<SupervisionClient, "health" | "watch" | "unwatch">;
  ops: ProcessOps;
  stateDir: string;
  projectionRoot: string;
  osVersion: string;
  /** Node executable and launcher entry used inside the pane. */
  launcherArgv: readonly string[];
  /** Coordinator's own pane, used as the explicit split parent. */
  parentPane: string;
  /** Personal credential stores that must never be readable by workers. */
  denyRead: readonly string[];
  graceMs: number;
  /** "assigned" grants the pane's own terminal device (production); "none" for headless fixtures. */
  terminal?: "assigned" | "none";
}

export interface AttemptRequest {
  identity: AssignmentIdentity;
  profile: ResolvedProfile;
  authority: ResolvedAuthority;
  brief: SealedBrief;
  briefText: string;
  systemPrompt: string;
  credentialSource: CredentialSource;
  /** Required credential validity: remaining execution budget plus margin. */
  minValidityMs: number;
}

export interface PreflightResult {
  adapter: RuntimeAdapter;
  install: RuntimeInstall;
  context: CapabilityContext;
  tools: string[];
}

export interface LaunchedAttempt {
  identity: AssignmentIdentity;
  sessionId: string;
  paneId: string;
  delivery: "sent" | "uncertain";
  projection: Projection;
  eventsFile: string;
  specFile: string;
  resultFile: string;
  runtime: ResolvedProfile["runtime"];
  model: string;
}

export async function preflight(deps: SessionDeps, request: Pick<AttemptRequest, "identity" | "profile" | "authority">): Promise<Outcome<PreflightResult>> {
  const pairing = recheckResolvedProfile(request.profile);
  if (!pairing.ok) return pairing;
  const adapter = deps.adapters[request.profile.runtime];
  if (!adapter) return refuse("RUNTIME_UNAVAILABLE", "no adapter for runtime");
  if (request.identity.role !== request.authority.role) return refuse("AUTHORITY_INVALID", "identity role and authority role differ");
  if (!RUNTIME_FACTS[request.profile.runtime].efforts.includes(request.profile.effort)) return refuse("EFFORT_UNSUPPORTED", "effort is not supported by this runtime");
  const install = await adapter.detect();
  if (!install.ok) return install;
  const tools = adapter.toolsFor(request.identity.role, request.authority);
  if (!tools.ok) return tools;
  const health = deps.supervision.health();
  if (!health.ok) return health;
  const context: CapabilityContext = { osVersion: deps.osVersion, runtime: request.profile.runtime, runtimeVersion: install.value.version, policyTemplate: PROFILE_TEMPLATE_VERSION };
  const capabilities = deps.capabilities.require(requiredCapabilities(request.profile.runtime, request.identity.role), context);
  if (!capabilities.ok) return capabilities;
  return success({ adapter, install: install.value, context, tools: tools.value });
}

function writePrivate(file: string, content: string): void {
  ensureDir(path.dirname(file));
  writeFileSync(file, content, { mode: 0o400, flag: "wx" });
}

export async function launchAttempt(deps: SessionDeps, request: AttemptRequest): Promise<Outcome<LaunchedAttempt>> {
  const ready = await preflight(deps, request);
  if (!ready.ok) return ready;
  const { adapter, install, context } = ready.value;
  const projected = await deps.broker.project({
    identity: request.identity,
    profile: request.profile,
    source: request.credentialSource,
    projectionRoot: deps.projectionRoot,
    minValidityMs: request.minValidityMs,
    capabilities: deps.capabilities,
    capabilityContext: context,
  });
  if (!projected.ok) return projected;
  const projection = projected.value;
  const fail = <T>(outcome: Outcome<T>): Outcome<T> => {
    deps.broker.destroy(projection);
    return outcome;
  };

  const a = request.authority;
  const briefFile = path.join(a.outputDir, `brief-${request.identity.attempt}.md`);
  const resultFile = path.join(a.outputDir, "result.json");
  if (existsSync(resultFile)) return fail(refuse("OWNERSHIP_AMBIGUOUS", "the output directory already holds a result; a fresh attempt needs a fresh exchange directory"));
  writePrivate(briefFile, `${request.briefText}\n\n<!-- radian brief ${request.brief.hash} -->\n`);
  const sessionId = randomUUID();
  const input: LaunchInput = { identity: request.identity, profile: request.profile, authority: a, install, projection, briefFile, resultFile, sessionId };
  const plan = adapter.buildLaunch(input);
  if (!plan.ok) return fail(plan);
  if (request.profile.runtime === "pi") {
    const layout = piLayout(path.join(install.installRoots[0] ?? "", "bin", "pi"));
    if (!layout.ok) return fail(layout);
    const systemPromptFile = path.join(projection.dir, "system-prompt.md");
    writePrivate(systemPromptFile, request.systemPrompt);
    writePrivate(path.join(projection.dir, "bridge-config.json"), JSON.stringify(piBridgeConfig(input, layout.value.entry, plan.value.tools, systemPromptFile)));
  }
  const env = assertNoProhibitedEnv(plan.value.env);
  if (!env.ok) return fail(env);

  const deps2 = await resolveDependencies(plan.value.argv[0]!, [...install.installRoots, ...plan.value.readRoots]);
  deps2.readFiles = [...new Set([...deps2.readFiles, ...(plan.value.readFiles ?? [])])];
  for (const helper of install.helpers) {
    const resolved = await resolveDependencies(helper);
    deps2.readFiles = [...new Set([...deps2.readFiles, ...resolved.readFiles])];
    deps2.missing.push(...resolved.missing);
  }
  if (deps2.missing.length > 0) return fail(refuse("CAPABILITY_MISSING", "runtime dependencies could not be resolved narrowly", "Inspect the runtime installation; Radian does not widen access automatically.", { missing: deps2.missing.length }));

  const launchDir = path.join(deps.stateDir, "launch", request.identity.attempt);
  const eventsFile = path.join(deps.stateDir, "supervision", request.identity.assignment, `events-${request.identity.attempt}.jsonl`);
  ensureDir(path.dirname(eventsFile));
  const spec: LaunchSpec = {
    schema: "radian.launch/1",
    identity: request.identity,
    stateDir: deps.stateDir,
    profile: {
      authority: a,
      dependencies: { readRoots: deps2.readRoots, readFiles: deps2.readFiles },
      credentialDir: projection.dir,
      denyRead: [...deps.denyRead, deps.stateDir],
      gitPointer: path.join(a.worktree, ".git"),
    },
    argv: plan.value.argv,
    env: plan.value.env,
    cwd: plan.value.cwd,
    requiredCapabilities: requiredCapabilities(request.profile.runtime, request.identity.role),
    capabilityContext: context,
    terminal: deps.terminal ?? "assigned",
    events: { file: eventsFile, runtime: request.profile.runtime },
  };
  const specFile = path.join(launchDir, "spec.json");
  const hash = writeSpec(specFile, spec);

  // Recheck the pairing at the last moment before anything becomes visible.
  const late = recheckResolvedProfile(request.profile);
  if (!late.ok) return fail(late);
  await deps.supervision.watch({ assignment: request.identity.assignment, attempt: request.identity.attempt, ownedRoots: [a.worktree, a.outputDir, a.scratchDir], projectionDirs: [projection.dir] });
  const pane = await deps.transport.createPane({ assignment: request.identity.assignment, attempt: request.identity.attempt, parentPane: deps.parentPane, cwd: a.worktree });
  if (!pane.ok) {
    await deps.supervision.unwatch(request.identity.assignment);
    return fail(pane);
  }
  await new SupervisionRegistry(deps.stateDir, request.identity.assignment).append({ kind: "resource", attempt: request.identity.attempt, resource: "pane", id: pane.value.paneId });
  const delivered = await deps.transport.runInPane(pane.value.paneId, [...deps.launcherArgv, specFile, hash]);
  if (!delivered.ok) return delivered; // projection stays until stop(): the launcher might still start
  return success({ identity: request.identity, sessionId, paneId: pane.value.paneId, delivery: delivered.value, projection, eventsFile, specFile, resultFile, runtime: request.profile.runtime, model: request.profile.model });
}

/** Incremental reader for the captured runtime event stream. */
export class EventTail {
  private offset = 0;
  private readonly file: string;
  private readonly adapter: RuntimeAdapter;
  constructor(file: string, adapter: RuntimeAdapter) {
    this.file = file;
    this.adapter = adapter;
  }
  read(): RuntimeEvent[] {
    if (!existsSync(this.file)) return [];
    const size = statSync(this.file).size;
    if (size <= this.offset) return [];
    const text = readFileSync(this.file, "utf8").slice(this.offset);
    const end = text.lastIndexOf("\n");
    if (end === -1) return [];
    const complete = text.slice(0, end + 1);
    this.offset += Buffer.byteLength(complete, "utf8");
    return complete.split("\n").filter(Boolean).flatMap((line) => this.adapter.parseEvent(line));
  }
}

export interface BindingEvidence {
  runtimeProcess: { pid: number; start: string };
  sessionId?: string;
  model?: string;
  authSource?: string;
}

/**
 * Wait (bounded) for semantic binding: the launcher's process registration and
 * the runtime's session-start plus accepted prompt with matching identity.
 */
export async function awaitBinding(deps: Pick<SessionDeps, "stateDir" | "adapters">, launched: LaunchedAttempt, deadlineMs: number, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<Outcome<BindingEvidence>> {
  const adapter = deps.adapters[launched.runtime]!;
  const registry = new SupervisionRegistry(deps.stateDir, launched.identity.assignment);
  const tail = new EventTail(launched.eventsFile, adapter);
  let started: Extract<RuntimeEvent, { kind: "session-started" }> | undefined;
  let accepted = false;
  while (Date.now() < deadlineMs) {
    for (const event of tail.read()) {
      if (event.kind === "session-started") started = event;
      if (event.kind === "prompt-accepted") accepted = true;
      if (event.kind === "settled" && !started) return refuse("BINDING_UNCONFIRMED", "runtime settled before reporting a session");
    }
    const processes = registry.processes(launched.identity.attempt);
    const exited = registry.entries().some((e) => e.kind === "exited" && e.attempt === launched.identity.attempt);
    if (started && accepted && processes[0]) {
      if (launched.runtime === "claude-code") {
        if (started.sessionId !== launched.sessionId) return refuse("IDENTITY_MISMATCH", "Claude Code reported a different session id");
        if (started.model !== launched.model) return refuse("PROVIDER_PROVENANCE_UNKNOWN", "Claude Code reported a different model");
        if (started.authSource !== "none") return refuse("BILLING_PATH_UNVERIFIED", "Claude Code did not report subscription authentication (an API-key source was present or unknown)");
      }
      if (launched.runtime === "pi" && (started.sessionId !== launched.sessionId || started.model !== launched.model)) return refuse("IDENTITY_MISMATCH", "Pi bridge reported a different session or model");
      const evidence: BindingEvidence = { runtimeProcess: processes[0] };
      if (started.sessionId) evidence.sessionId = started.sessionId;
      if (started.model) evidence.model = started.model;
      if (started.authSource) evidence.authSource = started.authSource;
      return success(evidence);
    }
    if (exited && !started) return refuse("BINDING_UNCONFIRMED", "runtime exited before binding");
    await sleep(100);
  }
  return refuse("BINDING_UNCONFIRMED", launched.delivery === "uncertain" ? "launch delivery was uncertain and binding was not observed" : "binding was not observed before the startup deadline", "Stop and reconcile the attempt; the launch is never resent automatically.");
}

/** Stop an attempt: verified termination, projection destroyed, pane closed only when verified. */
export async function stopAttempt(deps: SessionDeps, launched: Pick<LaunchedAttempt, "identity" | "projection" | "paneId">, authority: ResolvedAuthority): Promise<{ termination: TerminationOutcome; paneClosed: boolean }> {
  const registry = new SupervisionRegistry(deps.stateDir, launched.identity.assignment);
  const termination = await terminateOwned(deps.ops, {
    registered: registry.processes(launched.identity.attempt),
    ownedRoots: [authority.worktree, authority.outputDir, authority.scratchDir],
    unresolvedIntents: registry.unresolvedIntents(launched.identity.attempt).length,
    protectedPids: [process.pid],
    graceMs: deps.graceMs,
  });
  deps.broker.destroy(launched.projection);
  await registry.append({ kind: "terminated", attempt: launched.identity.attempt, postcondition: termination.postcondition, survivors: termination.survivors.length, discovered: termination.discovered });
  const closed = await deps.transport.closePane(launched.paneId, termination.postcondition);
  if (termination.postcondition === "verified") await deps.supervision.unwatch(launched.identity.assignment);
  return { termination, paneClosed: closed.ok };
}
