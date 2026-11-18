/** The actual child-owned index, directly composed only by isolated unit fixtures. */
import { createPendingCreationIndex } from '../storage/pendingCreations.js'
import type { PendingCreationDiscovery } from '../lib/pendingCreationWire.js'

export function localPendingCreationDiscovery(directory: string): PendingCreationDiscovery {
  const index = createPendingCreationIndex(directory)
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
