/**
 * The eager Hermes doors: the home a process uses, by Hermes's own rule, and its terminal record and store, read
 * through the kit with Hermes's declared rules. A sandboxed Hermes with only a `HOME` of its own keeps its store under
 * that `HOME`, not under the daemon's default; one in another mount namespace names its home and folder in its own
 * view, and Harness reads them at the daemon's path of them.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { env } from '../config/env.js'
import { IdentityReadUnavailable } from './kit/identityScan.js'

const readProcessEnv = vi.hoisted(() => vi.fn())
vi.mock('../lib/processEnv.js', async (real) => ({ ...await real<object>(), readProcessEnv }))
const processView = vi.hoisted(() => vi.fn())
vi.mock('../lib/processMounts.js', async (real) => ({ ...await real<object>(), processView }))

const { probeHermesHome, probeHermesHomeDerived, probeHermesSandbox, hermesSessionKind, hermesTerminalNames, hermesTerminalStamp, readHermesTerminal } = await import('./identities.js')

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...args: (string | null)[]): void }; close(): void }
}

const identity = { pid: 4242, startMarker: '2026-11-12T10:00:00Z', executable: 'python3' }
const root = mkdtempSync(join(tmpdir(), 'hermes-identities-'))
const home = join(root, 'home', '.hermes')
const broken = join(root, 'broken')
afterAll(() => rmSync(root, { recursive: true, force: true }))

function insert(id: string, source: string, created: string | null): void {
  const db = new DatabaseSync(join(home, 'state.db'))
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run(id, source, created, '/work', '1762941600')
  db.close()
}

beforeEach(() => {
  processView.mockReset().mockResolvedValue({ state: 'same' })
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(broken, { recursive: true })
  const db = new DatabaseSync(join(home, 'state.db'))
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, created_source TEXT, cwd TEXT, started_at REAL)')
  db.close()
})

describe('the home a Hermes process uses', () => {
  it('finds the home of a Hermes that only has a HOME of its own', async () => {
    readProcessEnv.mockResolvedValue({ HOME: '/sandbox/agent' })
    expect(await probeHermesHome(identity, 'hermes')).toBe('/sandbox/agent/.hermes')
  })

  it('answers null for the daemon\'s own home, undefined for what it cannot tell, and null for another engine', async () => {
    readProcessEnv.mockResolvedValue({ HOME: dirname(env.HERMES_HOME) }); expect(await probeHermesHome(identity, 'hermes')).toBeNull()
    readProcessEnv.mockResolvedValue({ HOME: '/h', HERMES_HOME: `${env.HERMES_HOME}/` }); expect(await probeHermesHome(identity, 'hermes')).toBeNull()
    readProcessEnv.mockResolvedValue({ HOME: '/h', HERMES_HOME: 'relative' }); expect(await probeHermesHome(identity, 'hermes')).toBeUndefined()
    readProcessEnv.mockResolvedValue(null); expect(await probeHermesHome(identity, 'hermes')).toBeUndefined()
    expect(await probeHermesHome(identity, 'claude')).toBeNull()
  })

  it('keeps a profile the process named', async () => {
    readProcessEnv.mockResolvedValue({ HOME: '/h', HERMES_HOME: '/h/.hermes/profiles/work' })
    expect(await probeHermesHome(identity, 'hermes')).toBe('/h/.hermes/profiles/work')
  })
})

describe('a Hermes in a sandbox', () => {
  it('translates a sandboxed Hermes\'s home to the daemon\'s view', async () => {
    readProcessEnv.mockResolvedValue({ HOME: '/home/agent' })
    processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: (p: string) => p.replace('/home/agent', '/data/agents/a1').replace(/^\/work/, '/data/work/p1') })
    expect(await probeHermesHome(identity, 'hermes')).toBe('/data/agents/a1/.hermes')
    expect(await probeHermesSandbox(identity, 'hermes')).toEqual({ cwd: '/work', hostCwd: '/data/work/p1' })
  })

  it('cannot see a sandbox whose home or folder has no path here, or whose home it cannot tell', async () => {
    readProcessEnv.mockResolvedValue({ HOME: '/home/agent' })
    processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: () => null })
    expect(await probeHermesHome(identity, 'hermes')).toBeUndefined()
    expect(await probeHermesSandbox(identity, 'hermes')).toBe('unseen')
    processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: (p: string) => p.startsWith('/work') ? p : null })
    expect(await probeHermesSandbox(identity, 'hermes')).toBe('unseen')
    processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: (p: string) => p.startsWith('/work') ? null : p })
    expect(await probeHermesSandbox(identity, 'hermes')).toBe('unseen')
    processView.mockResolvedValue({ state: 'sandbox', cwd: null, toHost: (p: string) => p })
    expect(await probeHermesSandbox(identity, 'hermes')).toBe('unseen')
    processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: (p: string) => p })
    readProcessEnv.mockResolvedValue(null); expect(await probeHermesSandbox(identity, 'hermes')).toBe('unseen')
    readProcessEnv.mockResolvedValue({ HERMES_HOME: 'relative' }); expect(await probeHermesSandbox(identity, 'hermes')).toBe('unseen')
  })

  it('is no sandbox in the daemon\'s namespace, when it cannot tell, or for another engine', async () => {
    readProcessEnv.mockResolvedValue({ HOME: '/home/agent' })
    for (const state of ['same', 'unreadable'] as const) {
      processView.mockResolvedValue({ state })
      expect(await probeHermesSandbox(identity, 'hermes')).toBeUndefined()
    }
    expect(await probeHermesSandbox(identity, 'claude')).toBeUndefined()
    expect(processView).toHaveBeenCalledTimes(2)
  })

  it('marks a home it worked out, and not one the process named by the path Harness reads it at', async () => {
    processView.mockResolvedValue({ state: 'same' })
    readProcessEnv.mockResolvedValue({ HOME: '/sandbox/agent' }); expect(await probeHermesHomeDerived(identity, 'hermes')).toBe(true)
    readProcessEnv.mockResolvedValue({ HOME: '/h', HERMES_HOME: '/data/p/profiles/work' }); expect(await probeHermesHomeDerived(identity, 'hermes')).toBe(false)
    processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: (p: string) => p })
    expect(await probeHermesHomeDerived(identity, 'hermes')).toBe(false) // the same path on both sides
    processView.mockResolvedValue({ state: 'sandbox', cwd: '/work', toHost: (p: string) => p.replace('/data/p', '/host/p') })
    expect(await probeHermesHomeDerived(identity, 'hermes')).toBe(true) // the row holds the daemon's path, not what it set
    readProcessEnv.mockResolvedValue(null); expect(await probeHermesHomeDerived(identity, 'hermes')).toBe(false)
    expect(await probeHermesHomeDerived(identity, 'claude')).toBe(false)
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
