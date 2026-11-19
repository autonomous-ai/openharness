/** Small retained file facts for a core-owned operation, never a database reader. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from 'node:fs'
import { IdentityReadUnavailable } from './identityScan.js'
import { NativeEvidenceBudget, nativeUnavailable } from './nativeEvidence.js'
import { NativePaths, nativeFileKey } from './nativePaths.js'

const version = (info: BigIntStats) => `${nativeFileKey(info)}:${info.mode}:${info.uid}:${info.nlink}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
export interface NativeFileObservation {
  path: string
  key: string | null
  bytes?: Buffer
  verify(): void
}

/** No whole-store read: content is optional and limited by the caller's small declaration. */
export function observeNativeFile(path: string, options: { maxBytes?: number; missingOkay?: boolean } = {}): NativeFileObservation {
  const group = observeNativeFiles([{ path, ...options }])
  return { ...group.files[0], verify: group.verify }
}

/** Up to three files share one inspection budget and fresh route fence, never cached verification. */
export function observeNativeFiles(entries: readonly { path: string; maxBytes?: number; missingOkay?: boolean }[], base?: NativePaths): {
  files: Omit<NativeFileObservation, 'verify'>[]
  verify(): void
} {
  if (entries.length < 1 || entries.length > 3) nativeUnavailable('the native file group exceeds its member limit')
  const budget = new NativeEvidenceBudget()
  const paths = base?.fork(budget) ?? new NativePaths(budget)
  const observations = entries.map(entry => { budget.step(); return inspectNativeFile(entry.path, entry, paths, budget) })
  const verifyRoute = paths.retain()
  const verify = () => { verifyRoute(); for (const file of observations) file.verify() }
  verify()
  return { files: observations.map(({ verify: _verify, ...file }) => file), verify }
}

function inspectNativeFile(path: string, options: { maxBytes?: number; missingOkay?: boolean }, paths: NativePaths,
  budget: NativeEvidenceBudget): NativeFileObservation {
  const location = paths.resolveSync(path, options.missingOkay)
  let bytes: Buffer | undefined, before: string | undefined
  if (location) {
    let fd: number | undefined
    try {
      fd = openSync(location.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const info = fstatSync(fd, { bigint: true })
      if (!info.isFile() || nativeFileKey(info) !== nativeFileKey(location.info)
        || (process.getuid && info.uid !== BigInt(process.getuid()))) nativeUnavailable('the saved store has an unconfirmed identity, owner or type')
      before = version(info)
      if (options.maxBytes !== undefined) {
        if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || options.maxBytes > (1 << 20)
          || info.size > BigInt(options.maxBytes)) nativeUnavailable('the native record exceeds its byte limit')
        bytes = Buffer.alloc(Number(info.size))
        for (let at = 0, reads = 0; at < bytes.length; reads++) {
          budget.step()
          if (reads >= 64) nativeUnavailable('the native record exceeds its read limit')
          const count = readSync(fd, bytes, at, bytes.length - at, at)
          budget.step(count)
          if (!count) nativeUnavailable('the native record ended during its read')
          at += count
        }
      }
      if (version(fstatSync(fd, { bigint: true })) !== before) nativeUnavailable('the native file changed during inspection')
    } catch (error) {
      if (error instanceof IdentityReadUnavailable) throw error
      nativeUnavailable('the native file could not be read completely')
    } finally {
      if (fd !== undefined) { try { closeSync(fd) } catch { nativeUnavailable('the native file could not be closed') } }
    }
  }
  const verify = () => {
    if (location) {
      try {
        if (version(lstatSync(location.path, { bigint: true })) !== before) nativeUnavailable('the native file changed while saving')
      } catch (error) {
        if (error instanceof IdentityReadUnavailable) throw error
        nativeUnavailable('the native file became unreadable')
      }
    }
  }
  return { path: location?.path ?? path, key: location ? nativeFileKey(location.info) : null, ...(bytes && { bytes }), verify }
}
