// Harness configuration: concurrency, assignment limits, and execution policy.
// Product invariants (three candidate rounds, at most one automatic recovery,
// fail-closed capabilities) are validated so overrides cannot exceed them.

import { type Infer, arr, bool, literal, num, obj, oneOf, optional, refine, str } from "../contracts/schema.ts";

export const MAX_CANDIDATE_ROUNDS = 3;
export const MAX_AUTOMATIC_RECOVERIES = 1;

export const harnessConfigSchema = refine(
  obj({
    version: literal(1),
    concurrency: obj({
      /** Workspace-wide ceiling across all roles and Radian-managed runs. */
      maxActiveWorkers: num({ int: true, min: 1, max: 64 }),
    }),
    assignment: obj({
      executionLimitMinutes: num({ int: true, min: 1, max: 24 * 60 }),
      candidateRounds: num({ int: true, min: 1, max: MAX_CANDIDATE_ROUNDS }),
      automaticRecoveries: num({ int: true, min: 0, max: MAX_AUTOMATIC_RECOVERIES }),
      startupTimeoutSeconds: num({ int: true, min: 5, max: 600 }),
    }),
    execution: obj({
      /** Unknown or unverified required capabilities always deny launch. */
      unverifiedCapabilities: literal("deny"),
      containment: literal("required"),
      network: oneOf(["ordinary-outbound"] as const),
      blanketPermissionBypass: literal(false),
      /**
       * User-approved tools for contained workers and their checks: absolute
       * executable paths (for example "/opt/homebrew/bin/godot"). Each is
       * exposed under its own name with read access limited to its resolved
       * binary or .app bundle and dependencies. Empty by default.
       */
      workerTools: optional(arr(str({ min: 2, max: 1024, pattern: /^\/[A-Za-z0-9 ._@+,=:~\/-]*$/ }), { max: 20, unique: true })),
    }),
    supervision: obj({
      leaseSeconds: num({ int: true, min: 5, max: 600 }),
      terminationGraceSeconds: num({ int: true, min: 1, max: 120 }),
    }),
    interface: optional(
      obj({
        startMode: literal("plan"),
        calmDefault: bool(),
      }),
    ),
  }),
  () => undefined,
);

export type HarnessConfig = Infer<typeof harnessConfigSchema>;
