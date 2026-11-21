/**
 * Request-body schemas, with no dependency.
 *
 * Every body the API accepts is described here and checked before a handler
 * sees it, so a handler works with values of the type it declares rather than
 * whatever a client happened to send. A failure names the field and what was
 * wrong with it, and becomes a 400 rather than a crash deeper in.
 *
 * Unknown keys are dropped, not rejected: the UI and the API evolve together,
 * and a field the server no longer reads should not break an older page.
 */

export class ValidationError extends Error {
  readonly path: string;
  constructor(path: string, problem: string) {
    super(`${path || 'body'}: ${problem}`);
    this.name = 'ValidationError';
    this.path = path;
  }
}

export type Check<T> = (value: unknown, path: string) => T;
export type Infer<C> = C extends Check<infer T> ? T : never;

const at = (path: string, key: string | number): string =>
  typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key;

const kind = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

export function string(opts: { max?: number; min?: number; pattern?: RegExp } = {}): Check<string> {
  const max = opts.max ?? 10_000;
  return (v, path) => {
    if (typeof v !== 'string') throw new ValidationError(path, `expected a string, got ${kind(v)}`);
    if (v.length > max) throw new ValidationError(path, `must be at most ${max} characters`);
    if (opts.min !== undefined && v.length < opts.min) throw new ValidationError(path, `must be at least ${opts.min} characters`);
    if (opts.pattern && !opts.pattern.test(v)) throw new ValidationError(path, 'has an invalid format');
    return v;
  };
}

export function number(opts: { min?: number; max?: number; int?: boolean } = {}): Check<number> {
  return (v, path) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new ValidationError(path, `expected a finite number, got ${kind(v)}`);
    if (opts.int && !Number.isInteger(v)) throw new ValidationError(path, 'must be a whole number');
    if (opts.min !== undefined && v < opts.min) throw new ValidationError(path, `must be at least ${opts.min}`);
    if (opts.max !== undefined && v > opts.max) throw new ValidationError(path, `must be at most ${opts.max}`);
    return v;
  };
}

export function boolean(): Check<boolean> {
  return (v, path) => {
    if (typeof v !== 'boolean') throw new ValidationError(path, `expected true or false, got ${kind(v)}`);
    return v;
  };
}

export function oneOf<const T extends readonly string[]>(values: T): Check<T[number]> {
  return (v, path) => {
    if (typeof v !== 'string' || !values.includes(v)) {
      throw new ValidationError(path, `must be one of ${values.join(', ')}`);
    }
    return v as T[number];
  };
}

export function array<T>(item: Check<T>, opts: { max?: number } = {}): Check<T[]> {
  const max = opts.max ?? 1_000;
  return (v, path) => {
    if (!Array.isArray(v)) throw new ValidationError(path, `expected an array, got ${kind(v)}`);
    if (v.length > max) throw new ValidationError(path, `must have at most ${max} items`);
    return v.map((x, i) => item(x, at(path, i)));
  };
}

/** Absent or undefined is allowed. */
export function optional<T>(check: Check<T>): Check<T | undefined> {
  return (v, path) => (v === undefined ? undefined : check(v, path));
}

/** Absent, undefined or null is allowed; null is kept. */
export function nullable<T>(check: Check<T>): Check<T | null | undefined> {
  return (v, path) => (v === undefined ? undefined : v === null ? null : check(v, path));
}

type Shape = Record<string, Check<unknown>>;
type ObjectOf<S extends Shape> = { [K in keyof S]: Infer<S[K]> };

export function object<S extends Shape>(shape: S): Check<ObjectOf<S>> {
  return (v, path) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ValidationError(path, `expected an object, got ${kind(v)}`);
    const input = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, check] of Object.entries(shape)) {
      const value = check(input[key], at(path, key));
      if (value !== undefined) out[key] = value;
    }
    return out as ObjectOf<S>;
  };
}

/** A map with arbitrary keys and checked values. Keys are bounded too. */
export function record<T>(value: Check<T>, opts: { maxKeys?: number; maxKeyLength?: number } = {}): Check<Record<string, T>> {
  const maxKeys = opts.maxKeys ?? 100;
  const maxKeyLength = opts.maxKeyLength ?? 100;
  return (v, path) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ValidationError(path, `expected an object, got ${kind(v)}`);
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length > maxKeys) throw new ValidationError(path, `must have at most ${maxKeys} keys`);
    const out: Record<string, T> = {};
    for (const [k, x] of entries) {
      if (k.length > maxKeyLength) throw new ValidationError(path, `has a key longer than ${maxKeyLength} characters`);
      out[k] = value(x, at(path, k));
    }
    return out;
  };
}

/** Run a schema against a parsed body. */
export function parse<T>(check: Check<T>, value: unknown): T {
  return check(value, '');
}
