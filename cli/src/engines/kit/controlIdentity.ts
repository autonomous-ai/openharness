/** Engine-declared opening records needed for eager session control. */
import { isAbsolute } from 'node:path'
import { nativeText, nativeUnavailable } from './nativeEvidence.js'

export interface ControlIdentityRule {
  maxBytes: number
  maxRecords: number
  type?: string
  id: readonly string[]
  cwd: readonly string[]
  idPattern?: RegExp
  sidechain?: string
  canonicalWorkspace?: boolean
}
const field = (record: unknown, path: readonly string[]): unknown => path.reduce<unknown>((value, key) =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined, record)

/** Bookkeeping may precede identity. A partial or invalid opening never proves a match. */
export function controlIdentity(bytes: Buffer, rule: ControlIdentityRule) {
  let id: string | undefined, cwd: string | undefined, side: boolean | undefined, start = 0
  for (let record = 0; record < rule.maxRecords; record++) {
    const end = bytes.indexOf(10, start)
    if (end < 0 || end >= rule.maxBytes) break
    const line = nativeText(bytes.subarray(start, end)); start = end + 1
    if (!line.trim()) continue
    let value: unknown
    try { value = JSON.parse(line) } catch { return nativeUnavailable('the conversation opening is incomplete or invalid') }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || rule.type && field(value, ['type']) !== rule.type) return nativeUnavailable('the conversation opening has an unexpected record')
    const nextId = field(value, rule.id), nextCwd = field(value, rule.cwd)
    if (nextId !== undefined && (typeof nextId !== 'string' || !nextId || rule.idPattern && !rule.idPattern.test(nextId))) {
      return nativeUnavailable('the conversation opening has an invalid identity')
    }
    if (nextCwd !== undefined && (typeof nextCwd !== 'string' || !isAbsolute(nextCwd))) {
      return nativeUnavailable('the conversation opening has an invalid workspace')
    }
    if (id && nextId !== undefined && nextId !== id || cwd && nextCwd !== undefined && nextCwd !== cwd) {
      return nativeUnavailable('the conversation opening has conflicting identities')
    }
    id ??= nextId as string | undefined
    cwd ??= nextCwd as string | undefined
    if (rule.sidechain) {
      const valueSide = field(value, [rule.sidechain])
      if (valueSide !== undefined && typeof valueSide !== 'boolean') return nativeUnavailable('the conversation delegation is unconfirmed')
      if (side !== undefined && valueSide !== undefined && valueSide !== side) return nativeUnavailable('the conversation opening has conflicting delegation')
      side ??= valueSide as boolean | undefined
    }
    if (id && cwd) return { id, cwd, delegated: side === true, bytes: start }
  }
  return nativeUnavailable('the conversation opening is incomplete or exceeds its read limit')
}
