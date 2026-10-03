import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  applyOpencodeSessionModel,
  opencodeModelFromArgv,
  parseOpencodeModelId,
  setOpencodeSessionModel,
  switchOpencodeSessionModel,
  type OpencodeApiRun,
} from './sessionModel.js'

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

describe('parseOpencodeModelId', () => {
  it('splits at the first slash, the way opencode does', () => {
    expect(parseOpencodeModelId('vibe/minimax/minimax-m3')).toEqual({ providerID: 'vibe', modelID: 'minimax/minimax-m3' })
    expect(parseOpencodeModelId('bare')).toBeNull()
    expect(parseOpencodeModelId('/x')).toBeNull()
  })
})

/** A stand-in for `opencode api …`, answering the way 2.0.18 does. */
function fakeApi(answers: { switch?: () => string; get?: () => string; list?: () => string } = {}) {
  const calls: string[][] = []
  const run: OpencodeApiRun = async (args) => {
    calls.push(args)
    if (args[1] === 'model.list') {
      return { stdout: answers.list ? answers.list() : JSON.stringify({ data: [{ id: NEW.modelID, providerID: NEW.providerID }, { id: OLD.modelID, providerID: OLD.providerID }] }) }
    }
    if (args[1] === 'session.switchModel') return { stdout: answers.switch ? answers.switch() : '' }
    if (args[1] === 'session.get') {
      return { stdout: answers.get ? answers.get() : JSON.stringify({ data: { id: SID, model: { id: NEW.modelID, providerID: NEW.providerID, variant: 'default' } } }) }
    }
    throw new Error(`unexpected ${args.join(' ')}`)
  }
  return { run, calls }
}
/** What execFile rejects with when `opencode api` exits 1. */
function exitError(stdout: string, stderr = ''): Error {
  return Object.assign(new Error('Command failed'), { code: 1, stdout, stderr })
}

