// Entry point for the independent watcher process. Usage:
//   node src/isolation/watcher-main.ts <stateDir> <leaseMs> <graceMs>
// Reads heartbeats ("beat") and "release" from stdin, which only the
// coordinator holds. EOF or lease expiry triggers loss handling.

import { currentIdentity } from "../util/process-identity.ts";
import { systemProcessOps } from "./processes.ts";
import { Watcher } from "./watcher.ts";

const [stateDir, leaseArg, graceArg] = process.argv.slice(2);
const leaseMs = Number(leaseArg);
const graceMs = Number(graceArg);
const self = currentIdentity();
if (!stateDir || !Number.isFinite(leaseMs) || leaseMs <= 0 || !Number.isFinite(graceMs) || !self) {
  process.exitCode = 2;
} else {
  const watcher = new Watcher({ stateDir, leaseMs, graceMs, ops: systemProcessOps, self });
  watcher.writeStatus();
  let handled = false;
  const lose = async (reason: "heartbeat-eof" | "lease-expired") => {
    if (handled || watcher.released) return;
    handled = true;
    clearInterval(timer);
    await watcher.onLoss(reason);
    process.exit(0);
  };
  const timer = setInterval(() => {
    if (watcher.expired()) void lose("lease-expired");
  }, Math.max(50, Math.min(1000, Math.floor(leaseMs / 4))));
  let buffered = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffered += chunk;
    let index: number;
    while ((index = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, index).trim();
      buffered = buffered.slice(index + 1);
      if (line === "beat") watcher.beat();
      else if (line === "release") {
        watcher.release();
        clearInterval(timer);
        process.exit(0);
      }
    }
  });
  process.stdin.on("end", () => void lose("heartbeat-eof"));
  process.stdin.on("error", () => void lose("heartbeat-eof"));
}
