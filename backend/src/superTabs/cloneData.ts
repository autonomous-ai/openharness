/** A deep copy of plain data (objects, arrays, primitives, Dates), faster than `structuredClone` on Swarm state. Any other
 *  value (a Map, Set, class instance or function) throws with its path, so a new kind of value fails loudly, never mangled. */
export function cloneData<T>(value: T): T {
  try {
    return copy(value)
  } catch (error) {
    if (error !== UNCOPYABLE) throw error
    const found = uncopyable(value, [])!
    throw new TypeError(`cloneData: cannot copy a ${found.kind} at ${found.path.join('.') || '(root)'}`)
  }
}

/** Thrown while copying; the path is found afterwards, so a successful copy never pays for it. */
const UNCOPYABLE = Symbol('uncopyable')

const plain = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function copy<T>(value: T): T {
  if (typeof value !== 'object' || value === null) {
    if (typeof value === 'function' || typeof value === 'symbol') throw UNCOPYABLE
    return value
  }
  if (Array.isArray(value)) return value.map(copy) as T
  if (value instanceof Date) return new Date(value.getTime()) as T
  if (!plain(value)) throw UNCOPYABLE
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    const item = copy((value as Record<string, unknown>)[key])
    // An own `__proto__` key stays a key: assigned, it would set the copy's prototype instead.
    if (key === '__proto__') Object.defineProperty(out, key, { value: item, enumerable: true, writable: true, configurable: true })
    else out[key] = item
  }
  return out as T
}

function uncopyable(value: unknown, path: string[]): { kind: string; path: string[] } | null {
  if (typeof value === 'function' || typeof value === 'symbol') return { kind: typeof value, path }
  if (typeof value !== 'object' || value === null || value instanceof Date) return null
  if (!Array.isArray(value) && !plain(value)) return { kind: value.constructor?.name || 'object', path }
  for (const [key, item] of Object.entries(value)) {
    const found = uncopyable(item, [...path, key])
    if (found) return found
  }
  return null
}
