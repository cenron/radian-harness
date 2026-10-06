// Identity contracts. A run contains tasks; a task is executed through
// assignments (one role-specific unit of work per candidate round); an
// assignment may have several execution attempts (initial plus recoveries).
// Generations increase whenever authority is re-established, so callbacks from
// superseded workers are recognizably stale.

import { randomUUID } from "node:crypto";
import { type Infer, num, obj, oneOf, str } from "./schema.ts";

export const ID_PATTERN = /^[a-z][a-z0-9-]{0,15}_[A-Za-z0-9-]{6,64}$/;

export const ROLES = ["developer", "tester", "reviewer", "scout"] as const;
export type Role = (typeof ROLES)[number];

export const RUNTIMES = ["pi", "codex", "claude-code"] as const;
export type RuntimeKind = (typeof RUNTIMES)[number];

export const id = () => str({ pattern: ID_PATTERN });

export function newId(prefix: string): string {
  if (!/^[a-z][a-z0-9-]{0,15}$/.test(prefix)) throw new Error("invalid id prefix");
  return `${prefix}_${randomUUID()}`;
}

export const assignmentIdentitySchema = obj({
  workspace: id(),
  project: id(),
  run: id(),
  task: id(),
  assignment: id(),
  attempt: id(),
  generation: num({ int: true, min: 1 }),
  role: oneOf(ROLES),
});

export type AssignmentIdentity = Infer<typeof assignmentIdentitySchema>;

export function sameIdentity(a: AssignmentIdentity, b: AssignmentIdentity): boolean {
  return (
    a.workspace === b.workspace &&
    a.project === b.project &&
    a.run === b.run &&
    a.task === b.task &&
    a.assignment === b.assignment &&
    a.attempt === b.attempt &&
    a.generation === b.generation &&
    a.role === b.role
  );
}

/** Describe which identity fields differ, without echoing their values. */
export function identityDifferences(expected: AssignmentIdentity, actual: AssignmentIdentity): string[] {
  const keys: Array<keyof AssignmentIdentity> = ["workspace", "project", "run", "task", "assignment", "attempt", "generation", "role"];
  return keys.filter((key) => expected[key] !== actual[key]);
}
