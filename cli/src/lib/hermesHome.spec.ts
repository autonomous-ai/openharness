/**
 * The store a registered Hermes session reads from — found once, remembered on the row.
 *
 * The bug this closes: every Hermes read went to `<HERMES_HOME>/state.db`, so an agent started with
 * `hermes -p <name>` mirrored nothing, recapped nothing, and answered `agent_recent` with zero events
 * for as long as it lived (openharness#191).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const hasSqlite = (() => {
  try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()
const d = hasSqlite ? describe : describe.skip

const DEFAULT_SESSION = '20260727_162325_e25264'
const PROFILE_SESSION = '20260921_152236_a1b2c3'

let dataDir = ''
let hermesHome = ''

function store(root: string, sessions: string[]): string {
  mkdirSync(root, { recursive: true })
  execFileSync('sqlite3', [
    join(root, 'state.db'),
    'CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL);'
    + sessions.map((id) => `INSERT INTO sessions VALUES ('${id}','cli');`).join(''),
  ])
  writeFileSync(join(root, 'config.yaml'), 'model: nous/hermes-4\n')
  return root
}

/** A hook arriving on a pane the daemon has not met: the process agent is opened first, as the hook
 *  server does, then the session binds to it. */
function bindSession(
  registry: Awaited<ReturnType<typeof load>>['registry'],
  sessionId: string,
  pane: string,
  pid: number,
) {
  const processIdentity = { pid, executable: 'hermes', startMarker: `Mon Sep 21 15:22:${pid % 60} 2026` }
  registry.openProcessAgent({ engine: 'hermes', tmuxPane: pane, cwd: '/tmp/work', processIdentity })
  const result = registry.register({ engine: 'hermes', sessionId, cwd: '/tmp/work', tmuxPane: pane, processIdentity })
  if (!result) throw new Error('registration refused')
  return result.entry
}

async function load() {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = dataDir
  process.env.CLAUDE_PROJECTS_DIR = dataDir
  process.env.HERMES_HOME = hermesHome
  const home = await import('../engines/hermes/home.js')
  home.forgetHermesHomes()
  return { ...await import('./hermesHome.js'), ...await import('./registry.js') }
}

d('the Hermes store a session reads from', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'adapter-hm-data-'))
    hermesHome = mkdtempSync(join(tmpdir(), 'adapter-hm-home-'))
  })

  afterEach(() => {
    for (const dir of [dataDir, hermesHome]) rmSync(dir, { recursive: true, force: true })
    delete process.env.ADAPTER_DATA_DIR
    delete process.env.CLAUDE_PROJECTS_DIR
    delete process.env.HERMES_HOME
  })

  it('reads a profile session from its own store and remembers the home on the row', async () => {
    store(hermesHome, [DEFAULT_SESSION])
    const demo = store(join(hermesHome, 'profiles', 'demo'), [PROFILE_SESSION])
    const { hermesDbForSession, registry } = await load()

    const entry = bindSession(registry, PROFILE_SESSION, '%7', 4242)
    expect(entry.hermesHome ?? null).toBeNull()   // nothing known yet — the row was just born

    expect(await hermesDbForSession(entry)).toBe(join(demo, 'state.db'))
    // Found once: the row now carries it, so the next poll opens no other store.
    expect(registry.resolve(entry.agentId)?.hermesHome).toBe(demo)
    // …and it survives a reload, which is where a field added to the type but not to the rehydrate
    // list silently disappears.
    const reloaded = await load()
    reloaded.registry.load()   // the daemon's own first act — the singleton does not read on import
    expect(reloaded.registry.resolve(entry.agentId)?.hermesHome).toBe(demo)
  })

  it('a default-home session keeps reading the default store, and writes nothing to its row', async () => {
    store(hermesHome, [DEFAULT_SESSION])
    const { hermesDbForSession, registry } = await load()

    const entry = bindSession(registry, DEFAULT_SESSION, '%8', 4243)

    expect(await hermesDbForSession(entry)).toBe(join(hermesHome, 'state.db'))
    expect(registry.resolve(entry.agentId)?.hermesHome ?? null).toBeNull()
  })

  it('a session no store has yet falls back to the default, and does not remember that', async () => {
    store(hermesHome, [])
    const { hermesDbForSession, registry } = await load()

    const entry = bindSession(registry, PROFILE_SESSION, '%9', 4244)

    expect(await hermesDbForSession(entry)).toBe(join(hermesHome, 'state.db'))
    expect(registry.resolve(entry.agentId)?.hermesHome ?? null).toBeNull()
  })

  it('a home the row already knows is taken as-is, with no lookup', async () => {
    store(hermesHome, [DEFAULT_SESSION, PROFILE_SESSION])   // the default store holds BOTH
    const { hermesDbForSession } = await load()
    // …so a lookup would answer the default home; the row's own answer must win.
    expect(await hermesDbForSession({
      agentId: 'a1', sessionId: PROFILE_SESSION, hermesHome: '/somewhere/else',
    })).toBe('/somewhere/else/state.db')
  })
})
