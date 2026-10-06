// Process identity: a PID plus its start time. PIDs are reused, so a bare PID is
// never sufficient evidence before signalling a process or reclaiming a lease.
// `ps` sampling is not an atomic handle; callers treat "unknown" as unsafe.

import { spawnSync } from "node:child_process";

export interface ProcessIdentity {
  pid: number;
  start: string;
}

export type Liveness = "alive" | "dead" | "unknown";

export type IdentityProbe = (pid: number) => { state: "running"; start: string } | { state: "absent" } | { state: "unknown" };

export const psProbe: IdentityProbe = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return { state: "unknown" };
  const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.error) return { state: "unknown" };
  const start = (result.stdout ?? "").trim();
  if (result.status === 0 && start) return { state: "running", start };
  // ps exits 1 with empty output when no such process exists.
  if (result.status === 1 && start === "") return { state: "absent" };
  return { state: "unknown" };
};

export function currentIdentity(probe: IdentityProbe = psProbe): ProcessIdentity | undefined {
  const observed = probe(process.pid);
  return observed.state === "running" ? { pid: process.pid, start: observed.start } : undefined;
}

export function liveness(identity: ProcessIdentity, probe: IdentityProbe = psProbe): Liveness {
  const observed = probe(identity.pid);
  if (observed.state === "unknown") return "unknown";
  if (observed.state === "absent") return "dead";
  return observed.start === identity.start ? "alive" : "dead";
}
