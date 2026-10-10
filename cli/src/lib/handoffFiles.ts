/** Finite descriptor reads and retained routes for the handoff transaction. No daemon state. */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { NativeFiles } from '../engines/kit/nativeFiles.js'
import { NativeEvidenceBudget } from '../engines/kit/nativeEvidence.js'
import { nativeFileKey, verifyNativePathFacts } from '../engines/kit/nativePaths.js'
import { HandoffError, nativeContentVersion, type NativeHandoffRead } from './handoffAuthority.js'

/** Last native-content fence, after header, catalog and ancestor verification. No body is read here. */
export function verifyHandoffVersion(read: NativeHandoffRead, version: string): void {
  const fd = openSync(read.readPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    verifyNativePathFacts(read.route)
    const info = fstatSync(fd, { bigint: true })
    if (!info.isFile() || info.nlink < 1n || nativeFileKey(info) !== read.fileKey
      || nativeContentVersion(info) !== version) throw new HandoffError('IDENTITY_UNAVAILABLE')
  } finally { closeSync(fd) }
}

export function readHandoffFile(path: string, limit: number, privateMode = false) {
  const files = new NativeFiles(), location = files.locate(path, true)
  if (!location) return { path, text: null, key: null, version: null, route: files.paths.snapshot() }
  let fd: number | undefined
  const hold = (): never => { throw new HandoffError('HANDOFF_UNAVAILABLE') }
  try {
    if (location.path !== path) return hold()
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    const before = fstatSync(fd, { bigint: true })
    if (!before.isFile() || nativeFileKey(before) !== nativeFileKey(location.info)
      || typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid())
      || before.size > BigInt(limit) || before.nlink < 1n
      || (before.mode & (privateMode ? 0o077n : 0o022n)) !== 0n) return hold()
    const bytes = Buffer.alloc(Number(before.size)), budget = new NativeEvidenceBudget(250)
    for (let at = 0, calls = 0; at < bytes.length; calls++) {
      budget.step()
      if (calls >= 128) return hold()
      const count = readSync(fd, bytes, at, Math.min(256 * 1024, bytes.length - at), at)
      if (!count) return hold()
      at += count
    }
    if (nativeContentVersion(fstatSync(fd, { bigint: true })) !== nativeContentVersion(before)) return hold()
    files.verify()
    return { path, text: bytes.toString('utf8'), key: nativeFileKey(before), version: nativeContentVersion(before), route: files.paths.snapshot() }
  } finally { if (fd !== undefined) closeSync(fd) }
}
