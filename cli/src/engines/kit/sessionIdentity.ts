/** Small native identity records needed by session control, independent of optional readers. */
import { isAbsolute, resolve } from 'node:path'
import { identityBytes, IdentityReadUnavailable } from './identityScan.js'

export const UNSETTLED: unique symbol = Symbol('unsettled')
type Field = readonly string[]
export interface SessionHeader {
  bytes: readonly number[]
  type: string
  id: { field: Field; pattern: RegExp }
  cwd: Field
}
export interface SessionFolder {
  prefix: string; suffix: string; trim: RegExp; mangle: RegExp; replacement: string
}
export interface RunIdentity {
  bytes: readonly number[]
  cwd: Field
  run: readonly { field: Field; value: string }[]
}
export interface NativeSessionHead { sessionId: string; cwd: string }

function valueAt(value: unknown, field: Field): unknown {
  for (const key of field) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}
function parsed(line: string): unknown {
  try { return JSON.parse(line) } catch { return null }
}

export function sessionFolder(rule: SessionFolder, cwd: string): string {
  return rule.prefix + cwd.replace(rule.trim, '').replace(rule.mangle, rule.replacement) + rule.suffix
}

/** A complete first JSON entry; blank/malformed lines are skipped, another valid entry refuses it.
 * The optional reader supplies its own I/O wrapper to retain its scan's read-failure evidence. */
export async function readSessionHeader(rule: SessionHeader, read: (bytes: number) => Promise<string>): Promise<NativeSessionHead | null | typeof UNSETTLED> {
  for (const bytes of rule.bytes) {
    const head = await read(bytes)
    for (const line of head.split('\n').slice(0, -1)) {
      if (!line.trim()) continue
      const record = parsed(line)
      if (record === null) continue
      if (valueAt(record, ['type']) !== rule.type) return null
      const id = valueAt(record, rule.id.field)
      const cwd = valueAt(record, rule.cwd)
      return typeof id === 'string' && rule.id.pattern.test(id)
        && typeof cwd === 'string' && cwd.startsWith('/') ? { sessionId: id, cwd: resolve(cwd) } : null
    }
    if (Buffer.byteLength(head) < bytes) return UNSETTLED
  }
  return null
}

/** A workspace in line one and a declared run marker. A bound never establishes absence:
 * if relevant evidence lies beyond it, the caller holds the lookup instead of guessing a sibling. */
export async function readRunIdentity(rule: RunIdentity, path: string, matches: (cwd: string) => Promise<boolean>): Promise<{ cwd: string } | null> {
  for (const bytes of rule.bytes) {
    const head = await identityBytes(path, bytes + 1).catch(error => {
      if (error instanceof IdentityReadUnavailable) throw error
      throw new IdentityReadUnavailable('the workspace identity could not be read')
    })
    const complete = head.length <= bytes
    const lines = head.subarray(0, bytes).toString('utf8').split('\n')
    if (!complete) lines.pop()
    if (!lines.length) continue
    const cwd = valueAt(parsed(lines[0]!), rule.cwd)
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new IdentityReadUnavailable('the workspace header is incomplete or invalid')
    if (!await matches(cwd)) return null
    let malformed = false
    for (const line of lines) {
      const record = parsed(line)
      if (line.trim() && record === null) malformed = true
      if (rule.run.every(part => valueAt(record, part.field) === part.value)) return { cwd }
    }
    if (complete) {
      if (malformed) throw new IdentityReadUnavailable('the run identity is incomplete or invalid')
      return null
    }
  }
  throw new IdentityReadUnavailable('the run identity exceeds the bounded read')
}
