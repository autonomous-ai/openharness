/**
 * Reading JSON that may hold anything (a file on disk, a body off the wire) against a fixed shape, by hand. The messages
 * service runs in the edge host, and zod there loaded into every service of that process, 8 to 19 MiB each
 * (leanEntry.spec.ts). A check answers the value it accepts, transformed where it says so, or NO.
 */
export const NO: unique symbol = Symbol('no')
export type Check<T> = (v: unknown) => T | typeof NO

/** A string of `min` to `max` UTF-16 units that matches `pattern`, when given. */
export const text = (max = Infinity, min = 0, pattern?: RegExp): Check<string> => (v) =>
  typeof v === 'string' && v.length >= min && v.length <= max && (pattern === undefined || pattern.test(v)) ? v : NO

/** A date as `toISOString` writes it, and as zod's `z.string().datetime()` took it: UTC (`Z`), a real calendar day,
 *  seconds and their fraction optional. */
const DATETIME = /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|02-(?:0[1-9]|1\d|2[0-8])))T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?Z$/
export const datetime = (max = Infinity): Check<string> => text(max, 0, DATETIME)

/** A finite number; `int` a safe integer of at least `min`. */
export const num: Check<number> = (v) => typeof v === 'number' && Number.isFinite(v) ? v : NO
export const int = (min: number): Check<number> => (v) => Number.isSafeInteger(v) && (v as number) >= min ? v as number : NO
export const bool: Check<boolean> = (v) => typeof v === 'boolean' ? v : NO
export const oneOf = <T>(...values: readonly T[]): Check<T> => (v) => values.includes(v as T) ? v as T : NO

export const nullable = <T>(check: Check<T>): Check<T | null> => (v) => v === null ? null : check(v)
/** A key the object may leave out. */
export const optional = <T>(check: Check<T>): Check<T | undefined> => (v) => v === undefined ? undefined : check(v)
/** What `check` takes, changed. Not named `then`: a module exporting `then` is a thenable, and `await import()` of it
 *  never settles. */
export const andThen = <A, B>(check: Check<A>, change: (value: A) => B): Check<B> => (v) => {
  const value = check(v)
  return value === NO ? NO : change(value)
}

/** An array whose every item passes. */
export const list = <T>(check: Check<T>): Check<T[]> => (v) => {
  if (!Array.isArray(v)) return NO
  const out: T[] = []
  for (const item of v) {
    const value = check(item)
    if (value === NO) return NO
    out.push(value)
  }
  return out
}

const plain = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null

/** An object whose every value passes, under any key. Built with `fromEntries`, so a key `__proto__` stays a key. */
export const record = <T>(check: Check<T>): Check<Record<string, T>> => (v) => {
  const o = plain(v)
  if (!o) return NO
  const out: Array<[string, T]> = []
  for (const [key, item] of Object.entries(o)) {
    const value = check(item)
    if (value === NO) return NO
    out.push([key, value])
  }
  return Object.fromEntries(out)
}

/**
 * An object with these keys: `strict` refuses one with any other key (zod's `.strict()`), otherwise other keys are
 * left out of what it answers. Only the object's own keys are read, never what its prototype has.
 */
export const object = <T>(fields: { [K in keyof T]-?: Check<T[K]> }, strict = true): Check<T> => {
  const keys = Object.keys(fields) as Array<keyof T & string>
  return (v) => {
    const o = plain(v)
    if (!o || (strict && Object.keys(o).some((key) => !Object.hasOwn(fields, key)))) return NO
    const out: Record<string, unknown> = {}
    for (const key of keys) {
      const value = fields[key](Object.hasOwn(o, key) ? o[key] : undefined)
      if (value === NO) return NO
      if (value !== undefined) out[key] = value
    }
    return out as T
  }
}
