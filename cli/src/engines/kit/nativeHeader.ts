/** A descriptor's first record, fenced again after all asynchronous ownership reads. */
import { constants, openSync, closeSync, fstatSync, readSync, type BigIntStats } from 'node:fs'
import { lstat } from 'node:fs/promises'
import type { SessionStoreContract } from '../facets/sessionStore.js'
import { identityBytes, IdentityReadUnavailable } from './identityScan.js'
import { firstRecordMeta, type SessionMeta } from './sessionRecords.js'
import { NativeEvidenceBudget, nativeText, nativeUnavailable } from './nativeEvidence.js'
import { nativeFileKey } from './nativePaths.js'

export type NativeFirstRecord = NonNullable<SessionStoreContract['first']>
const stamp = (info: BigIntStats) => `${nativeFileKey(info)}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
export function firstLine(bytes: Buffer, maxBytes: number): string {
  // Do not decode a truncated UTF-8 character in the body after the complete metadata line.
  let start = 0
  while (start < Math.min(bytes.length, maxBytes)) {
    const end = bytes.indexOf(10, start)
    if ((end < 0 && bytes.length > maxBytes) || end > maxBytes) break
    const line = nativeText(bytes.subarray(start, end < 0 ? bytes.length : end))
    if (line.trim()) return line
    if (end < 0) break
    start = end + 1
  }
  return nativeUnavailable('the native rollout header is incomplete or exceeds its limit')
}

/** The same conclusive record rules serve descriptors, registry loading and hook admission. */
export function nativeSessionMeta(line: string, first: NativeFirstRecord): SessionMeta {
  const meta = firstRecordMeta(line, first)
  if (!meta || (!meta.isSubagent && (!meta.id || !meta.cwd || !meta.cwd.startsWith('/')))) return nativeUnavailable('the native rollout header is invalid')
  const record: unknown = JSON.parse(line)
  const field = (path: readonly string[]) => path.reduce((at: any, key) => at && typeof at === 'object' && !Array.isArray(at) ? at[key] : undefined, record)
  if (first.source) {
    const source: unknown = field(first.source.field)
    const object = source && typeof source === 'object' && !Array.isArray(source) ? source as Record<string, unknown> : null
    const keys = object ? Object.keys(object) : []
    const named = keys.length === 1 && first.source.named.includes(keys[0]) && typeof object![keys[0]] === 'string' && String(object![keys[0]]).trim()
    const child = keys.length === 1 && keys[0] === first.child.at(-1) && meta.isSubagent
    if (!(source === undefined && first.source.legacyMissing)
      && !(typeof source === 'string' && first.source.values.includes(source)) && !named && !child) {
      return nativeUnavailable('the native rollout source is invalid or unknown')
    }
  }
  if (meta.isSubagent) {
    const claim: unknown = field(first.child)
    if (!(typeof claim === 'string' && claim.trim())
      && !(claim && typeof claim === 'object' && !Array.isArray(claim) && meta.parentThreadId)) {
      return nativeUnavailable('the native rollout delegated-source claim is invalid')
    }
  }
  return meta
}

export async function descriptorHeader(path: string, identity: { device: bigint; inode: bigint },
  first: NativeFirstRecord, budget: NativeEvidenceBudget,
): Promise<{ meta: SessionMeta; verify(): void }> {
  budget.step()
  let line: string, meta: SessionMeta
  try {
    const version = await lstat(path)
    const bytes = await identityBytes(path, first.maxBytes + 1, { ...version, fileKey: identity }, budget)
    budget.step()
    line = firstLine(bytes, first.maxBytes)
    meta = nativeSessionMeta(line, first)
  } catch (error) {
    if (error instanceof IdentityReadUnavailable) throw error
    return nativeUnavailable('the native rollout header could not be read completely')
  }
  return { meta, verify: () => {
    budget.step()
    let fd: number | undefined
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
      const before = fstatSync(fd, { bigint: true })
      if (!before.isFile() || before.dev !== identity.device || before.ino !== identity.inode) return nativeUnavailable('the native rollout was replaced after inspection')
      const bytes = Buffer.alloc(first.maxBytes + 1)
      let length = 0
      for (let calls = 0; length < bytes.length; calls++) {
        budget.step()
        if (calls >= 64) return nativeUnavailable('the native header verification read limit was reached')
        const read = readSync(fd, bytes, length, bytes.length - length, length)
        budget.step(read)
        if (!read) break
        length += read
      }
      if (stamp(fstatSync(fd, { bigint: true })) !== stamp(before)
        || firstLine(bytes.subarray(0, length), first.maxBytes) !== line) return nativeUnavailable('the native rollout header changed during inspection')
    } catch (error) {
      if (error instanceof IdentityReadUnavailable) throw error
      return nativeUnavailable('the native rollout header became unreadable')
    } finally {
      if (fd !== undefined) { try { closeSync(fd) } catch { nativeUnavailable('the native rollout header could not be closed') } }
    }
  } }
}
