import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { describe, expect, it, vi } from 'vitest'
import { boundedJsonBytes, BOUNDED_JSON_DEPTH } from './boundedJsonBytes.js'

describe('bounded JSON admission', () => {
  it('counts every supported primitive and nested value at its exact byte boundary', () => {
    const shared = { same: 'é🌍\u0000\n\\"\ud800' }
    const values = [null, true, false, 0, -0, 1e100, '', 'a', shared.same, [], {},
      [undefined, , 1], { absent: undefined, present: [shared, shared] },
      Object.assign(Object.create(null), { field: 'value' }), Object.setPrototypeOf([1], null),
      { toJSON: 'ordinary data' }]
    for (const value of values) {
      const expected = Buffer.byteLength(JSON.stringify(value))
      expect(boundedJsonBytes(value, expected)).toBe(expected)
      expect(boundedJsonBytes(value, expected - 1)).toBeNull()
      expect(boundedJsonBytes(value, expected + 10)).toBe(expected)
    }
    for (const limit of [-1, 0.5, Infinity, NaN]) expect(boundedJsonBytes(null, limit)).toBeNull()
    for (const value of [undefined, NaN, Infinity, 1n, Symbol('data'), () => {}, new Date(), new Map()]) {
      expect(boundedJsonBytes(value, 100)).toBeNull()
    }
  })

  it('bounds omitted entries, depth and width while permitting repeated acyclic objects', () => {
    const shared = { value: 1 }, repeated = [shared, shared]
    expect(boundedJsonBytes(repeated, 100)).toBe(Buffer.byteLength(JSON.stringify(repeated)))
    const omitted = Object.fromEntries(Array.from({ length: 100 }, (_, n) => [`omitted${n}`, undefined]))
    expect(boundedJsonBytes(omitted, 32)).toBeNull()
    expect(boundedJsonBytes(new Array(100), 32)).toBeNull()
    let nested: unknown = 0
    for (let n = 0; n < BOUNDED_JSON_DEPTH; n++) nested = [nested]
    expect(boundedJsonBytes(nested, 100_000)).toBe(2 * BOUNDED_JSON_DEPTH + 1)
    expect(boundedJsonBytes([nested], 100_000)).toBeNull()
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    const array: unknown[] = []; array.push(array)
    expect(boundedJsonBytes(cycle, 100)).toBeNull()
    expect(boundedJsonBytes(array, 100)).toBeNull()
  })

  it('never calls a getter, proxy trap or toJSON while checking a whole value', () => {
    const invoked = vi.fn(() => { throw new Error('PRIVATE') })
    const getter = Object.defineProperty({}, 'value', { enumerable: true, get: invoked })
    const array = Object.defineProperty([0], '0', { get: invoked })
    const jsonGetter = Object.defineProperty({}, 'toJSON', { get: invoked })
    const proxy = new Proxy({}, { get: invoked, getPrototypeOf: invoked, ownKeys: invoked })
    for (const value of [getter, array, jsonGetter, proxy, { toJSON: invoked }, { nested: proxy }]) {
      expect(boundedJsonBytes(value, 1_000)).toBeNull()
    }
    expect(invoked).not.toHaveBeenCalled()
  })

  it('keeps JSON array-hole lookup semantics without invoking inherited accessors', () => {
    const original = Object.getOwnPropertyDescriptor(Array.prototype, '100')
    const array = new Array(101), invoked = vi.fn(() => 'private')
    let inherited: number | null = null, refused: number | null = 0
    try {
      Object.defineProperty(Array.prototype, '100', { configurable: true, value: 'inherited' })
      inherited = boundedJsonBytes(array, 1_000)
      Object.defineProperty(Array.prototype, '100', { configurable: true, get: invoked })
      refused = boundedJsonBytes(array, 1_000)
    } finally {
      if (original) Object.defineProperty(Array.prototype, '100', original)
      else Reflect.deleteProperty(Array.prototype, '100')
    }
    expect(inherited).toBe(1 + 100 * 5 + Buffer.byteLength('"inherited"') + 1)
    expect(refused).toBeNull(); expect(invoked).not.toHaveBeenCalled()
  })

  it('allocates no named helper functions for a count in the release transform', () => {
    // V12 sampled the three per-call function-name writes; use the real release transform,
    // not a wall-clock assertion or a synthetic alternative to the byte counter.
    const built = buildSync({ entryPoints: [fileURLToPath(new URL('./boundedJsonBytes.ts', import.meta.url))],
      bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node20',
      minify: true, keepNames: true, logLevel: 'silent' })
    let counting = false, writes = 0
    const object = new Proxy(Object, { get(target, key, receiver) {
      if (key !== 'defineProperty') return Reflect.get(target, key, receiver)
      return (value: object, property: PropertyKey, descriptor: PropertyDescriptor) => {
        if (counting && typeof value === 'function' && property === 'name') writes++
        return Object.defineProperty(value, property, descriptor)
      }
    } })
    const module = { exports: {} as { boundedJsonBytes: typeof boundedJsonBytes } }
    runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url),
      Object: object, Array, Buffer }, { timeout: 1_000 })
    const value = { type: 'row', payload: { index: 0, value: ['registered', 'agent', 'session', 'claude',
      1, null, 0, true, '/synthetic/work', false, ['failed', 'FAILED', false], 'Name', true, null, false, false] } }
    const expected = Buffer.byteLength(JSON.stringify(value))
    counting = true
    for (let n = 0; n < 64; n++) expect(module.exports.boundedJsonBytes(value, 16 * 1024 * 1024)).toBe(expected)
    counting = false
    expect(writes).toBe(0)
  })
})
