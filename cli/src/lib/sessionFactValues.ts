/** Detached JSON presentation values; no feature-specific payload is interpreted here. */
import { types } from 'node:util'
import { jsonStringBytes } from './jsonStringBytes.js'

export type SessionValue = null | boolean | number | string | SessionValue[] | { [key: string]: SessionValue }
export interface SessionValueCharge { bytes: number; objects: number; properties: number; slots: number }
export interface SessionValueLimit extends SessionValueCharge { depth: number }
const unsafe = new Set(['__proto__', 'prototype', 'constructor', 'toJSON'])

/** Shared node/byte accounting is charged before each allocation, including an inline caller's descriptors. */
function inspect(input: unknown, limit: SessionValueLimit, keep: boolean): { value: SessionValue; charge: SessionValueCharge } {
  const charge: SessionValueCharge = { bytes: 0, objects: 0, properties: 0, slots: 0 }
  const parents = new Set<object>()
  const invalid = (): never => { throw new Error('SESSION_OWNER_INVALID') }
  const add = (key: keyof SessionValueCharge, amount: number): void => {
    charge[key] += amount
    if (charge[key] > limit[key]) throw new Error('SESSION_OWNER_LIMIT')
  }
  const text = (value: string): void => {
    const size = jsonStringBytes(value, limit.bytes - charge.bytes)
    if (size === null) throw new Error('SESSION_OWNER_LIMIT')
    add('bytes', size)
  }
  const copy = (value: unknown, depth: number): SessionValue => {
    if (value === null) { add('bytes', 4); return null }
    if (typeof value === 'boolean') { add('bytes', value ? 4 : 5); return value }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return invalid()
      add('bytes', String(value).length); return value
    }
    if (typeof value === 'string') { text(value); return value }
    if (!value || typeof value !== 'object' || types.isProxy(value) || parents.has(value)) return invalid()
    if (depth >= limit.depth) throw new Error('SESSION_OWNER_LIMIT')
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
    if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) return invalid()
    add('objects', 1); add('bytes', 2)
    parents.add(value)
    // Match ordinary parsed JSON/our measured flat layout. Unsafe property names are refused before assignment.
    const output: SessionValue[] | { [key: string]: SessionValue } = keep ? array ? [] : {} : value as SessionValue[]
    let seen = 0
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === 'length') continue
      if (typeof key !== 'string' || unsafe.has(key)) return invalid()
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return invalid()
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) !== seen)) return invalid()
      if (seen++) add('bytes', 1)
      if (array) add('slots', 1)
      else { add('properties', 1); text(key); add('bytes', 1) }
      const child = copy(descriptor.value, depth + 1)
      if (keep) {
        if (array) (output as SessionValue[]).push(child)
        else (output as { [key: string]: SessionValue })[key] = child
      }
    }
    parents.delete(value)
    if (array && seen !== value.length) return invalid()
    return output
  }
  return { value: copy(input, 0), charge }
}
export const copySessionValue = (input: unknown, limit: SessionValueLimit): { value: SessionValue; charge: SessionValueCharge } => inspect(input, limit, true)
/** Existing admitted rows are charged in place when another owner stages; no copied catalogue or per-row cache. */
export const measureSessionValue = (input: unknown, limit: SessionValueLimit): SessionValueCharge => inspect(input, limit, false).charge
