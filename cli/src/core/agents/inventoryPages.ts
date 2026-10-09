import { createHash, randomUUID } from 'node:crypto'

type Page = { owner: string; scope: string; bytes: Buffer; sha256: string; expires: number; timer: ReturnType<typeof setTimeout> }
const RESET = { error: 'INVENTORY_RESET_REQUIRED' }

/** Full inventories and even individual rows can exceed a frame limit. Freeze
 * the logical reply once and fetch bounded byte pages; no projection repeats
 * between pages, and UTF-8 characters may safely span the base64 chunks. */
export function createInventoryPages({ now = Date.now, pageBytes = 128 * 1024,
  maxSnapshotBytes = 16 * 1024 * 1024, maxCacheBytes = 32 * 1024 * 1024,
  maxSnapshots = 8, ttlMs = 30_000 } = {}) {
  const pages = new Map<string, Page>()
  let retained = 0
  const remove = (id: string) => {
    const page = pages.get(id)!
    clearTimeout(page.timer)
    retained -= page.bytes.length
    pages.delete(id)
  }
  const expire = () => { for (const [id, page] of pages) if (page.expires <= now()) remove(id) }
  const chunk = (id: string, page: Page, offset: number) => {
    const end = Math.min(page.bytes.length, offset + pageBytes)
    return { inventoryPage: { version: 1, id, offset, totalBytes: page.bytes.length, sha256: page.sha256,
      data: page.bytes.subarray(offset, end).toString('base64'), nextOffset: end < page.bytes.length ? end : null } }
  }
  return {
    start(result: Record<string, unknown>, owner: string, scope: string): Record<string, unknown> {
      expire()
      const json = JSON.stringify(result), length = Buffer.byteLength(json)
      if (length <= pageBytes) return result
      if (length > maxSnapshotBytes || length > maxCacheBytes) return { error: 'INVENTORY_TOO_LARGE', maxBytes: Math.min(maxSnapshotBytes, maxCacheBytes) }
      // One active snapshot per connection; a restarted read replaces its old one.
      for (const [id, page] of pages) if (page.owner === owner) remove(id)
      while (pages.size >= maxSnapshots || retained + length > maxCacheBytes) remove(pages.keys().next().value!)
      const bytes = Buffer.from(json), id = randomUUID()
      const page = { owner, scope, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), expires: now() + ttlMs,
        // Release private bytes even if this still-connected window never polls again.
        timer: setTimeout(() => remove(id), ttlMs).unref() }
      pages.set(id, page); retained += length
      return chunk(id, page, 0)
    },
    next(cursor: unknown, owner: string, scope: string): Record<string, unknown> {
      expire()
      if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return RESET
      const { id, offset } = cursor as Record<string, unknown>
      if (typeof id !== 'string' || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset % pageBytes) return RESET
      const page = pages.get(id)
      if (!page || page.owner !== owner || page.scope !== scope || offset >= page.bytes.length) return RESET
      return chunk(id, page, offset)
    },
    close(owner: string): void { for (const [id, page] of pages) if (page.owner === owner) remove(id) },
  }
}
