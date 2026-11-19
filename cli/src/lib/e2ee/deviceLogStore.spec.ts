import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../config/env.js'
import { StateFileUnreadable } from '../secureState.js'
import { DEVLOG_ARCHIVED, DEVLOG_DEPARTED, DeviceLogStore, deviceLogFiles, type DevLogFile } from './deviceLogStore.js'

// Pass-through, but for a rename a test refuses: what each descriptor is, and every flush and rename in order.
const fs = vi.hoisted(() => ({ refuseRename: undefined as string | undefined, paths: new Map<number, string>(), events: [] as string[][] }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args)
      fs.paths.set(fd, String(args[0]))
      return fd
    },
    fsyncSync: (fd: number) => {
      fs.events.push(['fsync', fs.paths.get(fd) ?? ''])
      return actual.fsyncSync(fd)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (String(args[1]) === fs.refuseRename) throw Object.assign(new Error('EIO: fixture'), { code: 'EIO' })
      fs.events.push(['rename', String(args[0]), String(args[1])])
      return actual.renameSync(...args)
    },
  }
})

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  fs.refuseRename = undefined
  fs.paths.clear()
  fs.events.length = 0
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
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
    // The rename into place fails: the write fails before anything touches devlog.json.
    fs.refuseRename = path
    expect(() => store.write(of('a', { pending: [] }))).toThrow()
    fs.refuseRename = undefined
    expect(store.read().pending).toEqual(['p'])
    expect(readdirSync(join(path, '..'))).toEqual(['devlog.json'])
  })

  it('the temporary file is flushed before it is renamed', () => {
    const path = file()
    new DeviceLogStore(path).write(of('a'))
    const into = fs.events.findIndex(([op, , to]) => op === 'rename' && to === path)
    expect(into).toBeGreaterThanOrEqual(0)
    expect(fs.events.slice(0, into)).toContainEqual(['fsync', fs.events[into][1]])
  })

  it('two writes in one millisecond do not share a temporary name', () => {
    const path = file()
    const store = new DeviceLogStore(path)
    vi.spyOn(Date, 'now').mockReturnValue(42)
    store.write(of('a'))
    store.write(of('b'))
    const temps = fs.events.filter(([op, , to]) => op === 'rename' && to === path).map(([, from]) => from)
    expect(temps).toHaveLength(2)
    expect(new Set(temps).size).toBe(2)
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
    // Taking it out of the archive fails: by then it is the live file.
    fs.refuseRename = path.replace(/\.json$/, '.archive.json')
    expect(() => store.restore('a', (k) => ({ ...k, owner: 'u2' }))).toThrow()
    fs.refuseRename = undefined
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

  it('keeps which device confirmed a key, and drops unreadable marks rather than failing the read', () => {
    const path = file()
    const store = new DeviceLogStore(path)
    const mark = { by: 'B', label: 'box2', at: 7 }
    store.write(of('a', { confirmed: { k1: mark } }))
    expect(store.read().confirmed).toEqual({ k1: mark })
    writeFileSync(path, JSON.stringify({ ...of('a'), confirmed: { k1: mark, k2: { by: 'B' }, k3: null, k4: { ...mark, at: '7' } } }))
    expect(store.read().confirmed).toEqual({ k1: mark })
    for (const junk of [['k1'], 'k1', null]) {
      writeFileSync(path, JSON.stringify({ ...of('a'), confirmed: junk }))
      expect(store.read().confirmed).toBeUndefined()
    }
  })

  it('never restores a kept file under an account it is not for', () => {
    const path = file()
    const store = new DeviceLogStore(path)
    writeFileSync(path.replace(/\.json$/, '.archive.json'), JSON.stringify({ b: of('a', { suspended: ['evil'] }) }))
    expect(store.restore('b')).toBeNull()
    expect(store.archivedSuspended()).toEqual(['evil'])
  })
})

describe('DeviceLogStore — a file that cannot be read', () => {
  const of = (acct: string): DevLogFile => ({ state: { ...state, acct }, recent: [], frozen: null, notifiedUpTo: 1 })

  // The reader's retries wait on Atomics.wait: recorded, not slept. Its one line per file is the reader's own test.
  beforeEach(() => {
    vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it.each([['a torn log', '{"state":{"acct":"'], ['an array', '[]'], ['null', 'null']])('%s is not an empty log', (_, text) => {
    const path = file()
    writeFileSync(path, text)
    const store = new DeviceLogStore(path)
    expect(() => store.read()).toThrow(StateFileUnreadable)
    expect(() => store.update((f) => f)).toThrow(StateFileUnreadable)
    expect(() => store.write(of('a'))).toThrow(StateFileUnreadable)
    // Read as the empty log, its next write would drop the freeze and the rollback protection.
    expect(readFileSync(path, 'utf8')).toBe(text)
  })

  it('a torn archive keeps its suspensions', () => {
    const path = file()
    const store = new DeviceLogStore(path)
    store.write(of('b'))
    const archive = path.replace(/\.json$/, '.archive.json')
    const torn = '{"a":{"state":{"acct":"a"},"suspended":["ev'
    writeFileSync(archive, torn)
    expect(() => store.archivedSuspended()).toThrow(StateFileUnreadable)
    expect(() => store.archivedFile('a')).toThrow(StateFileUnreadable)
    expect(() => store.archive(of('c'))).toThrow(StateFileUnreadable)
    expect(() => store.restore('a')).toThrow(StateFileUnreadable)
    expect(() => store.unsuspendArchived(['evil'])).toThrow(StateFileUnreadable)
    expect(readFileSync(archive, 'utf8')).toBe(torn)
    expect(store.read().state?.acct).toBe('b')
  })

  it('names both files for harness status, each read as a JSON object', () => {
    const files = deviceLogFiles()
    expect(files.map((f) => f.file)).toEqual([
      join(env.ADAPTER_DATA_DIR, 'e2e', 'devlog.json'), join(env.ADAPTER_DATA_DIR, 'e2e', 'devlog.archive.json'),
    ])
    for (const f of files) {
      expect(f.parse('{}')).toEqual({})
      expect(() => f.parse('[]')).toThrow()
    }
  })
})
