import path from "node:path";
import { RadianError } from "./errors.ts";
import { assertProfileAllowed } from "./profiles.ts";
import { parseMode } from "./roles.ts";
import { type Role, ROLES, RUNTIMES } from "#core/constants.ts";
import { asObject, readJsonAsObject, type JsonObject } from "#core/utils/json.ts";
import type { DispatchConfig, HarnessConfig, Mode, Profile, RadianConfig } from "#core/types.ts";

const PROFILE_KEYS = ["runtime", "provider", "model", "effort", "description"];

/** Global `config/*.json`, overridden by the workspace's `.radian/config/*.json`. */
export function loadConfig(roots: { harnessRoot: string; workspaceRoot: string }): RadianConfig {
  /**
   * We get the global config from the harness root, and the local config from the workspace root.
   * We merge the local config over the global config, so that the local config can override the global config.
   */
  const global = path.join(roots.harnessRoot, "config");
  const local = path.join(roots.workspaceRoot, ".radian", "config");

  return {
    harness: loadHarness(path.join(global, "harness.json"), path.join(local, "harness.json")),
    dispatch: loadDispatch(path.join(global, "dispatch.json"), path.join(local, "dispatch.json")),
  };
}

function loadHarness(globalFile: string, localFile: string): HarnessConfig {
  const merged = {
    ...readJsonAsObject(globalFile),
    ...readJsonAsObject(localFile),
  };

  const where = `${path.basename(globalFile)} (shipped or workspace)`;

  const maxWorkers = merged.maxWorkers;
  const pollSeconds = merged.pollSeconds;

  if (!Number.isInteger(maxWorkers) || (maxWorkers as number) < 1) {
    throw invalid(where, "maxWorkers must be a whole number of at least 1");
  }

  if (typeof pollSeconds !== "number" || pollSeconds <= 0) {
    throw invalid(where, "pollSeconds must be a positive number");
  }

  const autoMergeSeconds = merged.autoMergeSeconds ?? 0;
  if (typeof autoMergeSeconds !== "number" || autoMergeSeconds < 0) {
    throw invalid(where, "autoMergeSeconds must be 0 (off) or a positive number of seconds");
  }

  if (typeof merged.calm !== "boolean") throw invalid(where, "calm must be true or false");
  if (typeof merged.startMode !== "string") throw invalid(where, "startMode must be plan or build");

  return {
    maxWorkers: maxWorkers as number,
    pollSeconds,
    autoMergeSeconds,
    calm: merged.calm,
    startMode: parseStartMode(merged.startMode, where),
  };
}

function loadDispatch(shippedFile: string, localFile: string): DispatchConfig {
  const shipped = readJsonAsObject(shippedFile);
  const local = readJsonAsObject(localFile);

  const where = `${path.basename(shippedFile)} (shipped or workspace)`;
  const rawProfiles = {
    ...asObject(shipped.profiles),
    ...asObject(local.profiles),
  };

  const profiles: Record<string, Profile> = {};
  for (const [name, raw] of Object.entries(rawProfiles))
    profiles[name] = parseProfile(name, raw, where);

  const rawRoles = {
    ...asObject(shipped.roles),
    ...asObject(local.roles),
  };

  return { roles: parseRoles(rawRoles, profiles, where), profiles };
}

function parseProfile(name: string, raw: unknown, where: string): Profile {
  const value = asObject(raw);
  const unknownKey = Object.keys(value).find((key) => !PROFILE_KEYS.includes(key));

  if (unknownKey) throw invalid(where, `profile "${name}" has unknown key "${unknownKey}"`);

  const runtime = RUNTIMES.find((candidate) => candidate === value.runtime);

  if (!runtime) throw invalid(where, `profile "${name}" runtime must be ${RUNTIMES.join(", ")}`);
  if (typeof value.model !== "string" || typeof value.effort !== "string") {
    throw invalid(where, `profile "${name}" needs a model and an effort`);
  }

  const profile: Profile = { name, runtime, model: value.model, effort: value.effort };

  if (typeof value.provider === "string") profile.provider = value.provider;
  if (typeof value.description === "string") profile.description = value.description;

  assertProfileAllowed(profile);

  return profile;
}

function parseRoles(
  raw: JsonObject,
  profiles: Record<string, Profile>,
  where: string,
): Record<Role, string> {
  const roles = {} as Record<Role, string>;

  for (const role of ROLES) {
    const name = raw[role];
    if (typeof name !== "string" || !profiles[name]) {
      throw invalid(where, `role ${role} uses unknown profile "${String(name)}"`);
    }
    roles[role] = name;
  }

  return roles;
}

function parseStartMode(value: string, where: string): Mode {
  try {
    return parseMode(value);
  } catch (_error) {
    throw invalid(where, "startMode must be plan or build");
  }
}

function invalid(where: string, problem: string): RadianError {
  return new RadianError("invalid_config", `Invalid ${where}: ${problem}.`);
}
