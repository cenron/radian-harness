// Owned-resource registry for supervised assignments. Records live in protected
// coordinator state (never worker-writable). Registration intent is recorded
// before a process is spawned, so an interrupted registration leaves evidence
// that makes termination "unknown" rather than silently forgotten.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { ProcessIdentity } from "../util/process-identity.ts";
import { type Clock, iso, systemClock } from "../util/clock.ts";
import { appendDurable, ensureDir, withLock } from "../state/fsutil.ts";

export type RegistryEntry =
  | { kind: "intent"; at: string; attempt: string; label: string }
  | { kind: "process"; at: string; attempt: string; label: string; identity: ProcessIdentity; source: "launcher" | "discovered" }
  | { kind: "resource"; at: string; attempt: string; resource: "port" | "service" | "pane" | "projection" | "scratch"; id: string }
  | { kind: "terminated"; at: string; attempt: string; postcondition: "verified" | "unknown"; survivors: number; discovered: number }
  | { kind: "exited"; at: string; attempt: string; exitCode: number | null; signal: string | null };

type WithoutAt<T> = T extends unknown ? Omit<T, "at"> & { at?: string } : never;

export class SupervisionRegistry {
  readonly dir: string;
  private readonly clock: Clock;

  constructor(stateDir: string, assignment: string, clock: Clock = systemClock) {
    this.dir = path.join(stateDir, "supervision", assignment);
    this.clock = clock;
  }

  private file(): string {
    return path.join(this.dir, "registry.jsonl");
  }

  async append(entry: WithoutAt<RegistryEntry>): Promise<void> {
    ensureDir(this.dir);
    const full = { ...entry, at: entry.at ?? iso(this.clock.now()) } as RegistryEntry;
    await withLock(path.join(this.dir, "lock"), "supervision registry", () => appendDurable(this.file(), JSON.stringify(full)));
  }

  entries(): RegistryEntry[] {
    let text: string;
    try {
      text = readFileSync(this.file(), "utf8");
    } catch {
      return [];
    }
    const out: RegistryEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as RegistryEntry);
      } catch {
        // A torn final line is treated as an unknown registration below.
        out.push({ kind: "intent", at: "", attempt: "unknown", label: "torn-registration" });
      }
    }
    return out;
  }

  processes(attempt?: string): ProcessIdentity[] {
    return this.entries()
      .filter((e): e is Extract<RegistryEntry, { kind: "process" }> => e.kind === "process" && (attempt === undefined || e.attempt === attempt))
      .map((e) => e.identity);
  }

  /** Intents with no matching registered process: registration was interrupted. */
  unresolvedIntents(attempt?: string): string[] {
    const entries = this.entries().filter((e) => attempt === undefined || e.attempt === attempt);
    const registered = new Set(entries.filter((e) => e.kind === "process").map((e) => `${e.attempt}:${(e as { label: string }).label}`));
    return entries.filter((e) => e.kind === "intent" && !registered.has(`${e.attempt}:${e.label}`)).map((e) => (e as { label: string }).label);
  }
}
