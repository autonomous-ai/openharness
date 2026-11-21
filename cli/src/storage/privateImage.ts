/** Raw image reads are confined to the storage/models process, with one actual descriptor owner. */
import { constants, fchmodSync, fstatSync, lstatSync, openSync, readFileSync, readSync, type BigIntStats } from 'node:fs'
import { dirname } from 'node:path'
import { closeStateFileDescriptor, requireWindowsStateFile, secureStateDirectory, stateFileCustodyHealthy, StateFileCleanupUnconfirmed } from '../lib/secureState.js'
import { sameSessionFileIdentity, SessionStorageUnavailable, sessionStorageFailureCode } from '../lib/sessionStorageWire.js'

export type PrivateImageReader = (file: string, maxBytes: number) => Promise<{ bytes: Buffer; stat: BigIntStats } | null>

export const readPrivateImage: PrivateImageReader = (file, maxBytes) => readImage(file, maxBytes,
  () => secureStateDirectory(dirname(file), false))

/** Keep every directory admission check; a bounded page needs only one retained open/close pair. */
export async function withPrivateImageDirectory<T>(directory: string, work: (read: PrivateImageReader, inspect: (file: string) => BigIntStats | null,
  directoryStat: () => BigIntStats) => Promise<T>): Promise<T> {
  let fd: number | undefined, active = true
  try {
    stateFileCustodyHealthy()
    let verify = () => secureStateDirectory(directory, false)
    if (process.platform !== 'win32') {
      secureStateDirectory(directory, false)
      fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      const original = fstatSync(fd, { bigint: true })
      const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null
      verify = () => {
        stateFileCustodyHealthy()
        const inspect = (): boolean => {
          const descriptor = fstatSync(fd!, { bigint: true }), path = lstatSync(directory, { bigint: true })
          for (const stat of [descriptor, path]) {
            if (!stat.isDirectory() || uid !== null && stat.uid !== uid || (stat.mode & 0o022n) !== 0n) {
              throw new SessionStorageUnavailable('unsafe')
            }
            if (stat.dev !== original.dev || stat.ino !== original.ino) throw new SessionStorageUnavailable('changed')
          }
          return (descriptor.mode & 0o777n) === 0o700n && (path.mode & 0o777n) === 0o700n
        }
        if (!inspect()) {
          fchmodSync(fd!, 0o700)
          // Tightening does not excuse a replacement between the descriptor and pathname checks.
          if (!inspect()) throw new SessionStorageUnavailable('unsafe')
        }
      }
      verify()
    }
    let directoryFailure: SessionStorageUnavailable | undefined
    const check = () => {
      if (directoryFailure) throw directoryFailure
      try { verify() }
      catch (error) {
        // An individual file may be skipped. A failed container admission revokes the entire page,
        // even if another writer restores its path or permissions before the final fence.
        directoryFailure = new SessionStorageUnavailable(error instanceof StateFileCleanupUnconfirmed
          ? 'cleanup-unconfirmed' : sessionStorageFailureCode(error))
        throw directoryFailure
      }
    }
    const admit = (file: string) => {
      if (!active || dirname(file) !== directory) throw new SessionStorageUnavailable('invalid')
      check()
    }
    const value = await work((file, maxBytes) => readImage(file, maxBytes, () => admit(file)), file => {
      admit(file)
      try {
        if (process.platform === 'win32') requireWindowsStateFile(file)
        return lstatSync(file, { bigint: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw new SessionStorageUnavailable(sessionStorageFailureCode(error))
      }
    }, () => {
      if (!active) throw new SessionStorageUnavailable('invalid')
      check()
      try {
        const stat = fd === undefined ? lstatSync(directory, { bigint: true }) : fstatSync(fd, { bigint: true })
        check()
        if (fd === undefined) {
          const after = lstatSync(directory, { bigint: true })
          for (const field of ['dev', 'ino', 'birthtimeNs', 'mode', 'uid', 'gid'] as const) {
            if (stat[field] !== after[field]) throw new SessionStorageUnavailable('changed')
          }
        }
        return stat
      } catch (error) {
        directoryFailure = new SessionStorageUnavailable(error instanceof StateFileCleanupUnconfirmed
          ? 'cleanup-unconfirmed' : sessionStorageFailureCode(error))
        throw directoryFailure
      }
    })
    check()
    return value
  } catch (error) {
    if (error instanceof StateFileCleanupUnconfirmed) throw new SessionStorageUnavailable('cleanup-unconfirmed')
    throw new SessionStorageUnavailable(sessionStorageFailureCode(error))
  } finally {
    active = false
    if (fd !== undefined) {
      try { closeStateFileDescriptor(fd) }
      catch { throw new SessionStorageUnavailable('cleanup-unconfirmed') }
    }
  }
}

async function readImage(file: string, maxBytes: number, admitDirectory: () => void): ReturnType<PrivateImageReader> {
  let fd: number | undefined
  try {
    stateFileCustodyHealthy()
    admitDirectory()
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
