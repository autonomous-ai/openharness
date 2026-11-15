/**
 * The eager Hermes doors: the home a process works in, from the store it holds open, whether it is in a sandbox, and
 * its terminal record and store, read through the kit with Hermes's declared rules. One in another mount namespace
 * names its folder in its own view, and Harness reads it at the daemon's path of it.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from '../config/env.js'
import type { ProcessIdentity } from '../lib/terminalTypes.js'
import { HERMES_HELD_STORE } from './hermes/contract.js'
import { IdentityReadUnavailable } from './kit/identityScan.js'

const heldHome = vi.hoisted(() => vi.fn())
vi.mock('../lib/processHeldFiles.js', async (real) => ({ ...await real<object>(), heldHome }))
const processView = vi.hoisted(() => vi.fn())
vi.mock('../lib/processMounts.js', async (real) => ({ ...await real<object>(), processView }))

const { probeHermesHome, probeHermesSandbox, hermesSessionKind, hermesSessionEndedSince, hermesStoreStamp, hermesTerminalNames, hermesTerminalStamp, readHermesTerminal } = await import('./identities.js')

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...args: (string | number | null)[]): void }; close(): void }
}

const identity = { pid: 4242, startMarker: '2026-11-12T10:00:00Z', executable: 'python3' }
const children = (): ProcessIdentity[] => []
const root = mkdtempSync(join(tmpdir(), 'hermes-identities-'))
const home = join(root, 'home', '.hermes')
const broken = join(root, 'broken')
// The daemon's own home, spelled through a symbolic link.
const linkToDefault = join(root, 'default-home')
mkdirSync(env.HERMES_HOME, { recursive: true })
symlinkSync(env.HERMES_HOME, linkToDefault)
afterAll(() => rmSync(root, { recursive: true, force: true }))

function insert(id: string, source: string, created: string | null, ended: string | number | null = null): void {
  const db = new DatabaseSync(join(home, 'state.db'))
  db.prepare('INSERT INTO sessions (id, source, created_source, cwd, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, source, created, '/work', '1762941600', ended)
  db.close()
}

beforeEach(() => {
  heldHome.mockReset()
  processView.mockReset().mockResolvedValue({ state: 'same' })
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(broken, { recursive: true })
  const db = new DatabaseSync(join(home, 'state.db'))
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, created_source TEXT, cwd TEXT, started_at REAL, ended_at REAL)')
  db.close()
})

describe('the home a Hermes process uses', () => {
  it('names the home of the store a Hermes holds open, null for the daemon\'s own, and nothing when it holds none', async () => {
    heldHome.mockResolvedValue('/data/agents/a1/.hermes')
    expect(await probeHermesHome(identity, 'hermes', children)).toBe('/data/agents/a1/.hermes')
    expect(heldHome).toHaveBeenCalledWith(identity, HERMES_HELD_STORE, children)
    heldHome.mockResolvedValue(linkToDefault)
    expect(await probeHermesHome(identity, 'hermes')).toBeNull()
    heldHome.mockResolvedValue(undefined)
    expect(await probeHermesHome(identity, 'hermes')).toBeUndefined()
    heldHome.mockClear()
    expect(await probeHermesHome(identity, 'claude')).toBeNull()
    expect(heldHome).not.toHaveBeenCalled()
  })

  it('the pattern takes a file named state.db and nothing else', () => {
    expect(HERMES_HELD_STORE.exec('/h/.hermes/state.db')?.[1]).toBe('/h/.hermes')
    for (const path of ['/h/.hermes/state.db-wal', '/h/.hermes/state.db-shm', '/h/.hermes/state.db (deleted)', '/h/.hermes/mystate.db']) {
      expect(HERMES_HELD_STORE.test(path), path).toBe(false)
    }
  })
})

describe('a Hermes in a sandbox', () => {
  it('gives a sandboxed Hermes the daemon\'s path of its folder, with nothing known of its home', async () => {
    processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: (path: string) => `/data/agents/a1${path}` })
    expect(await probeHermesSandbox(identity, 'hermes')).toEqual({ cwd: '/work', hostCwd: '/data/agents/a1/work' })
    expect(heldHome).not.toHaveBeenCalled()
  })

  it('cannot see a sandbox whose folder has no path here', async () => {
    processView.mockResolvedValue({ state: 'sandbox', cwd: null, toHost: (path: string) => path })
    expect(await probeHermesSandbox(identity, 'hermes')).toBe('unseen')
    processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: () => null })
    expect(await probeHermesSandbox(identity, 'hermes')).toBe('unseen')
  })

  it('is no sandbox in the daemon\'s namespace, when it cannot tell, or for another engine', async () => {
    for (const state of ['same', 'unreadable'] as const) {
      processView.mockResolvedValue({ state })
      expect(await probeHermesSandbox(identity, 'hermes')).toBeUndefined()
    }
    expect(await probeHermesSandbox(identity, 'claude')).toBeUndefined()
    expect(processView).toHaveBeenCalledTimes(2)
  })
})

describe('a session in a Hermes home\'s own store', () => {
  it.each([
    ['a CLI session', '20261112_100000_aaaaaa', 'cli', null, 'own'],
    ['a sub-agent', '20261112_100001_bbbbbb', 'subagent', null, 'other'],
    ['a 0.23 CLI session', 'local-' + 'a'.repeat(64), 'local', 'cli', 'own'],
    ['a 0.23 session not stamped yet', 'local-' + 'b'.repeat(64), 'local', 'unknown', 'waiting'],
    ['a 0.23 editor session', 'local-' + 'c'.repeat(64), 'local', 'acp', 'other'],
    ['an editor\'s uuid session', '11111111-2222-4333-8444-555555555555', 'acp', null, 'other'],
  ])('reads %s from the home\'s own store', async (_name, id, source, created, kind) => {
    insert(id, source, created)
    expect(await hermesSessionKind(home, id)).toBe(kind)
  })

  it('waits for a session or a store that is not there yet, and refuses to judge a store it cannot read', async () => {
    expect(await hermesSessionKind(home, '20261112_100009_cccccc')).toBe('waiting')
    expect(await hermesSessionKind(join(home, 'no-such-home'), '20261112_100009_cccccc')).toBe('waiting')
    writeFileSync(join(broken, 'state.db'), 'not a database')
    await expect(hermesSessionKind(broken, '20261112_100009_cccccc')).rejects.toBeInstanceOf(IdentityReadUnavailable)
  })
})

describe('what a Hermes home\'s store is now', () => {
  it('changes when a write lands in the store or its -wal, and not otherwise', async () => {
    const idle = await hermesStoreStamp(home)
    expect(await hermesStoreStamp(home)).toBe(idle)
    // A running Hermes writes its turns to the -wal.
    writeFileSync(join(home, 'state.db-wal'), 'a frame')
    const written = await hermesStoreStamp(home)
    expect(written).not.toBe(idle)
    writeFileSync(join(home, 'state.db-wal'), 'a frame, then another')
    const grown = await hermesStoreStamp(home)
    expect(grown).not.toBe(written)
    // A checkpoint moves them into the store.
    utimesSync(join(home, 'state.db'), new Date('2030-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'))
    expect(await hermesStoreStamp(home)).not.toBe(grown)
  })

  it('stamps a home with no store yet, until its store is made', async () => {
    const empty = join(root, 'no-store-yet')
    mkdirSync(empty, { recursive: true })
    const none = await hermesStoreStamp(empty)
    expect(await hermesStoreStamp(empty)).toBe(none)
    writeFileSync(join(empty, 'state.db'), '')
    expect(await hermesStoreStamp(empty)).not.toBe(none)
  })
})

describe('whether a Hermes session was left since a moment', () => {
  const since = Date.parse('2026-11-12T10:00:00Z')
  it.each([
    ['ended at that moment', since / 1000, true],
    ['ended after it', since / 1000 + 3.5, true],
    ['ended before it', since / 1000 - 0.5, false],
    ['still open', null, false],
    ['ended at a time that is not a number', 'soon', false],
  ] as const)('reads a session %s', async (_name, ended, left) => {
    insert('20261112_100000_aaaaaa', 'cli', null, ended)
    expect(await hermesSessionEndedSince(home, '20261112_100000_aaaaaa', since)).toBe(left)
  })

  it('has no session that is not there, and refuses to judge a store it cannot read', async () => {
    expect(await hermesSessionEndedSince(home, '20261112_100009_cccccc', since)).toBe(false)
    expect(await hermesSessionEndedSince(home, 'not an id', since)).toBe(false)
    writeFileSync(join(broken, 'state.db'), 'not a database')
    await expect(hermesSessionEndedSince(broken, '20261112_100009_cccccc', since)).rejects.toBeInstanceOf(IdentityReadUnavailable)
  })
})

describe('a Hermes terminal record', () => {
  it('names and reads a record by Hermes\'s declared rule', async () => {
    const names = hermesTerminalNames({ tty: '/dev/pts/3', tmuxPane: '%5' })
    expect(names).toEqual(['tty-dev-pts-3', 'tmux_pane--5'])
    const before = await hermesTerminalStamp(home, names)
    expect(await readHermesTerminal(home, names, 0)).toEqual({ state: 'none' })
    mkdirSync(join(home, 'terminal-sessions'))
    writeFileSync(join(home, 'terminal-sessions', 'tty-dev-pts-3'), JSON.stringify({ session_id: '20261112_100000_aaaaaa', cwd: '/work', ts: 1762941600 }))
    expect(await readHermesTerminal(home, names, 0)).toEqual({ state: 'record', sessionId: '20261112_100000_aaaaaa', at: 1762941600_000 })
    expect(await hermesTerminalStamp(home, names)).not.toBe(before)
  })
})
