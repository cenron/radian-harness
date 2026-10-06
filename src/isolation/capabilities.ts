// Capability records. A capability is usable only with verification evidence
// bound to the current OS, runtime, toolchain, and policy template versions.
// Unknown, unverified, or version-mismatched required capabilities deny launch.
// Evidence is recorded only through explicit human input after a verification
// the human authorized; nothing promotes itself from synthetic or partial tests.

import path from "node:path";
import { type Outcome, refuse, success } from "../contracts/blockers.ts";
import type { Role, RuntimeKind } from "../contracts/identity.ts";
import { type Clock, iso, systemClock } from "../util/clock.ts";
import { HumanChannel } from "../state/approvals.ts";
import { atomicWriteJson, readJsonIfExists, withLock } from "../state/fsutil.ts";
import { PROFILE_TEMPLATE_VERSION } from "./profile.ts";

export const CAPABILITIES = [
  // Native boundary
  "containment.sandbox-exec.filesystem",
  "containment.sandbox-exec.process-signals",
  "containment.sandbox-exec.network-outbound",
  "containment.dependency-access-audit",
  // Supervision
  "supervision.independent-watcher",
  "supervision.descendant-termination",
  "supervision.watcher-loss-response",
  // Per runtime
  "runtime.pi.contained-launch",
  "runtime.pi.tool-restrictions",
  "runtime.pi.assignment-binding",
  "runtime.pi.cancellation",
  "runtime.codex.contained-launch",
  "runtime.codex.tool-restrictions",
  "runtime.codex.assignment-binding",
  "runtime.codex.cancellation",
  "runtime.claude-code.contained-launch",
  "runtime.claude-code.tool-restrictions",
  "runtime.claude-code.assignment-binding",
  "runtime.claude-code.cancellation",
  // Credentials and billing paths
  "credential.pi.non-refreshing-access",
  "credential.codex.non-refreshing-access",
  "credential.claude-code.non-refreshing-access",
  "billing.pi.subscription-path",
  "billing.codex.subscription-path",
  "billing.claude-code.subscription-path",
  // Transport
  "transport.herdr.owned-panes",
] as const;

export type CapabilityId = (typeof CAPABILITIES)[number];

export interface CapabilityContext {
  osVersion: string;
  runtime?: RuntimeKind;
  runtimeVersion?: string;
  toolchain?: string;
  policyTemplate: string;
}

export interface CapabilityEvidence {
  capability: CapabilityId;
  status: "verified" | "failed";
  context: CapabilityContext;
  /** Sanitized reference to the verification record (no raw logs or credentials). */
  reference: string;
  recordedBy: string;
  recordedAt: string;
}

export type CapabilityStatus = { state: "verified"; evidence: CapabilityEvidence } | { state: "unverified" | "failed" | "version-mismatch"; reason: string };

/** Capabilities required before a worker of `runtime` and `role` may launch. */
export function requiredCapabilities(runtime: RuntimeKind, role: Role): CapabilityId[] {
  const base: CapabilityId[] = [
    "containment.sandbox-exec.filesystem",
    "containment.sandbox-exec.process-signals",
    "containment.dependency-access-audit",
    "supervision.independent-watcher",
    "supervision.descendant-termination",
    "supervision.watcher-loss-response",
    `runtime.${runtime}.contained-launch`,
    `runtime.${runtime}.tool-restrictions`,
    `runtime.${runtime}.assignment-binding`,
    `runtime.${runtime}.cancellation`,
    `credential.${runtime}.non-refreshing-access`,
    `billing.${runtime}.subscription-path`,
    "transport.herdr.owned-panes",
  ];
  if (role !== "reviewer") base.push("containment.sandbox-exec.network-outbound");
  return base;
}

export class CapabilityRegistry {
  private readonly file: string;
  private readonly clock: Clock;

  constructor(stateDir: string, clock: Clock = systemClock) {
    this.file = path.join(stateDir, "capabilities.json");
    this.clock = clock;
  }

  private read(): CapabilityEvidence[] {
    const data = readJsonIfExists(this.file);
    if (data.state !== "ok") return [];
    const list = (data.value as { evidence?: unknown }).evidence;
    return Array.isArray(list) ? (list as CapabilityEvidence[]) : [];
  }

  status(capability: CapabilityId, context: CapabilityContext): CapabilityStatus {
    const evidence = this.read().filter((e) => e.capability === capability).at(-1);
    if (!evidence) return { state: "unverified", reason: "no verification evidence recorded" };
    if (evidence.status === "failed") return { state: "failed", reason: "last verification failed" };
    const c = evidence.context;
    if (c.policyTemplate !== context.policyTemplate) return { state: "version-mismatch", reason: "policy template changed since verification" };
    if (c.osVersion.split(".")[0] !== context.osVersion.split(".")[0]) return { state: "version-mismatch", reason: "OS major version changed since verification" };
    if (c.runtime !== undefined && (c.runtime !== context.runtime || c.runtimeVersion !== context.runtimeVersion)) {
      return { state: "version-mismatch", reason: "runtime version changed since verification" };
    }
    if (c.toolchain !== undefined && c.toolchain !== context.toolchain) return { state: "version-mismatch", reason: "toolchain changed since verification" };
    return { state: "verified", evidence };
  }

  /** Every required capability must be verified for the current context; otherwise launch is denied. */
  require(capabilities: readonly CapabilityId[], context: CapabilityContext): Outcome<true> {
    const gaps: string[] = [];
    for (const capability of capabilities) {
      const s = this.status(capability, context);
      if (s.state !== "verified") gaps.push(`${capability} (${s.state})`);
    }
    if (gaps.length > 0) {
      return refuse("CAPABILITY_UNVERIFIED", `required capabilities are not verified: ${gaps.slice(0, 6).join(", ")}${gaps.length > 6 ? `, +${gaps.length - 6} more` : ""}`, "Execution stays disabled until the missing capabilities are verified under explicit authorization.", { missing: gaps.length });
    }
    return success(true);
  }

  async record(channel: HumanChannel, evidence: Omit<CapabilityEvidence, "recordedBy" | "recordedAt">): Promise<Outcome<true>> {
    if (!HumanChannel.isGenuine(channel)) return refuse("APPROVAL_NOT_HUMAN", "capability evidence is recorded only by explicit human input");
    if (!(CAPABILITIES as readonly string[]).includes(evidence.capability)) return refuse("CONFIG_INVALID", "unknown capability");
    if (evidence.context.policyTemplate !== PROFILE_TEMPLATE_VERSION) return refuse("CONFIG_INVALID", "evidence refers to a different policy template");
    return withLock(this.file + ".lock", "capability registry", () => {
      const list = this.read();
      list.push({ ...evidence, recordedBy: channel.actorId, recordedAt: iso(this.clock.now()) });
      atomicWriteJson(this.file, { schema: "radian.capabilities/1", evidence: list });
      return success(true as const);
    });
  }
}
