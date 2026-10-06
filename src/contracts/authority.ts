// Resolved task authority: the intersection of role limits, the approved task
// scope, and project policy. Requests outside role limits are refused rather
// than silently dropped, so the coordinator sees the conflict. The resolved
// authority is what containment (milestone 05) and adapters (milestone 06)
// enforce; a model choice never broadens it.

import { type Outcome, refuse, success } from "./blockers.ts";
import { ROLES, type Role } from "./identity.ts";
import { canonicalPath, canonicalPaths, dedupeRoots, isWithin, overlaps } from "./paths.ts";
import { type Infer, arr, bool, num, obj, oneOf, str } from "./schema.ts";
import { deepFreeze, hashJson } from "../util/canonical.ts";

export const OPERATIONS = [
  "read",
  "edit",
  "shell",
  "run-checks",
  "install-locked-dependencies",
  "add-dependencies",
  "start-local-services",
  "network-outbound",
  "git-inspect",
  "deliver-changes",
  "write-report",
] as const;
export type Operation = (typeof OPERATIONS)[number];

/** Never granted to any worker role. */
export const ALWAYS_PROHIBITED = [
  "push",
  "merge-or-integrate",
  "git-config-write",
  "git-ref-write",
  "git-worktree-admin",
  "git-hook-write",
  "host-global-install",
  "elevated-privileges",
  "production-access",
  "publish-or-release",
  "approval-write",
  "policy-or-state-write",
  "unregistered-delegation",
  "credential-store-write",
  "signal-unowned-process",
] as const;

export interface RoleLimits {
  operations: readonly Operation[];
  /** Whether the role may write outside its output directory at all. */
  writesOutsideOutput: boolean;
  network: "ordinary-outbound" | "model-only";
}

export const ROLE_LIMITS: Readonly<Record<Role, RoleLimits>> = {
  developer: {
    operations: ["read", "edit", "shell", "run-checks", "install-locked-dependencies", "add-dependencies", "start-local-services", "network-outbound", "git-inspect", "deliver-changes", "write-report"],
    writesOutsideOutput: true,
    network: "ordinary-outbound",
  },
  tester: {
    operations: ["read", "edit", "shell", "run-checks", "install-locked-dependencies", "add-dependencies", "start-local-services", "network-outbound", "git-inspect", "deliver-changes", "write-report"],
    writesOutsideOutput: true,
    network: "ordinary-outbound",
  },
  reviewer: {
    // Read/report only: no shell, installs, Git mutation, or general network tools.
    operations: ["read", "git-inspect", "write-report"],
    writesOutsideOutput: false,
    network: "model-only",
  },
  scout: {
    operations: ["read", "shell", "network-outbound", "git-inspect", "write-report"],
    writesOutsideOutput: false,
    network: "ordinary-outbound",
  },
};

export interface AuthorityRequest {
  role: Role;
  /** Assignment checkout (worktree) root. */
  worktree: string;
  readRoots: readonly string[];
  writeRoots: readonly string[];
  outputDir: string;
  scratchDir: string;
  operations: readonly Operation[];
  /** Owned local service ports. */
  ports?: readonly number[];
  /** Explicit approved-scope permission for dependency/lockfile changes. */
  dependencyChangesApproved?: boolean;
}

export interface ProjectPolicy {
  projectRoot: string;
  /** Shared Git metadata, coordinator state, approvals, policy snapshots, harness source. */
  protectedPaths: readonly string[];
  /** Additional read roots permitted for every assignment (e.g. toolchain dependencies). */
  extraReadRoots?: readonly string[];
}

export const resolvedAuthoritySchema = obj({
  schema: oneOf(["radian.authority/1"] as const),
  role: oneOf(ROLES),
  worktree: str({ min: 1 }),
  readRoots: arr(str({ min: 1 })),
  writeRoots: arr(str({ min: 1 })),
  outputDir: str({ min: 1 }),
  scratchDir: str({ min: 1 }),
  protectedPaths: arr(str({ min: 1 })),
  operations: arr(oneOf(OPERATIONS), { unique: true }),
  prohibited: arr(str({ min: 1 })),
  network: oneOf(["ordinary-outbound", "model-only"] as const),
  ports: arr(num({ int: true, min: 1024, max: 65535 }), { unique: true }),
  dependencyChangesApproved: bool(),
  hash: str({ pattern: /^sha256:[0-9a-f]{64}$/ }),
});

