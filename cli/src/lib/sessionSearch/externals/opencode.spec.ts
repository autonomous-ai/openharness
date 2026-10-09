/**
 * OpenCode and Kilo discovery against real stores: fixture databases built from the schema dumped
 * (read-only) from opencode 1.18.31's `opencode.db`, in WAL mode, read through both of Harness's
 * SQLite paths (`node:sqlite`, and the `sqlite3` CLI a Node without it falls back to). No real
 * conversation text: every row here is made up.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { builtinSqlite, closeSqliteHandles, overrideBuiltinSqlite } from '../../sqliteBuiltin.js'
import {
  LIST_LIMIT, ancestry, argvSubcommand, engineProcess, opencodeListSql, opencodeProvider, opencodeTurnOpen,
  ownerRecord, parseOwnerRecord, readSql, rowsOf, splitCounts, storeStamp, tableColumns, tally, type SqlRead,
} from './opencode.js'
import { scanMemo } from './support.js'
import type { ProcessView, RunningProcess, ScanContext } from './types.js'

const Database = builtinSqlite()!
type Db = InstanceType<typeof Database>

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ext-opencode-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  closeSqliteHandles()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** opencode 1.18.31's own DDL for the tables discovery reads (`.schema`, read-only, this machine). */
const SCHEMA = `
CREATE TABLE \`project\` (
  \`id\` text PRIMARY KEY, \`worktree\` text NOT NULL, \`vcs\` text, \`name\` text, \`icon_url\` text,
  \`icon_url_override\` text, \`icon_color\` text, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL,
  \`time_initialized\` integer, \`sandboxes\` text NOT NULL, \`commands\` text
);
CREATE TABLE \`message\` (
  \`id\` text PRIMARY KEY, \`session_id\` text NOT NULL, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL,
  \`data\` text NOT NULL,
  CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
);
CREATE TABLE \`part\` (
  \`id\` text PRIMARY KEY, \`message_id\` text NOT NULL, \`session_id\` text NOT NULL, \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL, \`data\` text NOT NULL,
  CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
);
CREATE TABLE \`session\` (
  \`id\` text PRIMARY KEY, \`project_id\` text NOT NULL, \`workspace_id\` text, \`parent_id\` text, \`slug\` text NOT NULL,
  \`directory\` text NOT NULL, \`path\` text, \`title\` text NOT NULL, \`version\` text NOT NULL, \`share_url\` text,
  \`summary_additions\` integer, \`summary_deletions\` integer, \`summary_files\` integer, \`summary_diffs\` text,
  \`metadata\` text, \`cost\` real DEFAULT 0 NOT NULL, \`tokens_input\` integer DEFAULT 0 NOT NULL,
  \`tokens_output\` integer DEFAULT 0 NOT NULL, \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
  \`tokens_cache_read\` integer DEFAULT 0 NOT NULL, \`tokens_cache_write\` integer DEFAULT 0 NOT NULL, \`revert\` text,
  \`permission\` text, \`agent\` text, \`model\` text, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL,
  \`time_compacting\` integer, \`time_archived\` integer,
  CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
);
CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);
CREATE INDEX \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);
CREATE INDEX \`part_session_idx\` ON \`part\` (\`session_id\`);
CREATE INDEX \`session_project_idx\` ON \`session\` (\`project_id\`);
CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`);
`

/** What `opencode run` writes (measured, 1.18.32): no one is there to answer a question. */
const RUN_PERMISSION = JSON.stringify([
  { permission: 'question', pattern: '*', action: 'deny' },
  { permission: 'plan_enter', pattern: '*', action: 'deny' },
  { permission: 'plan_exit', pattern: '*', action: 'deny' },
])

const T0 = 1_789_900_000_000

interface SessionRow {
  directory?: string
  title?: string
  parent?: string | null
  archived?: number | null
  permission?: string | null
  updated?: number
}

class Store {
  readonly db: Db
  private seq = 0
  constructor(readonly path: string, schema = SCHEMA) {
    this.db = new Database(path, { readOnly: false })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(schema)
    if (schema === SCHEMA) {
      this.db.prepare("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('p', '/', 0, 0, '[]')").all()
    }
  }

  session(id: string, row: SessionRow = {}): this {
    this.db.prepare(
      'INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, permission, time_created, time_updated, time_archived)'
      + " VALUES (?, 'p', ?, 'slug', ?, ?, '1.18.31', ?, ?, ?, ?)",
    ).all(id, row.parent ?? null, row.directory ?? `/work/${id}`, row.title ?? 'A title', row.permission ?? null,
      T0, row.updated ?? T0, row.archived ?? null)
    return this
  }

  message(sessionId: string, data: Record<string, unknown>, at = T0, parts: Array<Record<string, unknown>> = []): string {
    const id = `msg_${String(++this.seq).padStart(4, '0')}`
    this.db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
      .all(id, sessionId, at, at, JSON.stringify(data))
    parts.forEach((part, index) => {
      this.db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
        .all(`prt_${id}_${index}`, id, sessionId, at + index, at + index, JSON.stringify(part))
    })
    return id
  }

  /** A person's ask and a finished answer. */
  turn(sessionId: string, at = T0): this {
    this.message(sessionId, { role: 'user', time: { created: at } }, at, [{ type: 'text', text: 'please fix the build' }])
    this.message(sessionId, { role: 'assistant', time: { created: at + 1, completed: at + 2 }, finish: 'stop' }, at + 1, [
      { type: 'text', text: 'Done.' }, { type: 'step-finish', reason: 'stop' },
    ])
    return this
  }

  close(): void { this.db.close() }
}

function context(excluded: string[] = []): { ctx: ScanContext; memo: ReturnType<typeof scanMemo> } {
  const memo = scanMemo({ excluded })
  return { ctx: memo.context(), memo }
}

const READERS: Array<[string, typeof Database | null]> = [['node:sqlite', Database], ['the sqlite3 CLI', null]]

describe.each(READERS)('OpenCode discovery read through %s', (_name, reader) => {
  beforeAll(() => { overrideBuiltinSqlite(reader) })
  afterAll(() => { overrideBuiltinSqlite(Database) })

  it('lists only the conversations a person started and can resume, and says why each other one is left out', async () => {
    const dir = tempDir()
    const store = new Store(join(dir, 'opencode.db'))
    store.session('ses_person', { directory: '/work/app', title: 'Fix the build', updated: T0 + 10 }).turn('ses_person', T0 + 5)
    store.session('ses_placeholder', { title: 'New session - 2026-09-20T10:00:00.000Z' }).turn('ses_placeholder')
    store.session('ses_childplaceholder', { title: 'Child session - 2026-09-20T10:00:00.000Z' }).turn('ses_childplaceholder')
    store.session('ses_notplaceholder', { title: 'New session - my notes' }).turn('ses_notplaceholder')
    store.session('ses_subagent', { parent: 'ses_person' }).turn('ses_subagent')
    store.session('ses_archived', { archived: T0 }).turn('ses_archived')
    store.session('ses_run', { permission: RUN_PERMISSION }).turn('ses_run')
    store.session('ses_github', { permission: JSON.stringify([{ permission: 'question', action: 'deny' }]) }).turn('ses_github')
    store.session('ses_askallowed', { permission: JSON.stringify([{ permission: 'question', action: 'allow' }]) }).turn('ses_askallowed')
    store.session('ses_otherdeny', { permission: JSON.stringify([{ permission: 'bash', action: 'deny' }]) }).turn('ses_otherdeny')
    store.session('ses_badpermission', { permission: 'not json at all' }).turn('ses_badpermission')
    store.session('ses_stringpermission', { permission: '["question","deny"]' }).turn('ses_stringpermission')
    store.session('ses_empty')
    store.session('ses_relative', { directory: 'relative/folder' }).turn('ses_relative')
    store.session('ses_recap', { directory: join(dir, 'harness-data', 'opencode-recap') }).turn('ses_recap')
    store.session('not-an-id').turn('not-an-id')

    const provider = opencodeProvider({ engine: 'opencode', dbPath: store.path })
    const found = await provider.scan(context([join(dir, 'harness-data')]).ctx)
    const byId = new Map(found.map((s) => [s.sessionId, s]))
    expect([...byId.keys()].sort()).toEqual([
      'ses_askallowed', 'ses_badpermission', 'ses_childplaceholder', 'ses_notplaceholder', 'ses_otherdeny',
      'ses_person', 'ses_placeholder', 'ses_stringpermission',
    ])
    expect(provider.lastScan()).toEqual({
      found: 8, child: 1, archived: 1, headless: 2, empty: 1, noFolder: 1, excluded: 1, badId: 1,
    })
    const person = byId.get('ses_person')!
    expect(person).toMatchObject({
      engine: 'opencode', cwd: '/work/app', origin: 'terminal', title: 'Fix the build', transcriptPath: null, mtime: T0 + 10,
    })
    expect(person.launchArgs).toBeUndefined()
    // A placeholder is no title: the index names it by its first ask instead.
    expect(byId.get('ses_placeholder')!.title).toBe('')
    expect(byId.get('ses_childplaceholder')!.title).toBe('')
    expect(byId.get('ses_notplaceholder')!.title).toBe('New session - my notes')
    const events = await person.readHistory!()
    expect(events.map((e) => e.type)).toEqual(['user_message', 'text_delta', 'done'])
    store.close()
  })

  it('takes the later of time_updated and the last message, in milliseconds', async () => {
    const store = new Store(join(tempDir(), 'opencode.db'))
    // time_updated lagged its messages by 75 minutes on this machine.
    store.session('ses_lagging', { updated: T0 }).turn('ses_lagging', T0 + 4_500_000)
    store.session('ses_current', { updated: T0 + 9_000_000 }).turn('ses_current', T0)
    // No usable time at all still lists it, as the oldest.
    store.session('ses_timeless', { updated: 0 }).message('ses_timeless', { role: 'user' }, 0)
    const found = await opencodeProvider({ engine: 'opencode', dbPath: store.path }).scan(context().ctx)
    expect(Object.fromEntries(found.map((s) => [s.sessionId, s.mtime]))).toEqual({
      ses_lagging: T0 + 4_500_001, ses_current: T0 + 9_000_000, ses_timeless: 0,
    })
    store.close()
  })

  it('reads a store once until its files change, and not at all when the machine has no SQLite reader', async () => {
    const store = new Store(join(tempDir(), 'opencode.db'))
    store.session('ses_one').turn('ses_one')
    const read = vi.fn(readSql)
    const provider = opencodeProvider({ engine: 'opencode', dbPath: store.path, read })
    const { ctx, memo } = context()
    expect((await provider.scan(ctx)).map((s) => s.sessionId)).toEqual(['ses_one'])
    const reads = read.mock.calls.length
    expect(reads).toBe(2) // the schema, then the list
    memo.prune()
    expect((await provider.scan(memo.context())).map((s) => s.sessionId)).toEqual(['ses_one'])
    expect(read.mock.calls.length).toBe(reads)
    expect(provider.lastScan()).toEqual({ found: 1 })

    store.session('ses_two').turn('ses_two', T0 + 50)
    expect((await provider.scan(memo.context())).map((s) => s.sessionId).sort()).toEqual(['ses_one', 'ses_two'])
    expect(read.mock.calls.length).toBe(reads + 2)

    const none = opencodeProvider({ engine: 'opencode', dbPath: store.path, read, available: () => false })
    expect(await none.scan(context().ctx)).toEqual([])
    expect(none.lastScan()).toEqual({})
    expect(read.mock.calls.length).toBe(reads + 2)
    store.close()
  })

  it('finds nothing where there is no store, and fails loudly on a store it cannot read', async () => {
    const dir = tempDir()
    const read = vi.fn(readSql)
    expect(await opencodeProvider({ engine: 'opencode', dbPath: join(dir, 'missing.db'), read }).scan(context().ctx)).toEqual([])
    mkdirSync(join(dir, 'folder.db'))
    expect(await opencodeProvider({ engine: 'opencode', dbPath: join(dir, 'folder.db'), read }).scan(context().ctx)).toEqual([])
    expect(read).not.toHaveBeenCalled()

    // Not a database: the scan throws, so discovery keeps what it found last time and says why.
    writeFileSync(join(dir, 'garbage.db'), 'this is not a database, just text '.repeat(200))
    await expect(opencodeProvider({ engine: 'opencode', dbPath: join(dir, 'garbage.db') }).scan(context().ctx))
      .rejects.toThrow(/^garbage\.db not readable: /)
  })

  it('sees committed rows only, whether a writer holds a transaction open or the log is gone', async () => {
    const store = new Store(join(tempDir(), 'opencode.db'))
    store.session('ses_committed').turn('ses_committed')
    const provider = opencodeProvider({ engine: 'opencode', dbPath: store.path })
    const { memo } = context()
    store.db.exec('BEGIN IMMEDIATE')
    store.session('ses_uncommitted').turn('ses_uncommitted')
    expect((await provider.scan(memo.context())).map((s) => s.sessionId)).toEqual(['ses_committed'])
    store.db.exec('COMMIT')
    expect((await provider.scan(memo.context())).map((s) => s.sessionId).sort()).toEqual(['ses_committed', 'ses_uncommitted'])
    closeSqliteHandles()
    store.close()
    // The last connection closed: SQLite checkpointed and removed the log, as an idle engine leaves it.
    expect(existsSync(`${store.path}-wal`)).toBe(false)
    expect((await provider.scan(context().ctx)).map((s) => s.sessionId).sort()).toEqual(['ses_committed', 'ses_uncommitted'])
    // …and reading it created nothing in the engine's folder.
    expect(existsSync(`${store.path}-wal`)).toBe(false)
    expect(existsSync(`${store.path}-shm`)).toBe(false)
  })

  it('lists the newest 500 and counts the rest as older', async () => {
    const store = new Store(join(tempDir(), 'opencode.db'))
    store.db.exec('BEGIN')
    for (let i = 0; i < LIST_LIMIT + 3; i++) {
      const id = `ses_many${String(i).padStart(4, '0')}`
      store.session(id, { updated: T0 + i }).message(id, { role: 'user' }, T0)
    }
    store.db.exec('COMMIT')
    const provider = opencodeProvider({ engine: 'opencode', dbPath: store.path })
    const found = await provider.scan(context().ctx)
    expect(found).toHaveLength(LIST_LIMIT)
    expect(found.some((s) => s.sessionId === 'ses_many0000')).toBe(false)
    expect(found.some((s) => s.sessionId === `ses_many${String(LIST_LIMIT + 2).padStart(4, '0')}`)).toBe(true)
    expect(provider.lastScan()).toEqual({ found: LIST_LIMIT, older: 3 })
    store.close()
  })

  it('reads an older schema by the columns it has', async () => {
    const dir = tempDir()
    // No title, parent, archive or permission column yet; messages as today.
    const lean = new Store(join(dir, 'lean.db'), 'CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_updated INTEGER NOT NULL);'
      + 'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);')
    lean.db.exec(`INSERT INTO session VALUES ('ses_lean', '/work/lean', ${T0}), ('ses_leanempty', '/work/lean', ${T0})`)
    lean.message('ses_lean', { role: 'user' })
    const provider = opencodeProvider({ engine: 'opencode', dbPath: lean.path })
    expect(await provider.scan(context().ctx)).toMatchObject([{ sessionId: 'ses_lean', title: '', cwd: '/work/lean' }])
    expect(provider.lastScan()).toEqual({ found: 1, empty: 1 })

    // No message table: nothing was ever said in any of them.
    const bare = new Store(join(dir, 'bare.db'), 'CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_updated INTEGER NOT NULL);')
    bare.db.exec(`INSERT INTO session VALUES ('ses_bare', '/work/bare', ${T0})`)
    const bareProvider = opencodeProvider({ engine: 'opencode', dbPath: bare.path })
    expect(await bareProvider.scan(context().ctx)).toEqual([])
    expect(bareProvider.lastScan()).toEqual({ found: 0, empty: 1 })

    // Not OpenCode's store at all.
    const other = new Store(join(dir, 'other.db'), 'CREATE TABLE notes (id TEXT);')
    const otherProvider = opencodeProvider({ engine: 'opencode', dbPath: other.path })
    expect(await otherProvider.scan(context().ctx)).toEqual([])
    expect(otherProvider.lastScan()).toEqual({ found: 0 })
    lean.close(); bare.close(); other.close()
  })

  it('says from the last message whether a turn is running', async () => {
    const store = new Store(join(tempDir(), 'opencode.db'))
    const provider = opencodeProvider({ engine: 'opencode', dbPath: store.path })
    const busy = (id: string) => provider.busy!({ pid: 1, record: ownerRecord(store.path, id) })
    const at = { created: T0, completed: T0 + 1 }

    store.session('ses_new')
    expect(await busy('ses_new')).toBe(false)

    store.session('ses_asked').message('ses_asked', { role: 'user' })
    expect(await busy('ses_asked')).toBe(true)

    store.session('ses_streaming').message('ses_streaming', { role: 'assistant', time: { created: T0 } }, T0, [{ type: 'text', text: '…' }])
    expect(await busy('ses_streaming')).toBe(true)

    store.session('ses_done').turn('ses_done')
    expect(await busy('ses_done')).toBe(false)

    store.session('ses_toolcalls').message('ses_toolcalls', { role: 'assistant', time: at, finish: 'tool-calls' }, T0, [
      { type: 'tool', tool: 'bash', state: { status: 'completed' } }, { type: 'step-finish', reason: 'tool-calls' },
    ])
    expect(await busy('ses_toolcalls')).toBe(true)

    // `!cmd`: a shell run leaves a completed assistant with no finish and one completed tool (measured).
    store.session('ses_shell').message('ses_shell', { role: 'assistant', time: at }, T0, [
      { type: 'tool', tool: 'bash', state: { status: 'completed' } },
    ])
    expect(await busy('ses_shell')).toBe(false)

    for (const status of ['running', 'pending']) {
      store.session(`ses_tool${status}`).message(`ses_tool${status}`, { role: 'assistant', time: at }, T0, [
        { type: 'reasoning', text: 'hmm' }, { type: 'tool', tool: 'bash', state: { status } },
      ])
      expect(await busy(`ses_tool${status}`)).toBe(true)
    }

    // Esc mid-tool: the step had finished with tool-calls, then the message took the abort.
    store.session('ses_aborted').message('ses_aborted', { role: 'assistant', time: at, finish: 'tool-calls', error: { name: 'MessageAbortedError' } }, T0, [
      { type: 'tool', tool: 'bash', state: { status: 'error', error: 'aborted', metadata: { interrupted: true } } },
    ])
    expect(await busy('ses_aborted')).toBe(false)

    store.session('ses_nullerror').message('ses_nullerror', { role: 'assistant', time: { created: T0 }, error: null })
    expect(await busy('ses_nullerror')).toBe(true)

    // A refused permission ends the turn with tool-calls and no stop (kilo, measured).
    store.session('ses_refused').message('ses_refused', { role: 'assistant', time: at, finish: 'tool-calls' }, T0, [
      { type: 'tool', tool: 'bash', state: { status: 'error', error: 'The user rejected permission to use this specific tool call.' } },
    ])
    expect(await busy('ses_refused')).toBe(false)

    store.session('ses_failedtool').message('ses_failedtool', { role: 'assistant', time: at, finish: 'tool-calls' }, T0, [
      { type: 'tool', tool: 'read', state: { status: 'error', error: 'ENOENT: no such file' } },
    ])
    expect(await busy('ses_failedtool')).toBe(true)

    store.session('ses_odd').message('ses_odd', { role: 'system' })
    expect(await busy('ses_odd')).toBeNull()

    expect(await provider.busy!({ pid: 1, record: 'no-hash-here' })).toBeNull()
    expect(await provider.busy!({ pid: 1, record: ownerRecord(join(tempDir(), 'gone.db'), 'ses_x') })).toBeNull()
    store.close()
  })
})

describe('Kilo discovery', () => {
  it('reads kilo.db the same way and replays its history with the kilo reader', async () => {
    const store = new Store(join(tempDir(), 'kilo.db'))
    store.session('ses_024a007fdffe11yG68JPxsHJly', { directory: '/work/kilo', title: 'Kilo work' }).turn('ses_024a007fdffe11yG68JPxsHJly')
    store.session('ses_kilorun', { permission: RUN_PERMISSION }).turn('ses_kilorun')
    const provider = opencodeProvider({ engine: 'kilo', dbPath: store.path })
    const found = await provider.scan(context().ctx)
    expect(found).toMatchObject([{ sessionId: 'ses_024a007fdffe11yG68JPxsHJly', engine: 'kilo', cwd: '/work/kilo', title: 'Kilo work' }])
    expect(provider.lastScan()).toEqual({ found: 1, headless: 1 })
    expect((await found[0].readHistory!()).map((e) => e.type)).toEqual(['user_message', 'text_delta', 'done'])
    store.close()
  })

  it('keeps the memo of each engine apart', async () => {
    const dir = tempDir()
    const opencode = new Store(join(dir, 'opencode.db'))
    opencode.session('ses_oc').turn('ses_oc')
    const { ctx } = context()
    expect((await opencodeProvider({ engine: 'opencode', dbPath: opencode.path }).scan(ctx))[0].engine).toBe('opencode')
    // The same file under the other engine is read again, not served from opencode's memo.
    expect((await opencodeProvider({ engine: 'kilo', dbPath: opencode.path }).scan(ctx))[0].engine).toBe('kilo')
    opencode.close()
  })
})

describe('a store that cannot be read right now', () => {
  const failing = (result: Awaited<ReturnType<SqlRead>>): SqlRead => async () => result

  it('throws for a locked store so the last list is kept, and finds nothing when SQLite goes missing', async () => {
    const store = new Store(join(tempDir(), 'opencode.db'))
    store.close()
    await expect(opencodeProvider({ engine: 'opencode', dbPath: store.path, read: failing({ ok: false, reason: 'transient' }) }).scan(context().ctx))
      .rejects.toThrow('opencode.db not readable: locked')
    await expect(opencodeProvider({ engine: 'opencode', dbPath: store.path, read: failing({ ok: false, reason: 'transient', error: new Error('database is locked') }) }).scan(context().ctx))
      .rejects.toThrow('opencode.db not readable: database is locked')
    expect(await opencodeProvider({ engine: 'opencode', dbPath: store.path, read: failing({ ok: false, reason: 'missing' }) }).scan(context().ctx)).toEqual([])

    // The schema reads, then the CLI vanishes before the list.
    let calls = 0
    const vanishing: SqlRead = async (db, sql, params) => (++calls === 1 ? readSql(db, sql, params) : { ok: false, reason: 'missing' })
    expect(await opencodeProvider({ engine: 'opencode', dbPath: store.path, read: vanishing }).scan(context().ctx)).toEqual([])
  })
})

describe('OpenCode owners', () => {
  const view = (rows: Array<Partial<RunningProcess> & { pid: number; args: string }>): ProcessView => ({
    list: async () => rows.map((row) => ({ ppid: 1, executable: row.args.split(' ')[0], ...row })),
    openFiles: async () => new Map(),
    cwds: async () => new Map(), openFilesOf: async () => new Map(),
    alive: () => true,
  })

  // Arguments name the session a process started on: a guess once the TUI switches, so `fromArgs`.
  it('claims a session only from the id in an OpenCode process\'s own arguments', async () => {
    const provider = opencodeProvider({ engine: 'opencode', dbPath: '/data/opencode.db' })
    const claims = await provider.owners!(view([
      { pid: 10, args: 'opencode -s ses_resumed' },
      { pid: 11, args: 'opencode --session=ses_equals' },
      { pid: 12, args: '/opt/homebrew/bin/node /usr/lib/node_modules/opencode-ai/bin/opencode --session ses_npm', executable: 'node' },
      // `--fork` writes a new session: the id named is the parent's.
      { pid: 13, args: 'opencode -s ses_parent --fork' },
      { pid: 14, args: 'opencode -c' },
      { pid: 15, args: 'opencode' },
      // Not OpenCode, whatever its arguments say.
      { pid: 16, args: '/Users/x/.hermes/node/bin/node script.js -s ses_decoy', executable: 'node' },
      { pid: 17, args: 'python3 worker.py opencode -s ses_decoy2', executable: 'python3' },
      { pid: 18, args: 'kilo -s ses_kilos' },
      { pid: 19, args: 'opencode serve -s ses_served --port 4096' },
    ]))
    expect(claims).toEqual([
      { sessionId: 'ses_resumed', pid: 10, record: '/data/opencode.db#ses_resumed', fromArgs: true },
      { sessionId: 'ses_equals', pid: 11, record: '/data/opencode.db#ses_equals', fromArgs: true },
      { sessionId: 'ses_npm', pid: 12, record: '/data/opencode.db#ses_npm', fromArgs: true },
      { sessionId: 'ses_served', pid: 19, record: '/data/opencode.db#ses_served', app: true, fromArgs: true },
    ])
  })

  it("claims kilo's own processes for kilo, and a daemon's as an app", async () => {
    const provider = opencodeProvider({ engine: 'kilo', dbPath: '/data/kilo.db' })
    const claims = await provider.owners!(view([
      { pid: 20, args: 'kilo -s ses_tui' },
      { pid: 21, args: 'kilo serve --port 4097 --session ses_daemon' },
      { pid: 22, args: 'kilo --session ses_forked --fork' },
      { pid: 23, args: 'opencode -s ses_notkilo' },
    ]))
    expect(claims).toEqual([
      { sessionId: 'ses_tui', pid: 20, record: '/data/kilo.db#ses_tui', fromArgs: true },
      { sessionId: 'ses_daemon', pid: 21, record: '/data/kilo.db#ses_daemon', app: true, fromArgs: true },
    ])
  })
})

describe('the shared helpers', () => {
  it('reads an interpreter-launched engine\'s subcommand, past flags and their values', () => {
    const flags = new Set(['-p', '-s'])
    expect(argvSubcommand('opencode serve --port 1', flags)).toBe('serve')
    expect(argvSubcommand('node /x/opencode-ai/bin/opencode web', flags)).toBe('web')
    expect(argvSubcommand('python3 /x/venv/bin/hermes -p work gateway run', flags)).toBe('gateway')
    expect(argvSubcommand('opencode /work/project -s ses_1', flags)).toBe('')
    expect(argvSubcommand('opencode --verbose -- serve', flags)).toBe('')
    expect(argvSubcommand('opencode -s', flags)).toBe('')
  })

  it('names the store and session a claim is about, and refuses anything else', () => {
    expect(parseOwnerRecord(ownerRecord('/a#b/state.db', 'ses_1'))).toEqual({ dbPath: '/a#b/state.db', sessionId: 'ses_1' })
    expect(parseOwnerRecord('#ses_1')).toBeNull()
    expect(parseOwnerRecord('/a/state.db#')).toBeNull()
    expect(parseOwnerRecord('nothing')).toBeNull()
  })

  it('walks a process up to its ancestors, and stops at a loop', () => {
    const rows = new Map<number, RunningProcess>([
      [1, { pid: 1, ppid: 1, executable: 'launchd', args: 'launchd' }],
      [5, { pid: 5, ppid: 1, executable: 'zsh', args: 'zsh' }],
      [9, { pid: 9, ppid: 5, executable: 'hermes', args: 'hermes' }],
    ])
    expect(ancestry(rows, 9, 4).map((row) => row.pid)).toEqual([9, 5, 1])
    expect(ancestry(rows, 9, 1).map((row) => row.pid)).toEqual([9, 5])
    expect(ancestry(rows, 42, 4)).toEqual([])
  })

  it('matches an engine by its executable, never by a word in the arguments', () => {
    const isOpencode = engineProcess('opencode')
    expect(isOpencode({ pid: 1, ppid: 0, executable: 'opencode', args: 'opencode' })).toBe(true)
    expect(isOpencode({ pid: 1, ppid: 0, executable: 'grep', args: 'grep opencode' })).toBe(false)
  })

  it('counts', () => {
    const counts = {}
    tally(counts, 'a')
    tally(counts, 'a', 2)
    expect(counts).toEqual({ a: 3 })
    expect(splitCounts([
      { id: 'x' }, { id: null, skip: 'child', n: 2 }, { id: null, skip: '', n: 7 }, { id: null, skip: '', n: LIST_LIMIT + 4 },
      { id: null, skip: 'weird', n: 'NaN' },
    ])).toEqual({ rows: [{ id: 'x' }], counts: { child: 2, older: 4, weird: 0 } })
    expect(opencodeListSql(new Set(['id', 'directory']), new Set())).toBeNull()
  })

  it('fingerprints a store by its database and its log', async () => {
    const dir = tempDir()
    expect(await storeStamp(join(dir, 'none.db'))).toBeNull()
    writeFileSync(join(dir, 'a.db'), 'x')
    expect(await storeStamp(join(dir, 'a.db'))).toMatch(/^1:[\d.]+\|-$/)
    writeFileSync(join(dir, 'a.db-wal'), 'xyz')
    expect(await storeStamp(join(dir, 'a.db'))).toMatch(/^1:[\d.]+\|3:[\d.]+$/)
  })

  it('reads a table\'s columns, and gives up with the reader', async () => {
    const store = new Store(join(tempDir(), 'opencode.db'))
    const columns = await tableColumns(readSql, store.path, ['session', 'nothing'])
    expect(columns?.get('session')?.has('time_archived')).toBe(true)
    expect(columns?.has('nothing')).toBe(false)
    expect(await tableColumns(async () => ({ ok: false, reason: 'missing' }), store.path, ['session'])).toBeNull()
    expect(await rowsOf(readSql, store.path, 'SELECT 1 AS one')).toEqual([{ one: 1 }])
    store.close()
  })

  it('reads no tail as idle, and an unknown role as unknowable', () => {
    expect(opencodeTurnOpen([])).toBe(false)
    expect(opencodeTurnOpen([{ role: 'tool' }])).toBeNull()
  })
})
