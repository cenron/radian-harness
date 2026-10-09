import type { Role, Runtime } from "#core/constants.ts";

export const MODES = ["plan", "build"] as const;
export type Mode = (typeof MODES)[number];

export interface Profile {
  name: string;
  runtime: Runtime;
  /** Pi needs a provider to find the model; Claude Code and Codex each have one fixed provider. */
  provider?: string;
  model: string;
  effort: string;
  description?: string;
}

export interface HarnessConfig {
  maxWorkers: number;
  startMode: Mode;
  calm: boolean;
  pollSeconds: number;
  /** Seconds the merge dialog waits before merging on its own; 0 waits for an answer. */
  autoMergeSeconds: number;
}

export interface DispatchConfig {
  roles: Record<Role, string>;
  profiles: Record<string, Profile>;
}

export interface RadianConfig {
  harness: HarnessConfig;
  dispatch: DispatchConfig;
}
