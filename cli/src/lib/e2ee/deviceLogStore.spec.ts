import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEVLOG_ARCHIVED, DEVLOG_DEPARTED, DeviceLogStore, type DevLogFile } from './deviceLogStore.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const file = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-devlog-store-'))
  dirs.push(dir)
  return join(dir, 'devlog.json')
}

const state = { acct: 'acct', head: { seq: 1, hash: 'h' }, hashes: ['h'], active: {}, removed: [] }

describe('DeviceLogStore — firstSeen across versions', () => {
  it('reads a devlog.json written before firstSeen existed, with nothing marked as first seen', () => {
    const path = file()
    writeFileSync(path, JSON.stringify({ state, recent: [], frozen: null, notifiedUpTo: 1 }))
    const read = new DeviceLogStore(path).read()
    expect(read.state).toEqual(state)
    expect(read.notifiedUpTo).toBe(1)
    expect(read.firstSeen).toBeUndefined()
  })

  it('keeps firstSeen through a write and a read', () => {
    const path = file()
    const store = new DeviceLogStore(path)
    const next: DevLogFile = { state: state as DevLogFile['state'], recent: [], frozen: null, notifiedUpTo: 1, firstSeen: { a: 5 } }
    store.write(next)
    expect(store.read().firstSeen).toEqual({ a: 5 })
    // The other fields an older CLI reads are where they always were.
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({ state, recent: [], frozen: null, notifiedUpTo: 1 })
  })

  it('drops a firstSeen that is not an object rather than failing the whole read', () => {
    const path = file()
    writeFileSync(path, JSON.stringify({ state, recent: [], frozen: null, notifiedUpTo: 1, firstSeen: 'junk' }))
    const read = new DeviceLogStore(path).read()
    expect(read.state).toEqual(state)
    expect(read.firstSeen).toBeUndefined()
  })
})

describe('DeviceLogStore — joined point and marks', () => {
  it('reads an old file with none of them, and keeps them through a write and a read', () => {
    const path = file()
    writeFileSync(path, JSON.stringify({ state, recent: [], frozen: null, notifiedUpTo: 1 }))
    const store = new DeviceLogStore(path)
    const old = store.read()
    expect(old.joinedSeq).toBeUndefined()
    expect(old.baselineSeen).toBeUndefined()
    expect(old.pending).toBeUndefined()
    const conflict = { pub: 'p', label: 'l', machineId: 'm', addedAt: 1, seq: 2, fingerprint: 'f', afterJoin: true }
    store.write({ ...old, joinedSeq: 1, preLog: ['a'], pending: ['b'], announced: ['c'], baselineSeen: false, suspended: ['d'], conflict })
    expect(store.read()).toMatchObject({ joinedSeq: 1, preLog: ['a'], pending: ['b'], announced: ['c'], baselineSeen: false, suspended: ['d'], conflict })
  })

  it('filters junk per field instead of failing the read', () => {
    const path = file()
    writeFileSync(path, JSON.stringify({
      state, recent: [], frozen: null, notifiedUpTo: 1, joinedSeq: 'x', preLog: ['a', 3], pending: 'no', baselineSeen: 'yes',
      looseRemoved: [{ nope: true }], conflict: { pub: 1 },
    }))
    const read = new DeviceLogStore(path).read()
    expect(read.state).toEqual(state)
    expect(read.joinedSeq).toBeUndefined()
    expect(read.preLog).toEqual(['a'])
    expect(read.pending).toBeUndefined()
    expect(read.baselineSeen).toBeUndefined()
    expect(read.looseRemoved).toEqual([])
    expect(read.conflict).toBeUndefined()
  })
})