describe('switchOpencodeSessionModel (opencode v2, `opencode api`)', () => {
  it('switches through the running service, then reads the session back to prove it', async () => {
    const { run, calls } = fakeApi()
    await expect(switchOpencodeSessionModel(SID, NEW, { run })).resolves.toEqual({ ok: true })
    expect(calls).toEqual([
      ['api', 'session.switchModel', '--param', `sessionID=${SID}`, '-d', JSON.stringify({ model: { id: NEW.modelID, providerID: NEW.providerID } })],
      ['api', 'session.get', '--param', `sessionID=${SID}`],
    ])
  })

  it('refuses a session the service does not know, with the code the retarget reports', async () => {
    // 2.0.18 prints the body on stdout and the status on stderr, and exits 1.
    const { run } = fakeApi({ switch: () => { throw exitError('{"_tag":"SessionNotFoundError","message":"Session not found: ses_testABC123"}\n', 'HTTP 404 Not Found\n') } })
    await expect(switchOpencodeSessionModel(SID, NEW, { run }))
      .resolves.toMatchObject({ ok: false, code: 'OPENCODE_SESSION_NOT_FOUND', detail: expect.stringContaining('Session not found') })
  })

  it('refuses when the session still reads back on another model after a second try', async () => {
    const { run, calls } = fakeApi({ get: () => JSON.stringify({ data: { id: SID, model: { id: OLD.modelID, providerID: OLD.providerID } } }) })
    await expect(switchOpencodeSessionModel(SID, NEW, { run, retryDelayMs: 0 }))
      .resolves.toMatchObject({ ok: false, code: 'OPENCODE_MODEL_SWITCH_FAILED', detail: expect.stringContaining('opencode/big-pickle') })
    expect(calls.filter((c) => c[1] === 'session.switchModel')).toHaveLength(2)
  })

  // `provider/model#variant` is opencode's own way to name an effort (`opencode run -m`): on v2 the
  // variant goes in the switch, and the session must read back on it.
  it('switches the variant too when the model names one, and reads it back', async () => {
    const { run, calls } = fakeApi({ get: () => JSON.stringify({ data: { id: SID, model: { id: NEW.modelID, providerID: NEW.providerID, variant: 'high' } } }) })
    await expect(switchOpencodeSessionModel(SID, { ...NEW, modelID: `${NEW.modelID}#high` }, { run })).resolves.toEqual({ ok: true })
    expect(calls[0]).toEqual(['api', 'session.switchModel', '--param', `sessionID=${SID}`, '-d', JSON.stringify({ model: { id: NEW.modelID, providerID: NEW.providerID, variant: 'high' } })])
    const low = fakeApi({ get: () => JSON.stringify({ data: { id: SID, model: { id: NEW.modelID, providerID: NEW.providerID, variant: 'default' } } }) })
    await expect(switchOpencodeSessionModel(SID, { ...NEW, modelID: `${NEW.modelID}#high` }, { run: low.run, retryDelayMs: 0 }))
      .resolves.toMatchObject({ ok: false, code: 'OPENCODE_MODEL_SWITCH_FAILED' })
  })

  it('tries once more when the first switch did not land, and is done when the second does', async () => {
    let reads = 0
    const { run, calls } = fakeApi({ get: () => {
      reads += 1
      const m = reads === 1 ? OLD : NEW
      return JSON.stringify({ data: { id: SID, model: { id: m.modelID, providerID: m.providerID } } })
    } })
    await expect(switchOpencodeSessionModel(SID, NEW, { run, retryDelayMs: 0 })).resolves.toEqual({ ok: true })
    expect(calls.filter((c) => c[1] === 'session.switchModel')).toHaveLength(2)
  })

  it('does not try again where a second try cannot help (no such session)', async () => {
    const { run, calls } = fakeApi({ switch: () => { throw exitError('{"_tag":"SessionNotFoundError"}', 'HTTP 404 Not Found') } })
    await expect(switchOpencodeSessionModel(SID, NEW, { run, retryDelayMs: 0 })).resolves.toMatchObject({ ok: false, code: 'OPENCODE_SESSION_NOT_FOUND' })
    expect(calls.filter((c) => c[1] === 'session.switchModel')).toHaveLength(1)
  })

  // Measured on 2.0.18: the service stores any id — `opencode/does-not-exist` reads back as set —
  // so a model of opencode's own catalogue is checked against it first.
  it('refuses a model the service does not list, before switching, when asked to check', async () => {
    const { run, calls } = fakeApi({ list: () => JSON.stringify({ data: [{ id: OLD.modelID, providerID: OLD.providerID }] }) })
    await expect(switchOpencodeSessionModel(SID, NEW, { run, checkCatalog: true }))
      .resolves.toMatchObject({ ok: false, code: 'OPENCODE_MODEL_UNKNOWN', detail: expect.stringContaining('opencode models') })
    expect(calls.map((c) => c[1])).toEqual(['model.list'])
  })

  it('switches without the check when the catalogue cannot be read, or was not asked for (a grid declared per pane)', async () => {
    const { run, calls } = fakeApi({ list: () => { throw exitError('', 'HTTP 500') } })
    await expect(switchOpencodeSessionModel(SID, NEW, { run, checkCatalog: true })).resolves.toEqual({ ok: true })
    const plain = fakeApi({ list: () => JSON.stringify({ data: [] }) })
    await expect(switchOpencodeSessionModel(SID, NEW, { run: plain.run })).resolves.toEqual({ ok: true })
    expect(plain.calls.map((c) => c[1])).not.toContain('model.list')
    expect(calls.map((c) => c[1])).toContain('session.switchModel')
  })

  it('refuses when opencode is not installed, or the id is not a session id', async () => {
    const missing: OpencodeApiRun = async () => { throw Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' }) }
    await expect(switchOpencodeSessionModel(SID, NEW, { run: missing })).resolves.toMatchObject({ ok: false, code: 'OPENCODE_MISSING' })
    const { run, calls } = fakeApi()
    await expect(switchOpencodeSessionModel("ses_x'; rm", NEW, { run })).resolves.toMatchObject({ ok: false, code: 'OPENCODE_SESSION_NOT_FOUND' })
    expect(calls).toEqual([])
  })
})

/**
 * The store as 2.0.18 leaves it: v1's `session` / `message` tables still exist (empty for new
 * sessions), and the sessions live in `session_v2` / `session_message`.
 */
function schemaV2(db: string): void {
  schema(db)
  run(db,
    'CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, model TEXT, agent TEXT);' +
    'CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT);')
  run(db, `INSERT INTO session_v2 VALUES ('${SID}', '/w', '${esc({ id: OLD.modelID, providerID: OLD.providerID })}', 'build');`)
  run(db, `INSERT INTO session_message VALUES ('m1', '${SID}', 'user', 1, '${esc({ text: 'hi' })}');`)
}

d('applyOpencodeSessionModel', () => {
  let dir = ''
  let db = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-apply-model-'))
    db = join(dir, 'opencode.db')
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('reproduces the false success: the v1 writer finds nothing in a v2 store', async () => {
    // What the retarget used to read as "nothing to rewrite, -m applies on launch" — on a version
    // whose TUI rejects -m outright.
    schemaV2(db)
    await expect(setOpencodeSessionModel(db, SID, NEW)).resolves.toMatchObject({ ok: false, code: 'OPENCODE_SESSION_NOT_FOUND' })
  })

  it('on v2 refuses, rather than reporting success, when the model could not be switched', async () => {
    schemaV2(db)
    const failing: OpencodeApiRun = async () => { throw exitError('', 'connect ECONNREFUSED') }
    await expect(applyOpencodeSessionModel({ opencodeMajor: 2, dbPath: db, sessionId: SID, model: NEW }, { run: failing }))
      .resolves.toMatchObject({ ok: false, code: 'OPENCODE_MODEL_SWITCH_FAILED' })
  })

  it('on v2 switches through the API and leaves the store to opencode', async () => {
    schemaV2(db)
    const { run: api, calls } = fakeApi()
    await expect(applyOpencodeSessionModel({ opencodeMajor: 2, dbPath: db, sessionId: SID, model: NEW, cwd: '/w' }, { run: api }))
      .resolves.toEqual({ ok: true })
    expect(calls.map((args) => args[1])).toEqual(['session.switchModel', 'session.get'])
    expect(JSON.parse(run(db, `SELECT model FROM session_v2 WHERE id = '${SID}';`).trim())).toEqual({ id: OLD.modelID, providerID: OLD.providerID })
  })

  it('on v1 keeps its meaning: a session with no user message yet takes -m on launch', async () => {
    schema(db)
    insertSession(db, SID, null)
    const { run: api, calls } = fakeApi()
    await expect(applyOpencodeSessionModel({ opencodeMajor: 1, dbPath: db, sessionId: SID, model: NEW }, { run: api }))
      .resolves.toEqual({ ok: true })
    expect(calls).toEqual([])
  })

  it('on v1 writes a `#variant` id as it always did — no API, no variant split', async () => {
    schema(db)
    seed(db)
    const { run: api, calls } = fakeApi()
    const withVariant = { ...NEW, modelID: `${NEW.modelID}#high` }
    await expect(applyOpencodeSessionModel({ opencodeMajor: 1, dbPath: db, sessionId: SID, model: withVariant, checkCatalog: true }, { run: api }))
      .resolves.toEqual({ ok: true })
    expect(calls).toEqual([])
    expect(sessionModel(db, SID)).toEqual({ id: withVariant.modelID, providerID: NEW.providerID, variant: 'default' })
  })

  it('on v1 still refuses a write that failed', async () => {
    await expect(applyOpencodeSessionModel({ opencodeMajor: 1, dbPath: join(dir, 'missing', 'opencode.db'), sessionId: SID, model: NEW }))
      .resolves.toMatchObject({ ok: false, code: 'OPENCODE_DB_WRITE_FAILED' })
  })
})
