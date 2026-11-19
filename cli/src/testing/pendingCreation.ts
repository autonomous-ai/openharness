/** The actual child-owned index, directly composed only by isolated unit fixtures. */
import { lstatSync } from 'node:fs'
import { SessionStorageUnavailable } from '../lib/sessionStorageWire.js'
import { createPendingCreationIndex } from '../storage/pendingCreations.js'
import type { PendingCreationDiscovery } from '../lib/pendingCreationWire.js'

/** Scanner unit controls use explicit absolute paths; production cwd binding is tested in its child. */
export function localPendingCreationIndex(directory: string) {
  let admitted: string | undefined
  const verify = (): string | undefined => {
    if (admitted === undefined) return
    const stat = lstatSync(directory, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || process.platform !== 'win32' && (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o022n) !== 0n)) {
      throw new SessionStorageUnavailable('unsafe')
    }
    const proof = [stat.dev, stat.ino, stat.birthtimeNs, stat.mode, stat.uid, stat.gid].join(':')
    if (proof !== admitted) throw new SessionStorageUnavailable('changed')
    return proof
  }
  return createPendingCreationIndex(directory, { path: directory, verify,
    admit(expected) { admitted ??= expected; verify(); if (admitted !== expected) throw new SessionStorageUnavailable('changed') } })
}

export function localPendingCreationDiscovery(directory: string): PendingCreationDiscovery {
  const index = localPendingCreationIndex(directory)
  return {
    ensure: async id => index.ensure(id),
    async *scan() {
      let cursor: string | null = null
      try {
        for (;;) {
          const page = await index.page(cursor, performance.now() + 5_000)
          cursor = page.cursor
          for (const id of page.ids) yield id
          if (page.done) { cursor = null; return }
          if (!page.ids.length) yield null
        }
      } finally { if (cursor) await index.close(cursor) }
    },
  }
}
