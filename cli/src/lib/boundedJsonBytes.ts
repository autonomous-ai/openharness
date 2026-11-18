/** Exact byte admission shared by private peer bodies and negotiated session event frames. */
import { types } from 'node:util'
import { jsonStringBytes } from './jsonStringBytes.js'

export const BOUNDED_JSON_DEPTH = 4096
type Container = { value: object; array: unknown[] | null; keys: Iterator<string> | null; index: number; first: boolean }
function* ownKeys(value: object): Generator<string> {
  for (const key in value) if (Object.hasOwn(value, key)) yield key
}
function descriptor(value: object, key: string): PropertyDescriptor | undefined {
  for (let owner: object | null = value; owner !== null; owner = Object.getPrototypeOf(owner)) {
    const found = Object.getOwnPropertyDescriptor(owner, key)
    if (found) return found
  }
  return undefined
}

/** Exact JSON bytes, before copying a body. Stack space is bounded independently of message width. */
export function boundedJsonBytes(value: unknown, limit: number): number | null {
  if (!Number.isSafeInteger(limit) || limit < 0) return null
  let bytes = 0, visits = 0
  const stack: Container[] = [], ancestors = new Set<object>()
  const add = (amount: number): boolean => (bytes += amount) <= limit
  const string = (text: string): boolean => {
    const size = jsonStringBytes(text, limit - bytes)
    return size !== null && add(size)
  }
  const enter = (item: unknown): boolean => {
    if (++visits > limit) return false
    if (item === null) return add(4)
    if (typeof item === 'string') return string(item)
    if (typeof item === 'boolean') return add(item ? 4 : 5)
    if (typeof item === 'number') return Number.isFinite(item) && add(String(item).length)
    if (typeof item !== 'object' || types.isProxy(item)) return false
    const array = Array.isArray(item) ? item : null
    const prototype = Object.getPrototypeOf(item)
    if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) return false
    const toJSON = descriptor(item, 'toJSON')
    if (toJSON && (!('value' in toJSON) || typeof toJSON.value === 'function')) return false
    if (ancestors.has(item) || stack.length >= BOUNDED_JSON_DEPTH || !add(2)) return false
    // Even an array of single-digit numbers costs two bytes per item, less its first comma.
    if (array && array.length > 0 && array.length * 2 - 1 > limit - bytes) return false
    ancestors.add(item)
    stack.push({ value: item, array, keys: array ? null : ownKeys(item), index: 0, first: true })
    return true
  }
  try {
    if (!enter(value)) return null
    while (stack.length) {
      const held = stack[stack.length - 1]!
      let key: string
      if (held.array) {
        if (held.index === held.array.length) { ancestors.delete(held.value); stack.pop(); continue }
        key = String(held.index++)
      } else {
        const next = held.keys!.next()
        if (next.done) { ancestors.delete(held.value); stack.pop(); continue }
        key = next.value
      }
      // Omitted undefined properties still consume work. They cannot walk an unlimited zero-byte record.
      if (++visits > limit) return null
      const entry = held.array ? descriptor(held.value, key) : Object.getOwnPropertyDescriptor(held.value, key)
      if (entry && !('value' in entry)) return null
      let child: unknown = entry?.value
      if (child === undefined) {
        if (!held.array) continue
        child = null
      }
      if (!held.first && !add(1)) return null
      held.first = false
      if (!held.array && (!string(key) || !add(1))) return null
      if (!enter(child)) return null
    }
    return bytes
  } catch { return null }
}
