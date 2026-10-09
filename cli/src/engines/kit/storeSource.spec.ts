import { afterEach, describe, expect, it, vi } from 'vitest'
import { stat } from 'node:fs/promises'
import { sqliteReadAll } from '../../lib/sqliteRead.js'
import { isInteractiveSource, readStoreSessionSource, storeSessionSource } from './storeSource.js'

vi.mock('node:fs/promises', () => ({ stat: vi.fn(async () => ({})) }))
vi.mock('../../lib/sqliteRead.js', () => ({ sqliteReadAll: vi.fn() }))
const rule = { id: /^session$/, query: 'SELECT source FROM sessions WHERE id = ?', column: 'source', interactive: ['', 'cli'], maxBuffer: 1024 }
afterEach(() => { vi.mocked(stat).mockReset().mockResolvedValue({} as never); vi.mocked(sqliteReadAll).mockReset() })

describe('store source evidence', () => {
  it('keeps unsupported id behavior without consulting storage', async () => {
    expect(await readStoreSessionSource(rule, '/fixture/store', 'other')).toBe('')
    expect(stat).not.toHaveBeenCalled()
    expect(sqliteReadAll).not.toHaveBeenCalled()
    expect(isInteractiveSource(rule, '')).toBe(true)
    expect(isInteractiveSource(rule, 'tool')).toBe(false)
  })

  it('separates missing stores, unreadable files, and failed readers', async () => {
    vi.mocked(stat).mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }))
    expect(await readStoreSessionSource(rule, '/fixture/store', 'session')).toBeNull()
    vi.mocked(stat).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    expect(await readStoreSessionSource(rule, '/fixture/store', 'session')).toEqual({ unavailable: true, reason: 'transient' })
    for (const reason of ['missing', 'transient'] as const) {
      vi.mocked(sqliteReadAll).mockResolvedValueOnce({ ok: false, reason })
      expect(await readStoreSessionSource(rule, '/fixture/store', 'session')).toEqual({ unavailable: true, reason })
    }
  })

  it('accepts only an actual row as source evidence and preserves optional-reader unknowns', async () => {
    for (const [rows, expected] of [[[], null], [[{ source: 'cli' }], 'cli'], [[{ source: 'tool' }], 'tool'], [[{ source: '' }], ''], [[{}], null]] as const) {
      vi.mocked(sqliteReadAll).mockResolvedValueOnce({ ok: true, rows: [...rows], via: 'builtin' })
      expect(await storeSessionSource(rule, '/fixture/store', 'session')).toBe(expected)
    }
    vi.mocked(sqliteReadAll).mockResolvedValueOnce({ ok: false, reason: 'transient' })
    expect(await storeSessionSource(rule, '/fixture/store', 'session')).toBeNull()
    expect(sqliteReadAll).toHaveBeenCalledWith('/fixture/store', rule.query, ['session'], { maxBuffer: 1024 })
  })

  it('holds malformed source values instead of turning them into the interactive empty string', async () => {
    for (const source of [undefined, null, 42, Buffer.from('cli')]) {
      vi.mocked(sqliteReadAll).mockResolvedValueOnce({ ok: true, rows: [{ source }], via: 'builtin' })
      expect(await readStoreSessionSource(rule, '/fixture/store', 'session')).toEqual({ unavailable: true, reason: 'transient' })
    }
  })
})
