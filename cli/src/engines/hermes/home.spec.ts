/**
 * A machine with more than one Hermes home.
 *
 * `hermes -p <name>` keeps its sessions in `~/.hermes/profiles/<name>/state.db`, and the daemon used to
 * read `<HERMES_HOME>/state.db` everywhere — so a fleet of profile agents streamed their terminals and
 * then sat on "No activity yet" forever (openharness#191). These pin the two answers that fix it: which
 * homes exist, and which one holds a given session.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  findHermesHomeForSession,
  forgetHermesHomes,
  hermesConfigHomes,
  hermesDbPath,
  hermesHomeFromEnv,
  listHermesHomes,
} from './home.js'

const hasSqlite = (() => {
  try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()
const d = hasSqlite ? describe : describe.skip

const DEFAULT_SESSION = '20260727_162325_e25264'
const PROFILE_SESSION = '20260921_152236_a1b2c3'

/** A home with a `sessions` table holding exactly the ids given. */
function makeHome(root: string, sessions: string[], { config = true, db = true } = {}): string {
  mkdirSync(root, { recursive: true })
  if (config) writeFileSync(join(root, 'config.yaml'), 'model: nous/hermes-4\n')
  if (!db) return root
  execFileSync('sqlite3', [
    hermesDbPath(root),
    'CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, cwd TEXT);'
    + sessions.map((id) => `INSERT INTO sessions VALUES ('${id}','cli','/tmp/x');`).join(''),
  ])
  return root
}

d('hermes homes', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hm-home-'))
    forgetHermesHomes()
    return () => rmSync(root, { recursive: true, force: true })
  })

  it('lists the default home and every profile that has a store, default first', async () => {
    makeHome(root, [DEFAULT_SESSION])
    makeHome(join(root, 'profiles', 'demo'), [PROFILE_SESSION])
    // A profile whose first session has never run: a config, no store. Nothing to read, so not a home.
    makeHome(join(root, 'profiles', 'fresh'), [], { db: false })

    expect(await listHermesHomes(root)).toEqual([root, join(root, 'profiles', 'demo')])
    // …but it IS a home to install hooks into: that is what the block in its config is for.
    expect(hermesConfigHomes(root)).toEqual([
      root, join(root, 'profiles', 'demo'), join(root, 'profiles', 'fresh'),
    ])
  })

  it('a machine with no profiles folder answers with its one home', async () => {
    makeHome(root, [DEFAULT_SESSION])
    expect(await listHermesHomes(root)).toEqual([root])
    expect(hermesConfigHomes(root)).toEqual([root])
  })

  it('finds the home whose store holds the session', async () => {
    makeHome(root, [DEFAULT_SESSION])
    const demo = makeHome(join(root, 'profiles', 'demo'), [PROFILE_SESSION])
    const homes = await listHermesHomes(root)

    expect(await findHermesHomeForSession(DEFAULT_SESSION, homes)).toBe(root)
    // The one the old code could not see: its row is in the profile's store, not the default one.
    expect(await findHermesHomeForSession(PROFILE_SESSION, homes)).toBe(demo)
    // A session no store has yet — the caller falls back to the default rather than guessing.
    expect(await findHermesHomeForSession('20260101_000000_abcdef', homes)).toBeNull()
    // Not a Hermes id at all: refused without opening anything.
    expect(await findHermesHomeForSession('../../etc/passwd', homes)).toBeNull()
  })

  it('reads a home off a process environment, and only a real one', () => {
    expect(hermesHomeFromEnv('hermes', { HERMES_HOME: '/home/u/.hermes/profiles/demo' }, '/home/u/.hermes'))
      .toBe('/home/u/.hermes/profiles/demo')
    // The default home is "no profile" — the row stays null, as `codexHome` does.
    expect(hermesHomeFromEnv('hermes', { HERMES_HOME: '/home/u/.hermes/' }, '/home/u/.hermes')).toBeNull()
    expect(hermesHomeFromEnv('hermes', {}, '/home/u/.hermes')).toBeNull()
    // Junk, and another engine's process, say nothing.
    expect(hermesHomeFromEnv('hermes', { HERMES_HOME: 'relative/path' }, '/home/u/.hermes')).toBeNull()
    expect(hermesHomeFromEnv('hermes', { HERMES_HOME: '/bad\u0000path' }, '/home/u/.hermes')).toBeNull()
    expect(hermesHomeFromEnv('codex', { HERMES_HOME: '/home/u/.hermes/profiles/demo' }, '/home/u/.hermes')).toBeNull()
  })
})