describe('DeviceLogStore — writes and the archive of other accounts', () => {
  const of = (acct: string, extra: Partial<DevLogFile> = {}): DevLogFile =>
    ({ state: { ...state, acct }, recent: [], frozen: null, notifiedUpTo: 1, ...extra })

  it('a write that fails half way leaves the previous file whole', () => {
    const path = file()
    const store = new DeviceLogStore(path)
    store.write(of('a', { pending: ['p'] }))
    const now = vi.spyOn(Date, 'now').mockReturnValue(42)
    try {
      // The temp file cannot be created: the write fails before anything touches devlog.json.
      mkdirSync(`${path}.${process.pid}.42.tmp`)
      expect(() => store.write(of('a', { pending: [] }))).toThrow()
    } finally { now.mockRestore() }
    expect(store.read().pending).toEqual(['p'])
    expect(readdirSync(join(path, '..')).filter((n) => n.endsWith('.tmp'))).toHaveLength(1)
  })

  it('keeps a left account\'s file to restore once, and the newest few only', () => {
    const store = new DeviceLogStore(file())
    store.archive(of('a', { suspended: ['evil'], pending: ['evil'], frozen: { reason: 'fork', at: 1, lastGoodHead: state.head } }))
    for (let i = 0; i < DEVLOG_ARCHIVED; i++) store.archive(of(`b${i}`, { suspended: [`s${i}`] }))
    expect(store.restore('a')).toBeNull()
    expect(store.archivedSuspended().sort()).toEqual(['s0', 's1', 's2', 's3'])
    store.archive(of('a', { suspended: ['evil'], pending: ['evil'] }))
    expect(store.archivedSuspended()).toContain('evil')
    expect(store.restore('a')).toMatchObject({ state: { acct: 'a' }, suspended: ['evil'], pending: ['evil'] })
    expect(store.restore('a')).toBeNull()
    expect(store.archivedSuspended()).not.toContain('evil')
    expect(store.read()).toMatchObject({ state: { acct: 'a' }, suspended: ['evil'], pending: ['evil'] })
  })

  it('a restore that fails half way has the kept file live first: its marks are never lost', () => {
    const path = file()
    const store = new DeviceLogStore(path)
    store.write(of('b'))
    store.archive(of('a', { suspended: ['evil'], pending: ['evil'] }))
    const now = vi.spyOn(Date, 'now').mockReturnValue(43)
    try {
      // Taking it out of the archive fails: by then it is the live file.
      mkdirSync(`${path.replace(/\.json$/, '.archive.json')}.${process.pid}.43.tmp`)
      expect(() => store.restore('a', (k) => ({ ...k, owner: 'u2' }))).toThrow()
    } finally { now.mockRestore() }
    expect(store.read()).toMatchObject({ state: { acct: 'a' }, suspended: ['evil'], pending: ['evil'], owner: 'u2' })
    expect(store.archivedSuspended()).toContain('evil')
  })

  it('lifting a suspension takes it out of every kept account', () => {
    const store = new DeviceLogStore(file())
    store.archive(of('a', { suspended: ['evil', 'x'] }))
    store.archive(of('b', { suspended: ['evil'] }))
    store.unsuspendArchived(['evil'])
    expect(store.archivedSuspended()).toEqual(['x'])
  })

  it('keeps the newest departed keys only, and drops unreadable ones', () => {
    const path = file()
    const store = new DeviceLogStore(path)
    const d = (i: number) => ({
      pub: `k${i}`, label: `d${i}`, kind: 'viewer' as const, machineId: '', fingerprint: 'F', addedAt: 1, removedAt: 2,
      removedBy: `k${i}`, removedByLabel: '', selfRemoved: true,
    })
    store.write(of('a', { departed: Array.from({ length: DEVLOG_DEPARTED + 3 }, (_, i) => d(i)) }))
    expect(store.read().departed?.map((x) => x.pub)).toEqual(Array.from({ length: DEVLOG_DEPARTED }, (_, i) => `k${i + 3}`))
    writeFileSync(path, JSON.stringify({ ...of('a'), departed: [d(1), { pub: 'k2', label: 3 }, { ...d(4), kind: 'evil' }] }))
    expect(store.read().departed?.map((x) => x.pub)).toEqual(['k1'])
  })

  it('never restores a kept file under an account it is not for', () => {
    const path = file()
    const store = new DeviceLogStore(path)
    writeFileSync(path.replace(/\.json$/, '.archive.json'), JSON.stringify({ b: of('a', { suspended: ['evil'] }) }))
    expect(store.restore('b')).toBeNull()
    expect(store.archivedSuspended()).toEqual(['evil'])
  })
})
