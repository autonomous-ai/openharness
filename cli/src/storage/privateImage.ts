/** Raw image reads are confined to the storage/models process, with one actual descriptor owner. */
import { constants, type BigIntStats } from 'node:fs'
import * as fs from 'node:fs/promises'
import { dirname } from 'node:path'
import { requireWindowsStateFile, secureStateDirectory, StateFileCleanupUnconfirmed } from '../lib/secureState.js'
import { sameSessionFileIdentity, SessionStorageUnavailable } from '../lib/sessionStorageWire.js'

// A failed close is deliberately never retried; the child must exit before its parent releases custody.
const uncertain = new Set<fs.FileHandle>()

export async function readPrivateImage(file: string, maxBytes: number): Promise<{ bytes: Buffer; stat: BigIntStats } | null> {
  if (uncertain.size) throw new SessionStorageUnavailable('cleanup-unconfirmed')
  let handle: fs.FileHandle | undefined
  try {
    secureStateDirectory(dirname(file), false)
    if (process.platform === 'win32') requireWindowsStateFile(file)
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    let before = await handle.stat({ bigint: true })
    const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null
    if (!before.isFile() || uid !== null && before.uid !== uid || before.size > BigInt(maxBytes)
      || process.platform !== 'win32' && (before.mode & 0o022n) !== 0n) throw new SessionStorageUnavailable('unsafe')
    if (process.platform !== 'win32' && (before.mode & 0o777n) !== 0o600n) {
      await handle.chmod(0o600)
      before = await handle.stat({ bigint: true })
      if ((before.mode & 0o777n) !== 0o600n) throw new SessionStorageUnavailable('unsafe')
    }
    let bytes: Buffer
    if (maxBytes === Number.MAX_SAFE_INTEGER) bytes = await handle.readFile()
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
        const read = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (!read.bytesRead) break
        offset += read.bytesRead
      }
      if (offset > maxBytes) throw new SessionStorageUnavailable('unsafe')
      bytes = bytes.subarray(0, offset)
    }
    const after = await handle.stat({ bigint: true }), path = await fs.lstat(file, { bigint: true })
    if (!sameSessionFileIdentity(before, after) || !sameSessionFileIdentity(after, path)) {
      throw new SessionStorageUnavailable('changed')
    }
    return { bytes, stat: after }
  } catch (error) {
    if (error instanceof StateFileCleanupUnconfirmed) throw new SessionStorageUnavailable('cleanup-unconfirmed')
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof SessionStorageUnavailable) throw error
    throw new SessionStorageUnavailable('unsafe')
  } finally {
    if (handle) {
      const closing = handle
      handle = undefined
      try { await closing.close() }
      catch { uncertain.add(closing); throw new SessionStorageUnavailable('cleanup-unconfirmed') }
    }
  }
}
