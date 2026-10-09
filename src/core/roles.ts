import { RadianError } from "./errors.ts";
import { type Role, ROLES } from "#core/constants.ts";
import { MODES, type Mode } from "#core/types.ts";

export function parseRole(value: string): Role {
  const role = ROLES.find((candidate) => candidate === value);
  if (!role)
    throw new RadianError("invalid_role", `Unknown role "${value}". Use ${ROLES.join(", ")}.`);
  return role;
}

export function parseMode(value: string): Mode {
  const mode = MODES.find((candidate) => candidate === value);
  if (!mode) throw new RadianError("invalid_mode", `Unknown mode "${value}". Use plan or build.`);
  return mode;
}

/** A scout only reads, so it may run while planning; every other role changes code. */
export function assertRoleAllowedInMode(role: Role, mode: Mode): void {
  if (mode === "plan" && role !== "scout") {
    throw new RadianError(
      "plan_mode",
      `A ${role} can only be dispatched in Build mode. Press Shift+Tab or run /radian mode build.`,
    );
  }
}

export function canEditCode(role: Role): boolean {
  return role === "developer" || role === "tester";
}
