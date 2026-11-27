import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NOTICES_KEPT, NoticeStore } from './noticeStore.js'

// Pass-through, noting each open, write and rename by path, until a test fills the disk: a write then stops part way,
// as ENOSPC leaves it.
const disk = vi.hoisted(() => ({ full: false, touched: [] as string[] }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => { disk.touched.push(`open ${String(args[0])}`); return actual.openSync(...args) },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      disk.touched.push(`write ${String(args[0])}`)
      if (!disk.full) return actual.writeFileSync(...args)
      actual.writeFileSync(args[0], String(args[1]).slice(0, 8))
      throw Object.assign(new Error('ENOSPC: fixture'), { code: 'ENOSPC' })
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => { disk.touched.push(`rename ${String(args[1])}`); return actual.renameSync(...args) },
  }
})
afterEach(() => { disk.full = false; disk.touched = [] })

const TAB = 'a'.repeat(24)
const dir = () => mkdtempSync(join(tmpdir(), 'notices-'))

describe('NoticeStore', () => {
  it('the save goes through a temporary file renamed onto the target', () => {
    const path = join(dir(), 'n.json')
    const store = new NoticeStore(path)
    store.add({ sharedTabId: TAB, kind: 'full' })
    disk.touched = []
    store.add({ sharedTabId: TAB, kind: 'unsent' })
    expect(disk.touched.filter((t) => t.endsWith(` ${path}`))).toEqual([`rename ${path}`])
  })

  it('a save that fails part way leaves the old file, and no temporary file', () => {
    const d = dir(), path = join(d, 'n.json')
    const store = new NoticeStore(path)
    const n = store.add({ sharedTabId: TAB, kind: 'full' })
    disk.full = true
    expect(() => store.add({ sharedTabId: TAB, kind: 'unsent' })).toThrow(/ENOSPC/)
    disk.full = false
    expect(new NoticeStore(path).unread()).toEqual([n])
    expect(readdirSync(d)).toEqual(['n.json'])
  })

  it('keeps the owner\'s email of a notice across a restart', () => {
    const path = join(dir(), 'n.json')
    const store = new NoticeStore(path)
    const n = store.add({ sharedTabId: TAB, kind: 'removed', ownerEmail: 'alice@x.io' })!
    expect(new NoticeStore(path).unread()).toEqual([n])
    expect(n.ownerEmail).toBe('alice@x.io')
  })

  it('keeps notices on disk, unread until dismissed', () => {
    const path = join(dir(), 'n.json')
    const store = new NoticeStore(path, () => Date.parse('2026-10-16T10:00:00Z'))
    const n = store.add({ sharedTabId: TAB, kind: 'removed' })!
    expect(n).toEqual({ id: expect.any(String), sharedTabId: TAB, kind: 'removed', at: '2026-10-16T10:00:00.000Z' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const again = new NoticeStore(path)
    expect(again.unread()).toEqual([n])
    expect(again.dismiss(n.id)).toBe(true)
    expect(again.dismiss(n.id)).toBe(false)
    expect(new NoticeStore(path).unread()).toEqual([])
  })
  it(`keeps the newest ${NOTICES_KEPT}`, () => {
    const store = new NoticeStore(join(dir(), 'n.json'))
    for (let i = 0; i < NOTICES_KEPT + 5; i++) store.add({ sharedTabId: TAB, kind: 'unsent', machineId: `m${i}` })
    const unread = store.unread()
    expect(unread).toHaveLength(NOTICES_KEPT)
    expect(unread[0].machineId).toBe('m5')
  })
  it('moves an unreadable file aside and starts again', () => {
    const d = dir(), path = join(d, 'n.json')
    writeFileSync(path, '{not json')
    expect(new NoticeStore(path, () => 7).unread()).toEqual([])
    expect(readFileSync(join(d, 'n.json.unreadable-7'), 'utf8')).toBe('{not json')
  })
  it('reads each notice on its own: one it cannot read (a newer daemon\'s kind) is left out, the rest kept (review of A2)', () => {
    const d = dir(), path = join(d, 'n.json')
    const kept = { id: 'n1', sharedTabId: TAB, kind: 'removed', at: '2026-10-16T10:00:00.000Z', ownerEmail: 'alice@x.io' }
    const read = { id: 'n2', sharedTabId: TAB, kind: 'full', at: '2026-10-16T10:00:00.000Z', read: true }
    writeFileSync(path, JSON.stringify([{ ...kept, id: 'n0', kind: 'renamed' }, kept, { ...kept, id: 'n3', extra: 1 }, 'x', read]))
    const store = new NoticeStore(path, () => 7)
    expect(store.unread()).toEqual([kept])
    expect(existsSync(join(d, 'n.json.unreadable-7'))).toBe(false)
    // Dismissed ones are still kept, hidden.
    expect(store.dismiss('n2')).toBe(false)
  })
  it('moves aside a file that holds JSON but no list', () => {
    const d = dir(), path = join(d, 'n.json')
    writeFileSync(path, '{"notices":[]}')
    expect(new NoticeStore(path, () => 7).unread()).toEqual([])
    expect(readFileSync(join(d, 'n.json.unreadable-7'), 'utf8')).toBe('{"notices":[]}')
  })
  it('starts again when the file cannot be moved aside either', () => {
    const d = dir(), path = join(d, 'n.json')
    writeFileSync(path, '{not json')
    // The name it would move to is a non-empty directory, so the rename fails.
    mkdirSync(join(d, 'n.json.unreadable-7', 'x'), { recursive: true })
    expect(new NoticeStore(path, () => 7).unread()).toEqual([])
  })
  it('lives in memory without a path', () => {
    const store = new NoticeStore(null)
    const n = store.add({ sharedTabId: TAB, kind: 'full', error: 'TAB_FULL' })
    expect(store.unread()).toEqual([n])
  })
  it('throws a read error other than a missing file, so a whole file is never written over', () => {
    // The path is a directory: reading it fails with EISDIR.
    expect(() => new NoticeStore(dir())).toThrow(/EISDIR/)
  })
  it('skips a removed notice when the newest unread one for that tab already says removed', () => {
    const store = new NoticeStore(null)
    store.add({ sharedTabId: TAB, kind: 'removed' })
    store.add({ sharedTabId: TAB, kind: 'removed' })
    expect(store.add({ sharedTabId: TAB, kind: 'removed' })).toBeNull()
    expect(store.unread()).toHaveLength(1)
  })
})
