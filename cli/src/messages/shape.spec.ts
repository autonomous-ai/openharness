import { describe, expect, it } from 'vitest'
import { bool, datetime, int, list, NO, nullable, num, object, oneOf, optional, record, text, andThen } from './shape.js'

describe('reading a shape by hand', () => {
  it('takes a string within its length and pattern', () => {
    expect(text()('')).toBe('')
    expect(text()(7)).toBe(NO)
    expect(text(3)('abcd')).toBe(NO)
    expect(text(3, 1)('')).toBe(NO)
    expect(text(3, 1)('abc')).toBe('abc')
    expect(text(Infinity, 0, /^a+$/)('aaa')).toBe('aaa')
    expect(text(Infinity, 0, /^a+$/)('ab')).toBe(NO)
  })

  it('takes a date only as zod took it: UTC, a real day, seconds optional', () => {
    const at = datetime()
    for (const ok of ['2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00Z', '2026-10-15T00:00Z', '2026-10-15T23:59:59.123456Z', '2024-02-29T00:00:00Z', '2000-02-29T00:00Z'])
      expect(at(ok), ok).toBe(ok)
    for (const bad of ['2026-10-15T00:00:00+01:00', '2026-10-15T00:00:00', '2026-13-01T00:00:00Z', '2026-02-29T00:00:00Z', '1900-02-29T00:00Z',
      '2026-04-31T00:00Z', '2026-10-15T24:00:00Z', '2026-10-15T00:00:60Z', '2026-10-15', ' 2026-10-15T00:00Z', 1])
      expect(at(bad), String(bad)).toBe(NO)
    expect(datetime(10)('2026-10-15T00:00Z')).toBe(NO)
  })

  it('takes finite numbers, safe integers from a floor, booleans and listed values', () => {
    expect(num(1.5)).toBe(1.5)
    expect(num(Infinity)).toBe(NO)
    expect(num('1')).toBe(NO)
    expect(int(1)(1)).toBe(1)
    expect(int(1)(0)).toBe(NO)
    expect(int(1)(1.5)).toBe(NO)
    expect(int(1)(2 ** 53)).toBe(NO)
    expect(int(1)('2')).toBe(NO)
    expect(bool(false)).toBe(false)
    expect(bool(0)).toBe(NO)
    expect(oneOf('a', 'b')('b')).toBe('b')
    expect(oneOf('a', 'b')('c')).toBe(NO)
    expect(oneOf(true)(1)).toBe(NO)
  })

  it('takes null, a missing value, and changes what it took', () => {
    expect(nullable(num)(null)).toBeNull()
    expect(nullable(num)(undefined)).toBe(NO)
    expect(nullable(num)(2)).toBe(2)
    expect(optional(num)(undefined)).toBeUndefined()
    expect(optional(num)(null)).toBe(NO)
    expect(andThen(text(), (s) => s.length)('abc')).toBe(3)
    expect(andThen(text(), (s) => s.length)(3)).toBe(NO)
  })

  it('takes a list only when every item passes', () => {
    expect(list(num)([1, 2])).toEqual([1, 2])
    expect(list(num)([1, '2'])).toBe(NO)
    expect(list(num)({ 0: 1 })).toBe(NO)
  })

  it('takes a record only when every value passes, and keeps a __proto__ key a key', () => {
    expect(record(num)({ a: 1 })).toEqual({ a: 1 })
    expect(record(num)({ a: 'x' })).toBe(NO)
    expect(record(num)([1])).toBe(NO)
    expect(record(num)(null)).toBe(NO)
    const odd = record(num)(JSON.parse('{"__proto__":1}')) as Record<string, number>
    expect(Object.getPrototypeOf(odd)).toBe(Object.prototype)
    expect(Object.keys(odd)).toEqual(['__proto__'])
  })

  it('takes an object: strict refuses another key, otherwise it is left out; never reads the prototype', () => {
    type T = { a: number; b?: string }
    const strict = object<T>({ a: num, b: optional(text()) }), loose = object<T>({ a: num, b: optional(text()) }, false)
    expect(strict({ a: 1 })).toEqual({ a: 1 })
    expect(strict({ a: 1, b: 'x' })).toEqual({ a: 1, b: 'x' })
    expect(strict({ a: 1, c: 2 })).toBe(NO)
    expect(loose({ a: 1, c: 2 })).toEqual({ a: 1 })
    expect(strict({ b: 'x' })).toBe(NO)
    expect(strict({ a: 1, b: 2 })).toBe(NO)
    expect(strict([])).toBe(NO)
    expect(strict('x')).toBe(NO)
    expect(strict(null)).toBe(NO)
    // A key named like one the prototype has is read only when the object has it.
    expect(object<{ toString?: string }>({ toString: optional(text()) })({})).toEqual({})
  })
})