export type ResolvedAuthority = Infer<typeof resolvedAuthoritySchema>;

export function resolveAuthority(request: AuthorityRequest, policy: ProjectPolicy): Outcome<ResolvedAuthority> {
  const limits = ROLE_LIMITS[request.role];
  const denied = request.operations.filter((op) => !limits.operations.includes(op));
  if (denied.length > 0) {
    return refuse("ROLE_OPERATION_DENIED", `role ${request.role} cannot be granted: ${denied.join(", ")}`, "Assign a role whose limits include the operation, or narrow the task.");
  }
  if (request.operations.includes("add-dependencies") && !request.dependencyChangesApproved) {
    return refuse("ROLE_OPERATION_DENIED", "dependency/lockfile changes are outside the approved scope", "Ask the user to approve dependency changes for this task.");
  }

  const worktree = canonicalPath(request.worktree);
  if (!worktree.ok) return worktree;
  const output = canonicalPath(request.outputDir);
  if (!output.ok) return output;
  const scratch = canonicalPath(request.scratchDir);
  if (!scratch.ok) return scratch;
  const project = canonicalPath(policy.projectRoot);
  if (!project.ok) return project;
  const protectedPaths = canonicalPaths(policy.protectedPaths);
  if (!protectedPaths.ok) return protectedPaths;
  const reads = canonicalPaths([...request.readRoots, ...(policy.extraReadRoots ?? [])]);
  if (!reads.ok) return reads;
  const writes = canonicalPaths(request.writeRoots);
  if (!writes.ok) return writes;

  if (!limits.writesOutsideOutput && writes.value.length > 0) {
    return refuse("ROLE_OPERATION_DENIED", `role ${request.role} may write only its output directory`);
  }
  for (const root of writes.value) {
    if (!isWithin(root, worktree.value)) return refuse("PATH_OUTSIDE_SCOPE", "write roots must be inside the assignment worktree");
  }
  if (writes.value.length > 0 && !request.operations.includes("edit")) {
    return refuse("AUTHORITY_INVALID", "write roots require the edit operation");
  }
  for (const root of [...writes.value, output.value, scratch.value]) {
    for (const guarded of protectedPaths.value) {
      if (isWithin(root, guarded)) return refuse("PATH_OUTSIDE_SCOPE", "a writable root lies inside protected coordinator, policy, or Git state");
    }
  }
  if (overlaps(output.value, worktree.value) || overlaps(scratch.value, worktree.value)) {
    return refuse("AUTHORITY_INVALID", "output and scratch directories must be separate from the worktree");
  }
  for (const root of reads.value) {
    if (protectedPaths.value.some((guarded) => isWithin(root, guarded))) {
      return refuse("PATH_OUTSIDE_SCOPE", "a read root lies inside protected state");
    }
  }
  const ports = [...new Set(request.ports ?? [])].sort((a, b) => a - b);
  if (ports.length > 0 && !request.operations.includes("start-local-services")) {
    return refuse("AUTHORITY_INVALID", "owned ports require the start-local-services operation");
  }
  if (ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)) {
    return refuse("AUTHORITY_INVALID", "owned ports must be unprivileged TCP ports");
  }

  const body = {
    schema: "radian.authority/1" as const,
    role: request.role,
    worktree: worktree.value,
    readRoots: dedupeRoots([worktree.value, ...reads.value]),
    writeRoots: writes.value,
    outputDir: output.value,
    scratchDir: scratch.value,
    protectedPaths: protectedPaths.value,
    operations: [...new Set(request.operations)].sort() as Operation[],
    prohibited: [...ALWAYS_PROHIBITED],
    network: request.operations.includes("network-outbound") ? limits.network : "model-only",
    ports,
    dependencyChangesApproved: request.dependencyChangesApproved === true,
  } satisfies Omit<ResolvedAuthority, "hash">;
  return success(deepFreeze({ ...body, hash: hashJson(body) }));
}

/** Verify a stored authority record has not been altered since resolution. */
export function verifyAuthorityHash(authority: ResolvedAuthority): boolean {
  const { hash, ...body } = authority;
  return hashJson(body) === hash;
}
