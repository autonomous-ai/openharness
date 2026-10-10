import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'

export interface RecoveryBoundary { offset: number; device: number; inode: number; digest: string }
export type TranscriptFileIdentity = Pick<RecoveryBoundary, 'device' | 'inode'>

export async function verifyTranscriptHandle(handle: FileHandle, expected?: TranscriptFileIdentity): Promise<void> {
  if (!expected) return
  const actual = await handle.stat()
  if (!actual.isFile() || actual.dev !== expected.device || actual.ino !== expected.inode) {
    throw new Error('ENGINE_CONTROL_BOUNDARY_CHANGED')
  }
}

/** The control action does not wait for an interpreter. At most 1 KiB is read synchronously to bind
 * its boundary to a regular file and its surrounding bytes. Unknown evidence is retained as a hold. */
export function recoveryBoundary(file: string, at?: RecoveryBoundary): RecoveryBoundary {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd), offset = at?.offset ?? before.size
    if (!before.isFile() || before.size < offset) throw new Error('the transcript was replaced or truncated')
    const bytes = Math.min(offset, 512), first = Buffer.alloc(bytes), last = Buffer.alloc(bytes)
    if (readSync(fd, first, 0, bytes, 0) !== bytes || readSync(fd, last, 0, bytes, offset - bytes) !== bytes) {
      throw new Error('the transcript boundary is unreadable')
    }
    if (offset && last[bytes - 1] !== 10) throw new Error('the transcript boundary is an incomplete record')
    const after = fstatSync(fd), path = lstatSync(file)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || path.dev !== after.dev || path.ino !== after.ino || path.isSymbolicLink()) {
      throw new Error('the transcript changed while its boundary was read')
    }
    const result = { offset, device: after.dev, inode: after.ino,
      digest: createHash('sha256').update(first).update(last).digest('hex') }
    if (at && (at.device !== result.device || at.inode !== result.inode || at.digest !== result.digest)) {
      throw new Error('the transcript no longer matches the control boundary')
    }
    return result
  } finally { closeSync(fd) }
}
