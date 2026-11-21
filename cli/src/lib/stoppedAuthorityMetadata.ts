/** Metadata only: final archive authority stays in core without reading an archive's contents. */
import { errorKind } from './log.js'
import { createHash } from 'node:crypto'
import { lstatSync, opendirSync, type BigIntStats, type Dir } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { secureStateDirectory, StateFileCleanupUnconfirmed } from './secureState.js'
import { sessionFileIdentity, SessionStorageUnavailable } from './sessionStorageWire.js'

export const STOPPED_AUTHORITY_ENTRIES = 16_384
export const STOPPED_AUTHORITY_MS = 50
const MASK = (1n << 256n) - 1n
const uncertain = new Set<Dir>()

export function stoppedAuthorityHealthy(): void {
  if (uncertain.size) throw new SessionStorageUnavailable('cleanup-unconfirmed')
}

/** A commutative digest avoids retaining or sorting the directory's complete path/stat table. */
function archiveDigest(identity: string) {
  let images = 0, sum = 0n
  return {
    add(name: string, image: string): void {
      images++
      sum = (sum + BigInt(`0x${createHash('sha256').update(name).update('\0').update(image).digest('hex')}`)) & MASK
    },
    digest: () => createHash('sha256').update(identity).update(`:${images}:${sum.toString(16)}`).digest('hex'),
  }
}

type ScanOptions = { entries?: number; now?: () => number; milliseconds?: number }
export function stoppedArchiveWitness(directory: string, options: ScanOptions = {}): string {
  stoppedAuthorityHealthy()
  const now = options.now ?? (() => performance.now()), expires = now() + (options.milliseconds ?? STOPPED_AUTHORITY_MS)
  const limit = options.entries ?? STOPPED_AUTHORITY_ENTRIES
  let dir: Dir | undefined, count = 0
  try {
    secureStateDirectory(directory, false)
    const stat = lstatSync(directory, { bigint: true }), before = sessionFileIdentity(stat)
    const observed = observeStoppedArchive(stat)
    dir = opendirSync(directory, { bufferSize: 32 })
    for (;;) {
      if (now() >= expires) throw new SessionStorageUnavailable('expired')
      const entry = dir.readSync()
      if (!entry) break
      if (++count > limit) throw new SessionStorageUnavailable('expired')
      if (!entry.name.endsWith('.json')) continue
      observed.add(entry.name, sessionFileIdentity(lstatSync(join(directory, entry.name), { bigint: true })))
    }
    const after = sessionFileIdentity(lstatSync(directory, { bigint: true }))
    if (before !== after) throw new SessionStorageUnavailable('changed')
    return observed.digest()
  } catch (error) {
    if (error instanceof StateFileCleanupUnconfirmed) throw new SessionStorageUnavailable('cleanup-unconfirmed')
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !dir) return 'missing'
    if (error instanceof SessionStorageUnavailable) throw error
    throw new SessionStorageUnavailable('unsafe')
  } finally {
    if (dir) {
      try { dir.closeSync() }
      catch (caughtFailure) { uncertain.add(dir); console.error(('[session-storage] authority descriptor close failed; restart required') + ' · ' + errorKind(caughtFailure)); throw new SessionStorageUnavailable('cleanup-unconfirmed') }
    }
  }
}

/** The page owner supplies its checked directory identity; each exact image supplies its own identity. */
export function observeStoppedArchive(stat: BigIntStats) {
  return archiveDigest([stat.dev, stat.ino, stat.birthtimeNs, stat.mode, stat.uid, stat.gid].join(':'))
}
