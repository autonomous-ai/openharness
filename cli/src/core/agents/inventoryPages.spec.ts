import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { wrapPayload } from '../../lib/e2ee/core.js'
import { createInventoryPages } from './inventoryPages.js'

type Chunk = { version: number; id: string; offset: number; totalBytes: number; sha256: string; data: string; nextOffset: number | null }
const page = (reply: Record<string, unknown>) => reply.inventoryPage as Chunk
const reset = { error: 'INVENTORY_RESET_REQUIRED' }
const cursor = (p: Chunk) => ({ id: p.id, offset: p.nextOffset })

describe('bounded inventory fetches', () => {
  it('keeps small replies unchanged and freezes a large Unicode snapshot, even one oversized row', () => {
    const pages = createInventoryPages()
    const small = { agents: [] }
    expect(pages.start(small, 'a', 'web')).toBe(small)
    // Larger than the 6 MiB logical response guard, with multibyte characters
    // crossing page boundaries. No individual transport frame may approach it.
    const result = { agents: [{ id: 'large', name: '漢😀'.repeat(950_000) }] }
    const expected = JSON.stringify(result)
    let reply = pages.start(result, 'a', 'web')
    const first = page(reply), chunks: Buffer[] = []
    result.agents[0].name = 'mutated after the first page'
    let count = 0
    while (true) {
      const p = page(reply)
      expect(p).toMatchObject({ id: first.id, sha256: first.sha256, totalBytes: Buffer.byteLength(expected), offset: count * 128 * 1024, version: 1 })
      const encrypted = wrapPayload(Buffer.alloc(32, 7), 'p', ++count, 'agents_list_result', 'bounded', reply)
      expect(Buffer.byteLength(JSON.stringify(encrypted))).toBeLessThan(256 * 1024)
      chunks.push(Buffer.from(p.data, 'base64'))
      if (p.nextOffset === null) break
      reply = pages.next(cursor(p), 'a', 'web')
    }
    const bytes = Buffer.concat(chunks)
    expect(bytes.toString('utf8')).toBe(expected)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(first.sha256)
    expect(count).toBeGreaterThan(48)
    // A lost response can be requested again without changing its snapshot.
    expect(pages.next({ id: first.id, offset: 0 }, 'a', 'web')).toEqual({ inventoryPage: first })
  })

  it('also pages large delta membership and refuses logical snapshots above either memory cap', () => {
    const pages = createInventoryPages({ pageBytes: 16, maxSnapshotBytes: 100, maxCacheBytes: 200 })
    expect(page(pages.start({ agents: [], sync: { order: ['a', 'b', 'c', 'd'] } }, 'a', 'web')).nextOffset).toBe(16)
    expect(pages.start({ data: 'x'.repeat(100) }, 'a', 'web')).toEqual({ error: 'INVENTORY_TOO_LARGE', maxBytes: 100 })
    expect(createInventoryPages({ pageBytes: 16, maxSnapshotBytes: 200, maxCacheBytes: 100 }).start({ data: 'x'.repeat(100) }, 'a', 'web'))
      .toEqual({ error: 'INVENTORY_TOO_LARGE', maxBytes: 100 })
  })

  it('binds cursors to the requesting connection and projection scope, and validates offsets', () => {
    const pages = createInventoryPages({ pageBytes: 16 })
    const first = page(pages.start({ value: 'x'.repeat(30) }, 'a', 'web:stopped'))
    expect(pages.next(cursor(first), 'b', 'web:stopped')).toEqual(reset)
    expect(pages.next(cursor(first), 'a', 'device:stopped')).toEqual(reset)
    for (const bad of [null, 'cursor', [], {}, { id: 1, offset: 0 }, { id: first.id, offset: '16' },
      { id: first.id, offset: 1.5 }, { id: first.id, offset: -16 }, { id: first.id, offset: 1 },
      { id: first.id, offset: 1024 }, { id: 'missing', offset: 0 }]) {
      expect(pages.next(bad, 'a', 'web:stopped')).toEqual(reset)
    }
    expect(page(pages.next(cursor(first), 'a', 'web:stopped')).offset).toBe(16)
    pages.close('b')
    expect(page(pages.next(cursor(first), 'a', 'web:stopped')).offset).toBe(16)
    pages.close('a')
    expect(pages.next(cursor(first), 'a', 'web:stopped')).toEqual(reset)
  })

  it('expires snapshots without extending their lifetime on reads', () => {
    let at = 0
    const pages = createInventoryPages({ now: () => at, ttlMs: 30, pageBytes: 16 })
    const first = page(pages.start({ value: 'x'.repeat(30) }, 'a', 'web'))
    at = 29
    expect(page(pages.next(cursor(first), 'a', 'web')).offset).toBe(16)
    at = 30
    expect(pages.next(cursor(first), 'a', 'web')).toEqual(reset)
  })

  it('releases expired snapshots without another request, and cancels timers when closing', () => {
    vi.useFakeTimers()
    try {
      const pages = createInventoryPages({ pageBytes: 16, ttlMs: 30 })
      const first = page(pages.start({ value: 'x'.repeat(30) }, 'a', 'web'))
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(30)
      expect(vi.getTimerCount()).toBe(0)
      expect(pages.next(cursor(first), 'a', 'web')).toEqual(reset)
      pages.start({ value: 'x'.repeat(30) }, 'a', 'web')
      pages.close('a')
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('bounds retained bytes and count, and replaces an owner\'s old snapshot', () => {
    const value = { value: 'x'.repeat(30) } // 42 bytes
    const pages = createInventoryPages({ pageBytes: 16, maxCacheBytes: 90, maxSnapshots: 8 })
    const a = page(pages.start(value, 'a', 'web'))
    const b = page(pages.start(value, 'b', 'web'))
    const c = page(pages.start(value, 'c', 'web'))
    expect(pages.next(cursor(a), 'a', 'web')).toEqual(reset)
    expect(page(pages.next(cursor(b), 'b', 'web')).id).toBe(b.id)
    const next = page(pages.start(value, 'b', 'web'))
    expect(pages.next(cursor(b), 'b', 'web')).toEqual(reset)
    expect(page(pages.next(cursor(c), 'c', 'web')).id).toBe(c.id)
    expect(page(pages.next(cursor(next), 'b', 'web')).id).toBe(next.id)
    const limited = createInventoryPages({ pageBytes: 16, maxSnapshots: 1 })
    const old = page(limited.start(value, 'a', 'web'))
    limited.start(value, 'b', 'web')
    expect(limited.next(cursor(old), 'a', 'web')).toEqual(reset)
  })
})
