/** Raw image reads are confined to the storage/models process, with one actual descriptor owner. */
import { constants, fchmodSync, fstatSync, lstatSync, openSync, readFileSync, readSync, type BigIntStats } from 'node:fs'
import { dirname } from 'node:path'
import { closeStateFileDescriptor, requireWindowsStateFile, secureStateDirectory, stateFileCustodyHealthy, StateFileCleanupUnconfirmed } from '../lib/secureState.js'
import { sameSessionFileIdentity, SessionStorageUnavailable, sessionStorageFailureCode } from '../lib/sessionStorageWire.js'

export async function readPrivateImage(file: string, maxBytes: number): Promise<{ bytes: Buffer; stat: BigIntStats } | null> {
  let fd: number | undefined
  try {
    stateFileCustodyHealthy()
    secureStateDirectory(dirname(file), false)
    if (process.platform === 'win32') requireWindowsStateFile(file)
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    let before = fstatSync(fd, { bigint: true })
    const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null
    if (!before.isFile() || uid !== null && before.uid !== uid || before.size > BigInt(maxBytes)
      || process.platform !== 'win32' && (before.mode & 0o022n) !== 0n) throw new SessionStorageUnavailable('unsafe')
    if (process.platform !== 'win32' && (before.mode & 0o777n) !== 0o600n) {
      fchmodSync(fd, 0o600)
      before = fstatSync(fd, { bigint: true })
      if ((before.mode & 0o777n) !== 0o600n) throw new SessionStorageUnavailable('unsafe')
    }
    let bytes: Buffer
    if (maxBytes === Number.MAX_SAFE_INTEGER) bytes = readFileSync(fd)
    else {
      const limit = maxBytes + 1
      bytes = Buffer.alloc(Math.min(Number(before.size) + 1, limit))
      let offset = 0
      while (offset < limit) {
        if (offset === bytes.length) {
          const grown = Buffer.alloc(Math.min(limit, bytes.length * 2))
          bytes.copy(grown)
          bytes = grown
        }
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
        if (!count) break
        offset += count
      }
      if (offset > maxBytes) throw new SessionStorageUnavailable('unsafe')
      bytes = bytes.subarray(0, offset)
    }
    const after = fstatSync(fd, { bigint: true }), path = lstatSync(file, { bigint: true })
    if (!sameSessionFileIdentity(before, after) || !sameSessionFileIdentity(after, path)) {
      throw new SessionStorageUnavailable('changed')
    }
    return { bytes, stat: after }
  } catch (error) {
    if (error instanceof StateFileCleanupUnconfirmed) throw new SessionStorageUnavailable('cleanup-unconfirmed')
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new SessionStorageUnavailable(sessionStorageFailureCode(error))
  } finally {
    if (fd !== undefined) {
      // The shared owner keeps a failed close sticky until actual process exit, without retrying a reused FD.
      try { closeStateFileDescriptor(fd) }
      catch { throw new SessionStorageUnavailable('cleanup-unconfirmed') }
    }
  }
}
