/**
 * How many background commands a Hermes session still runs, read from Hermes' own `processes.json` and the session
 * chain in its `state.db` (docs/plans/2026-11-12-background-count-design.md). `null` wherever Harness cannot know.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { hermesDbPath } from './contract.js'
import {
  HERMES_PROCESSES_MAX_BYTES,
  HERMES_PROCESSES_MAX_ENTRIES,
  hermesBackgroundCommands,
} from './backgroundCommands.js'

const hasSqlite = (() => {
  try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()
const d = hasSqlite ? describe : describe.skip

const OLD = '20261112_090000_aaaaaa', LIVE = '20261112_100000_bbbbbb', OTHER = '20261112_110000_cccccc'

/** One entry as Hermes' `_write_checkpoint` writes it (tools/process_registry.py); `key` undefined: an older format. */
const entry = (key: string | undefined, id: string) => ({ session_id: id, command: 'npm run build', pid: 4242, pid_scope: 'host',
  host_start_time: 1794472199.5, systemd_unit: null, cwd: '/work/app', started_at: 1794472200.1, task_id: 't1',
  ...(key === undefined ? {} : { session_key: key }), watcher_platform: '', watcher_chat_id: '', watcher_user_id: '',
  watcher_user_name: '', watcher_thread_id: '', watcher_message_id: '', watcher_interval: 0, parent_session_id: '',
  notify_on_complete: true, watch_patterns: [] })

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'hm-bg-'))
  roots.push(root)
  return root
}

/** A home whose store holds [sessions] (id, parent) and, when given, a `processes.json` with [processes] as its text. */
function home(sessions: Array<[string, string | null]>, processes?: string): string {
  const root = tempHome()
  execFileSync('sqlite3', [
    hermesDbPath(root),
    'CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, parent_session_id TEXT);'
    + sessions.map(([id, parent]) => `INSERT INTO sessions VALUES ('${id}','cli',${parent === null ? 'NULL' : `'${parent}'`});`).join(''),
  ])
  if (processes !== undefined) writeFileSync(join(root, 'processes.json'), processes)
  return root
}

d('hermesBackgroundCommands', () => {
  it('counts its own and the session it was compressed from, and nothing of another session', async () => {
    const h = home([[OLD, null], [LIVE, OLD], [OTHER, null]],
      JSON.stringify([entry(LIVE, 'proc_1'), entry(OLD, 'proc_2'), entry(OTHER, 'proc_3'), entry('', 'proc_4')]))
    expect(await hermesBackgroundCommands(h, LIVE)).toBe(2)
    expect(await hermesBackgroundCommands(h, OTHER)).toBe(1)
    expect(await hermesBackgroundCommands(h, OLD)).toBe(1)   // a child is not an ancestor
  })

  it('reads 0 from a list Hermes has emptied, and null where it never wrote one', async () => {
    expect(await hermesBackgroundCommands(home([[LIVE, null]], '[]'), LIVE)).toBe(0)
    expect(await hermesBackgroundCommands(home([[LIVE, null]]), LIVE)).toBeNull()
  })

  it('is null, never 0, for what it cannot read', async () => {
    const of = (text: string) => hermesBackgroundCommands(home([[LIVE, null]], text), LIVE)
    expect(await of(JSON.stringify([entry(undefined, 'proc_1')]))).toBeNull()   // no session_key field
    for (const text of ['{}', 'not json', '[null]', '[3]', `[${' '.repeat(HERMES_PROCESSES_MAX_BYTES)}]`]) expect(await of(text)).toBeNull()
    expect(await of(JSON.stringify(Array.from({ length: HERMES_PROCESSES_MAX_ENTRIES + 1 }, (_, i) => entry(LIVE, `proc_${i}`))))).toBeNull()
    expect(await hermesBackgroundCommands(home([[OTHER, null]], '[]'), LIVE)).toBeNull()   // the store does not hold it
    const bare = tempHome()                                                                 // a list, and no store
    writeFileSync(join(bare, 'processes.json'), '[]')
    expect(await hermesBackgroundCommands(bare, LIVE)).toBeNull()
    expect(await hermesBackgroundCommands(home([[LIVE, null]], '[]'), 'not-an-id')).toBeNull()
  })

  it('walks at most 32 sessions up, and ends on a parent loop', async () => {
    const id = (i: number) => `20261112_1200${String(i).padStart(2, '0')}_abcdef`
    const chain: Array<[string, string | null]> = Array.from({ length: 41 }, (_, i) => [id(i), i ? id(i - 1) : null])
    const h = home(chain, JSON.stringify([entry(id(8), 'proc_in'), entry(id(7), 'proc_out')]))   // 32 and 33 above id(40)
    expect(await hermesBackgroundCommands(h, id(40))).toBe(1)
    const loop = home([[OLD, LIVE], [LIVE, OLD]], JSON.stringify([entry(OLD, 'proc_1')]))
    expect(await hermesBackgroundCommands(loop, LIVE)).toBe(1)
  })
})
