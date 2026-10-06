// Fake process-identity probes for deterministic liveness tests.

import type { IdentityProbe } from "../../../src/util/process-identity.ts";

export const SELF_START = "fixture-self-start";

export function fakeProbe(processes: Record<number, string | "unknown">): IdentityProbe {
  return (pid) => {
    if (pid === process.pid) return { state: "running", start: SELF_START };
    const entry = processes[pid];
    if (entry === undefined) return { state: "absent" };
    if (entry === "unknown") return { state: "unknown" };
    return { state: "running", start: entry };
  };
}
