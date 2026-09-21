import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { opencodeModelFromArgv, setOpencodeSessionModel } from './sessionModel.js'

const hasSqlite = (() => {
  try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()
const d = hasSqlite ? describe : describe.skip

const SID = 'ses_testABC123'
const OTHER = 'ses_otherXYZ789'
const OLD = { providerID: 'opencode', modelID: 'big-pickle' }
const NEW = { providerID: 'minhduccm90-cecb9724', modelID: 'Qwen3.6-35B-A3B' }

function run(db: string, sql: string): string {
  return execFileSync('sqlite3', [db, sql], { stdio: ['ignore', 'pipe', 'inherit'] }).toString()
}
function esc(v: unknown): string {
  return JSON.stringify(v).replace(/'/g, "''")
}
/** The columns the writer touches, in the shape opencode 1.18.x keeps them. */
function schema(db: string, opts: { sessionModelColumn?: boolean } = {}): void {
  const model = opts.sessionModelColumn === false ? '' : ', model TEXT'
  run(db,
    `CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT${model});` +
    'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);')
}
function insertSession(db: string, id: string, model: Record<string, unknown> | null): void {
  run(db, `INSERT INTO session (id, title, model) VALUES ('${id}', 'a title', ${model ? `'${esc(model)}'` : 'NULL'});`)
}
function insertMessage(db: string, sid: string, mid: string, tc: number, data: Record<string, unknown>): void {
  run(db, `INSERT INTO message VALUES ('${mid}','${sid}',${tc},'${esc(data)}');`)
}
function messageData(db: string, mid: string): Record<string, unknown> {
  return JSON.parse(run(db, `SELECT data FROM message WHERE id = '${mid}';`).trim())
}
function sessionModel(db: string, sid: string): Record<string, unknown> | null {
  const raw = run(db, `SELECT model FROM session WHERE id = '${sid}';`).trim()
  return raw ? JSON.parse(raw) : null
}
const userMsg = (text: string, model = OLD) => ({ role: 'user', model, text })
const assistantMsg = (model = OLD) => ({ role: 'assistant', providerID: model.providerID, modelID: model.modelID })

/** A conversation as opencode leaves it: user, assistant, user, assistant — plus a stranger. */
function seed(db: string): void {
  insertSession(db, SID, { id: OLD.modelID, providerID: OLD.providerID, variant: 'default' })
  insertSession(db, OTHER, { id: OLD.modelID, providerID: OLD.providerID, variant: 'default' })
  insertMessage(db, SID, 'u1', 1, userMsg('first'))
  insertMessage(db, SID, 'a1', 2, assistantMsg())
  insertMessage(db, SID, 'u2', 3, userMsg('second'))
  insertMessage(db, SID, 'a2', 4, assistantMsg())
  insertMessage(db, OTHER, 'o1', 5, userMsg('elsewhere'))
}

d('setOpencodeSessionModel (sqlite3 CLI)', () => {
  let dir = ''
  let db = ''
  const realPath = process.env.PATH
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-session-model-'))
    db = join(dir, 'opencode.db')
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    process.env.PATH = realPath
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('rewrites only the latest user message and the session row', async () => {
    schema(db)
    seed(db)

    await expect(setOpencodeSessionModel(db, SID, NEW)).resolves.toEqual({ ok: true })

    // The row the resumed TUI reads its model from (prompt/index.tsx) — and only that row.
    expect(messageData(db, 'u2')).toEqual({ role: 'user', model: NEW, text: 'second' })
    // What the server's prompt path falls back to, in the shape opencode's own picker writes.
    expect(sessionModel(db, SID)).toEqual({ id: NEW.modelID, providerID: NEW.providerID, variant: 'default' })
    // An older user message, both assistant rows, and the other session are exactly as seeded.
    expect(messageData(db, 'u1')).toEqual({ role: 'user', model: OLD, text: 'first' })
    expect(messageData(db, 'a1')).toEqual(assistantMsg())
    expect(messageData(db, 'a2')).toEqual(assistantMsg())
    expect(messageData(db, 'o1')).toEqual({ role: 'user', model: OLD, text: 'elsewhere' })
    expect(sessionModel(db, OTHER)).toEqual({ id: OLD.modelID, providerID: OLD.providerID, variant: 'default' })
  })

  it('keeps the rest of the user message, and a variant it carried', async () => {
    schema(db)
    insertSession(db, SID, null)
    insertMessage(db, SID, 'u1', 1, { role: 'user', model: { ...OLD, variant: 'high' }, agent: 'build', time: { created: 1 } })

    await expect(setOpencodeSessionModel(db, SID, NEW)).resolves.toEqual({ ok: true })

    expect(messageData(db, 'u1')).toEqual({ role: 'user', model: { ...NEW, variant: 'high' }, agent: 'build', time: { created: 1 } })
    expect(sessionModel(db, SID)).toEqual({ id: NEW.modelID, providerID: NEW.providerID, variant: 'default' })
  })

  it('passes ids through as values, never as SQL', async () => {
    schema(db)
    seed(db)
    const odd = { providerID: "grid'; DROP TABLE session; --", modelID: 'a/b "c" d' }

    await expect(setOpencodeSessionModel(db, SID, odd)).resolves.toEqual({ ok: true })

    expect(messageData(db, 'u2')).toEqual({ role: 'user', model: odd, text: 'second' })
    expect(sessionModel(db, SID)).toEqual({ id: odd.modelID, providerID: odd.providerID, variant: 'default' })
  })

  it('is one transaction: a failing session UPDATE leaves the message UPDATE unapplied', async () => {
    // No `model` column on `session` makes the SECOND statement fail after the first has run.
    schema(db, { sessionModelColumn: false })
    run(db, `INSERT INTO session (id, title) VALUES ('${SID}', 'a title');`)
    insertMessage(db, SID, 'u1', 1, userMsg('first'))

    const result = await setOpencodeSessionModel(db, SID, NEW)

    expect(result).toMatchObject({ ok: false, code: 'OPENCODE_DB_WRITE_FAILED' })
    expect((result as { detail: string }).detail).toMatch(/no such column: model/)
    expect(messageData(db, 'u1')).toEqual(userMsg('first'))
  })

  it('reports OPENCODE_SESSION_NOT_FOUND for a session with no user message, and writes nothing', async () => {
    schema(db)
    insertSession(db, SID, { id: OLD.modelID, providerID: OLD.providerID, variant: 'default' })
    // An assistant row alone (never happens in practice) must not be rewritten either.
    insertMessage(db, SID, 'a1', 1, assistantMsg())
    insertMessage(db, OTHER, 'o1', 2, userMsg('elsewhere'))

    await expect(setOpencodeSessionModel(db, SID, NEW)).resolves.toMatchObject({ ok: false, code: 'OPENCODE_SESSION_NOT_FOUND' })

    expect(sessionModel(db, SID)).toEqual({ id: OLD.modelID, providerID: OLD.providerID, variant: 'default' })
    expect(messageData(db, 'a1')).toEqual(assistantMsg())
    expect(messageData(db, 'o1')).toEqual(userMsg('elsewhere'))
    // An unknown session is the same answer — nothing to rewrite.
    await expect(setOpencodeSessionModel(db, 'ses_nobody', NEW)).resolves.toMatchObject({ ok: false, code: 'OPENCODE_SESSION_NOT_FOUND' })
    // And so is an id that is not an opencode session id at all; it never reaches sqlite3.
    await expect(setOpencodeSessionModel(db, "ses_x'; --", NEW)).resolves.toMatchObject({ ok: false, code: 'OPENCODE_SESSION_NOT_FOUND' })
  })

  it('reports OPENCODE_SQLITE_MISSING when the CLI is not on PATH, and writes nothing', async () => {
    schema(db)
    seed(db)
    const empty = mkdtempSync(join(tmpdir(), 'no-sqlite-'))
    try {
      process.env.PATH = empty
      await expect(setOpencodeSessionModel(db, SID, NEW)).resolves.toMatchObject({ ok: false, code: 'OPENCODE_SQLITE_MISSING' })
    } finally {
      process.env.PATH = realPath
      rmSync(empty, { recursive: true, force: true })
    }
    expect(messageData(db, 'u2')).toEqual({ role: 'user', model: OLD, text: 'second' })
    expect(sessionModel(db, SID)).toEqual({ id: OLD.modelID, providerID: OLD.providerID, variant: 'default' })
  })

  it('reports OPENCODE_DB_WRITE_FAILED when the DB cannot be opened', async () => {
    await expect(setOpencodeSessionModel(join(dir, 'missing', 'opencode.db'), SID, NEW))
      .resolves.toMatchObject({ ok: false, code: 'OPENCODE_DB_WRITE_FAILED' })
  })
})

describe('opencodeModelFromArgv', () => {
  it('reads the last -m and splits provider from model at the first slash', () => {
    expect(opencodeModelFromArgv(['-m', 'minhduccm90-cecb9724/Qwen3.6-35B-A3B'])).toEqual(NEW)
    expect(opencodeModelFromArgv(['--model', 'vibe/minimax/minimax-m3'])).toEqual({ providerID: 'vibe', modelID: 'minimax/minimax-m3' })
    expect(opencodeModelFromArgv(['--model=opencode/big-pickle'])).toEqual(OLD)
    expect(opencodeModelFromArgv(['-m', 'a/b', '--agent', 'build', '-m', 'c/d'])).toEqual({ providerID: 'c', modelID: 'd' })
  })

  it('answers null when the argv names no usable model', () => {
    expect(opencodeModelFromArgv([])).toBeNull()
    expect(opencodeModelFromArgv(['--agent', 'build'])).toBeNull()
    expect(opencodeModelFromArgv(['-m'])).toBeNull()
    expect(opencodeModelFromArgv(['-m', 'bare-model'])).toBeNull()
    expect(opencodeModelFromArgv(['-m', '/x'])).toBeNull()
    expect(opencodeModelFromArgv(['-m', 'x/'])).toBeNull()
  })
})
