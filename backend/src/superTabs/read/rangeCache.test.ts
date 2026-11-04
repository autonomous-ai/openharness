import { describe, expect, it } from 'vitest'
import { chatTop, rangeKey, RangeCache } from './rangeCache.js'

describe('the range cache', () => {
  const limits = { entries: 3, rows: 10, ttlMs: 1_000 }

  it('answers what was set under a key as a copy, and nothing for another key', () => {
    const cache = new RangeCache<{ id: string }>(limits, () => 0)
    const rows = [{ id: 'a' }, { id: 'b' }]
    cache.set('k', rows)
    const got = cache.get('k')!
    expect(got).toEqual(rows)
    got.pop()
    expect(cache.get('k')).toEqual(rows)
    expect(cache.get('other')).toBeUndefined()
  })

  it('keeps an empty range, so a range with no rows is not read again', () => {
    const cache = new RangeCache<{ id: string }>(limits, () => 0)
    cache.set('empty', [])
    expect(cache.get('empty')).toEqual([])
  })

  it('drops the least recently used entry past its entry limit', () => {
    const cache = new RangeCache<{ id: string }>(limits, () => 0)
    for (const key of ['a', 'b', 'c']) cache.set(key, [{ id: key }])
    cache.get('a')
    cache.set('d', [{ id: 'd' }])
    expect(cache.get('b')).toBeUndefined()
    expect(['a', 'c', 'd'].map(key => cache.get(key)?.[0]?.id)).toEqual(['a', 'c', 'd'])
  })

  it('drops the oldest entries past its row limit, and never holds a range larger than it', () => {
    const cache = new RangeCache<{ id: string }>(limits, () => 0)
    const of = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i) }))
    cache.set('six', of(6))
    cache.set('four', of(4))
    expect(cache.get('six')).toHaveLength(6)
    cache.set('two', of(2))
    // 12 rows held: the least recently used (four) goes.
    expect(cache.get('four')).toBeUndefined()
    expect(cache.size()).toEqual({ entries: 2, rows: 8 })
    cache.set('huge', of(11))
    expect(cache.get('huge')).toBeUndefined()
    expect(cache.size()).toEqual({ entries: 2, rows: 8 })
  })

  it('forgets an entry past its time to live', () => {
    let now = 0
    const cache = new RangeCache<{ id: string }>(limits, () => now)
    cache.set('k', [{ id: 'a' }])
    now = 1_000
    expect(cache.get('k')).toHaveLength(1)
    now = 1_001
    expect(cache.get('k')).toBeUndefined()
    expect(cache.size()).toEqual({ entries: 0, rows: 0 })
  })

  it('replacing a key counts its rows once', () => {
    const cache = new RangeCache<{ id: string }>(limits, () => 0)
    cache.set('k', [{ id: 'a' }, { id: 'b' }])
    cache.set('k', [{ id: 'c' }])
    expect(cache.size()).toEqual({ entries: 1, rows: 1 })
  })
})

describe('a range\'s key', () => {
  const base = { tabId: 't', conversationId: 'c', thread: 'r', sequence: { $gt: 5, $lte: 9 }, limit: 101, version: 2 }
  const key = (over: Partial<typeof base> & { namedBy?: string; fields?: string } = {}) => {
    const k = { ...base, ...over }
    return rangeKey(k.tabId, k.conversationId, k.thread, k.sequence, k.limit, k.version, k.fields ?? 'scan', k.namedBy)
  }

  it('differs whenever anything that decides the range\'s rows differs', () => {
    const keys = [key(), key({ tabId: 'u' }), key({ conversationId: 'd' }), key({ thread: 's' }), key({ sequence: { $gt: 5, $lte: 10 } }),
      key({ sequence: { $gt: 6, $lte: 9 } }), key({ limit: 100 }), key({ version: 3 }), key({ namedBy: 'p' }), key({ fields: 'preview' })]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('cannot be forged by an id holding the separator', () => {
    expect(key({ tabId: 'a\u0000b', conversationId: 'c' })).not.toBe(key({ tabId: 'a', conversationId: 'b\u0000c' }))
  })
})

describe('a chat\'s newest sequence', () => {
  it('is the newest of its numbered rows, a hidden one too', () => {
    expect(chatTop({ messageSeq: 12, lastMessageSequence: 10 })).toBe(12)
    expect(chatTop({ lastMessageSequence: 10 })).toBe(10)
    expect(chatTop({ messageSeq: 3, lastMessageSequence: 10 })).toBe(10)
  })
})
