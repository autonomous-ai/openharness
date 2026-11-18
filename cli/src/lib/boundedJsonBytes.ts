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
  let bytes = 0, visits = 0, item = value
  const stack: Container[] = [], ancestors = new Set<object>()
  // V12 sampled repeated helper creation here. One walk keeps the same checks without per-call functions.
  try {
    for (;;) {
      if (++visits > limit) return null
      if (item === null) bytes += 4
      else if (typeof item === 'string') {
        const size = jsonStringBytes(item, limit - bytes)
        if (size === null) return null
        bytes += size
      } else if (typeof item === 'boolean') bytes += item ? 4 : 5
      else if (typeof item === 'number') {
        if (!Number.isFinite(item)) return null
        bytes += String(item).length
      } else {
        if (typeof item !== 'object' || types.isProxy(item)) return null
        const array = Array.isArray(item) ? item : null, prototype = Object.getPrototypeOf(item)
        if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) return null
        const toJSON = descriptor(item, 'toJSON')
        if (toJSON && (!('value' in toJSON) || typeof toJSON.value === 'function')) return null
        if (ancestors.has(item) || stack.length >= BOUNDED_JSON_DEPTH || (bytes += 2) > limit) return null
        // Even an array of single-digit numbers costs two bytes per item, less its first comma.
        if (array && array.length > 0 && array.length * 2 - 1 > limit - bytes) return null
        ancestors.add(item)
        stack.push({ value: item, array, keys: array ? null : ownKeys(item), index: 0, first: true })
      }
      if (bytes > limit) return null
      let found = false
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
        item = entry?.value
        if (item === undefined) {
          if (!held.array) continue
          item = null
        }
        if (!held.first && ++bytes > limit) return null
        held.first = false
        if (!held.array) {
          const size = jsonStringBytes(key, limit - bytes)
          if (size === null || (bytes += size + 1) > limit) return null
        }
        found = true
        break
      }
      if (!found) return bytes
    }
  } catch { return null }
}
