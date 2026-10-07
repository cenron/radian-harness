import path from "node:path";
import { RadianError } from "../core/errors.ts";
import {
  RUNTIMES,
  assertProfileAllowed,
  type DispatchConfig,
  type Profile,
} from "../core/profiles.ts";
import { ROLES, parseMode, type Mode, type Role } from "../core/roles.ts";
import { readJsonFile } from "./json-file.ts";

export interface HarnessConfig {
  maxWorkers: number;
  startMode: Mode;
  calm: boolean;
  pollSeconds: number;
}

export interface RadianConfig {
  harness: HarnessConfig;
  dispatch: DispatchConfig;
}

type JsonObject = Record<string, unknown>;

const PROFILE_KEYS = ["runtime", "provider", "model", "effort", "description"];

/** Shipped `config/*.json`, overridden by the workspace's `.radian/config/*.json`. */
export function loadConfig(roots: { harnessRoot: string; workspaceRoot: string }): RadianConfig {
  const shipped = path.join(roots.harnessRoot, "config");
  const local = path.join(roots.workspaceRoot, ".radian", "config");
  return {
    harness: loadHarness(path.join(shipped, "harness.json"), path.join(local, "harness.json")),
    dispatch: loadDispatch(path.join(shipped, "dispatch.json"), path.join(local, "dispatch.json")),
  };
}

function loadHarness(shippedFile: string, localFile: string): HarnessConfig {
  const merged = { ...readObject(shippedFile), ...readObject(localFile) };
  const where = `${path.basename(shippedFile)} (shipped or workspace)`;
  const maxWorkers = merged.maxWorkers;
  const pollSeconds = merged.pollSeconds;
  if (!Number.isInteger(maxWorkers) || (maxWorkers as number) < 1) {
    throw invalid(where, "maxWorkers must be a whole number of at least 1");
  }
  if (typeof pollSeconds !== "number" || pollSeconds <= 0) {
    throw invalid(where, "pollSeconds must be a positive number");
  }
  if (typeof merged.calm !== "boolean") throw invalid(where, "calm must be true or false");
  if (typeof merged.startMode !== "string") throw invalid(where, "startMode must be plan or build");
  return {
    maxWorkers: maxWorkers as number,
    pollSeconds,
    calm: merged.calm,
    startMode: parseStartMode(merged.startMode, where),
  };
}

function loadDispatch(shippedFile: string, localFile: string): DispatchConfig {
  const shipped = readObject(shippedFile);
  const local = readObject(localFile);
  const where = `${path.basename(shippedFile)} (shipped or workspace)`;
  const rawProfiles = { ...asObject(shipped.profiles), ...asObject(local.profiles) };
  const profiles: Record<string, Profile> = {};
  for (const [name, raw] of Object.entries(rawProfiles))
    profiles[name] = parseProfile(name, raw, where);
  const rawRoles = { ...asObject(shipped.roles), ...asObject(local.roles) };
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

function readObject(file: string): JsonObject {
  return asObject(readJsonFile<unknown>(file, {}));
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function invalid(where: string, problem: string): RadianError {
  return new RadianError("invalid_config", `Invalid ${where}: ${problem}.`);
}
