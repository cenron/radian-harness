// Minimal strict validators with path-aware issues and inferred TypeScript
// types. Objects reject unknown keys by default so that unvalidated fields (for
// example a spoofed `approval` in a worker result) never pass silently.

export interface Issue {
  path: string;
  message: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

export interface Schema<T> {
  readonly kind: string;
  readonly isOptional: boolean;
  parse(input: unknown, path?: string): Parsed<T>;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

function ok<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

function fail<T>(path: string, message: string): Parsed<T> {
  return { ok: false, issues: [{ path: path || "$", message }] };
}

function make<T>(kind: string, parse: (input: unknown, path: string) => Parsed<T>): Schema<T> {
  return { kind, isOptional: false, parse: (input, path = "") => parse(input, path) };
}

export interface StringRules {
  min?: number;
  max?: number;
  pattern?: RegExp;
}

export function str(rules: StringRules = {}): Schema<string> {
  return make("string", (input, path) => {
    if (typeof input !== "string") return fail(path, "expected string");
    if (rules.min !== undefined && input.length < rules.min) return fail(path, `must be at least ${rules.min} characters`);
    if (rules.max !== undefined && input.length > rules.max) return fail(path, `must be at most ${rules.max} characters`);
    if (rules.pattern && !rules.pattern.test(input)) return fail(path, `does not match ${rules.pattern.source}`);
    if (input.includes("\0")) return fail(path, "must not contain NUL");
    return ok(input);
  });
}

export interface NumberRules {
  int?: boolean;
  min?: number;
  max?: number;
}

export function num(rules: NumberRules = {}): Schema<number> {
  return make("number", (input, path) => {
    if (typeof input !== "number" || !Number.isFinite(input)) return fail(path, "expected finite number");
    if (rules.int && !Number.isInteger(input)) return fail(path, "expected integer");
    if (rules.min !== undefined && input < rules.min) return fail(path, `must be >= ${rules.min}`);
    if (rules.max !== undefined && input > rules.max) return fail(path, `must be <= ${rules.max}`);
    return ok(input);
  });
}

export function bool(): Schema<boolean> {
  return make("boolean", (input, path) => (typeof input === "boolean" ? ok(input) : fail(path, "expected boolean")));
}

export function literal<const T extends string | number | boolean | null>(expected: T): Schema<T> {
  return make(`literal ${String(expected)}`, (input, path) =>
    input === expected ? ok(expected) : fail(path, `expected ${JSON.stringify(expected)}`),
  );
}

export function oneOf<const T extends readonly string[]>(values: T): Schema<T[number]> {
  return make(`one of ${values.join("|")}`, (input, path) =>
    typeof input === "string" && (values as readonly string[]).includes(input)
      ? ok(input as T[number])
      : fail(path, `expected one of ${values.join(", ")}`),
  );
}

export function arr<T>(item: Schema<T>, rules: { min?: number; max?: number; unique?: boolean } = {}): Schema<T[]> {
  return make(`array of ${item.kind}`, (input, path) => {
    if (!Array.isArray(input)) return fail(path, "expected array");
    if (rules.min !== undefined && input.length < rules.min) return fail(path, `needs at least ${rules.min} item(s)`);
    if (rules.max !== undefined && input.length > rules.max) return fail(path, `allows at most ${rules.max} item(s)`);
    const out: T[] = [];
    const issues: Issue[] = [];
    input.forEach((value, index) => {
      const parsed = item.parse(value, `${path}[${index}]`);
      if (parsed.ok) out.push(parsed.value);
      else issues.push(...parsed.issues);
    });
    if (issues.length > 0) return { ok: false, issues };
    if (rules.unique && new Set(out.map((v) => JSON.stringify(v))).size !== out.length) return fail(path, "items must be unique");
    return ok(out);
  });
}

export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly isOptional: true;
}

export function optional<T>(inner: Schema<T>): OptionalSchema<T> {
  return {
    kind: `optional ${inner.kind}`,
    isOptional: true as const,
    parse: (input: unknown, path = "") => (input === undefined ? ok(undefined) : inner.parse(input, path)),
  };
}

export function nullable<T>(inner: Schema<T>): Schema<T | null> {
  return make(`nullable ${inner.kind}`, (input, path) => (input === null ? ok(null) : inner.parse(input, path)));
}

export function union<T extends readonly Schema<unknown>[]>(options: T): Schema<Infer<T[number]>> {
  return make("union", (input, path) => {
    const issues: Issue[] = [];
    for (const option of options) {
      const parsed = option.parse(input, path);
      if (parsed.ok) return parsed as Parsed<Infer<T[number]>>;
      issues.push(...parsed.issues);
    }
    return { ok: false, issues: [{ path: path || "$", message: `no union branch matched (${issues.map((i) => i.message).join("; ")})` }] };
  });
}

export function record<T>(value: Schema<T>, keyPattern: RegExp = /^[A-Za-z0-9][A-Za-z0-9._-]*$/): Schema<Record<string, T>> {
  return make(`record of ${value.kind}`, (input, path) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return fail(path, "expected object");
    const out: Record<string, T> = {};
    const issues: Issue[] = [];
    for (const [key, entry] of Object.entries(input)) {
      if (!keyPattern.test(key)) {
        issues.push({ path: `${path}.${key}`, message: `invalid key (must match ${keyPattern.source})` });
        continue;
      }
      const parsed = value.parse(entry, `${path}.${key}`);
      if (parsed.ok) out[key] = parsed.value;
      else issues.push(...parsed.issues);
    }
    return issues.length > 0 ? { ok: false, issues } : ok(out);
  });
}

type Shape = Record<string, Schema<unknown>>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K]["isOptional"] extends true ? K : never }[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type InferShape<S extends Shape> = Simplify<
  { [K in RequiredKeys<S>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined> }
>;

export interface ObjectSchema<S extends Shape> extends Schema<InferShape<S>> {
  readonly shape: S;
}

export function obj<S extends Shape>(shape: S, options: { allowUnknown?: boolean } = {}): ObjectSchema<S> {
  const schema = make("object", (input, path) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return fail(path, "expected object");
    const source = input as Record<string, unknown>;
    const issues: Issue[] = [];
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(shape)) {
      const parsed = field.parse(source[key], `${path}.${key}`);
      if (parsed.ok) {
        if (parsed.value !== undefined) out[key] = parsed.value;
      } else issues.push(...parsed.issues);
    }
    if (!options.allowUnknown) {
      for (const key of Object.keys(source)) {
        if (!(key in shape)) issues.push({ path: `${path}.${key}`, message: "unknown field" });
      }
    }
    return issues.length > 0 ? { ok: false, issues } : ok(out as InferShape<S>);
  }) as Schema<InferShape<S>>;
  return { ...schema, shape };
}

/** Add a cross-field check after structural validation. */
export function refine<T>(inner: Schema<T>, check: (value: T) => Issue[] | undefined): Schema<T> {
  return {
    kind: inner.kind,
    isOptional: inner.isOptional,
    parse(input, path = "") {
      const parsed = inner.parse(input, path);
      if (!parsed.ok) return parsed;
      const issues = check(parsed.value);
      return issues && issues.length > 0 ? { ok: false, issues } : parsed;
    },
  };
}

export function formatIssues(issues: readonly Issue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

/** Parse or throw a descriptive error; for trusted shipped data in tests and loaders. */
export function mustParse<T>(schema: Schema<T>, input: unknown, label: string): T {
  const parsed = schema.parse(input);
  if (!parsed.ok) throw new Error(`${label} is invalid: ${formatIssues(parsed.issues)}`);
  return parsed.value;
}
