import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtinSqlite, closeSqliteHandles, overrideBuiltinSqlite } from './sqliteBuiltin.js'
import { idleWalStore, inlineSqlParams, sqliteReadAll } from './sqliteRead.js'

const hasCli = (() => {
  try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()
const hasBuiltin = builtinSqlite() !== null

function run(db: string, sql: string): void {
  execFileSync('sqlite3', [db, sql], { stdio: ['ignore', 'ignore', 'inherit'] })
}

describe('inlineSqlParams', () => {
  it('quotes strings, doubles embedded quotes, passes numbers and NULL through', () => {
    expect(inlineSqlParams('SELECT ? , ?, ?, ?', ["it's", 42, 1.5, null]))
      .toBe("SELECT 'it''s' , 42, 1.5, NULL")
  })

  it('refuses a mismatch between placeholders and parameters either way', () => {
    expect(() => inlineSqlParams('SELECT ?, ?', ['a'])).toThrow(/more placeholders/)
    expect(() => inlineSqlParams('SELECT ?', ['a', 'b'])).toThrow(/more parameters/)
  })

  it("leaves a ? inside the SQL's own string literals alone", () => {
    expect(inlineSqlParams("SELECT json_extract(d, '$.why?') FROM t WHERE id = ? AND note = 'it''s ?'", [7]))
      .toBe("SELECT json_extract(d, '$.why?') FROM t WHERE id = 7 AND note = 'it''s ?'")
  })

  it('refuses what a literal cannot carry', () => {
    expect(() => inlineSqlParams('SELECT ?', ['a\0b'])).toThrow(/NUL/)
    expect(() => inlineSqlParams('SELECT ?', [Number.NaN])).toThrow(/non-finite/)
  })
})

// The CLI seeds the fixture store, so both paths need it; the built-in path additionally needs this
// Node to carry node:sqlite (the installers' Node does; CI's may not).
const withCli = hasCli ? describe : describe.skip

withCli('sqliteReadAll', () => {
  let dir = ''
  let db = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sqlite-read-'))
    db = join(dir, 'store.db')
    run(db, 'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);'
      + "INSERT INTO message VALUES ('m1','ses_a',1,'{\"role\":\"user\"}');"
      + "INSERT INTO message VALUES ('m2','ses_a',2,'{\"role\":\"assistant\"}');"
      + "INSERT INTO message VALUES ('m3','ses_b',3,'{\"role\":\"user\"}');")
  })
  afterEach(() => {
    closeSqliteHandles()
    overrideBuiltinSqlite(undefined)
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  const paths: Array<['builtin' | 'cli', () => void]> = [
    ['cli', () => overrideBuiltinSqlite(null)],
    ...(hasBuiltin ? [['builtin', () => overrideBuiltinSqlite(undefined)] as ['builtin', () => void]] : []),
  ]
  const withBuiltin = hasBuiltin ? it : it.skip

  withBuiltin('applies each caller deadline to a cached native handle', async () => {
    overrideBuiltinSqlite(undefined)
    for (const busyTimeoutMs of [250, 7, 250]) {
      expect(await sqliteReadAll(db, 'PRAGMA busy_timeout;', [], { busyTimeoutMs })).toEqual({
        ok: true, via: 'builtin', rows: [{ timeout: busyTimeoutMs }],
      })
    }
  })

  for (const [via, select] of paths) {
    describe(`via ${via}`, () => {
      beforeEach(select)

      it('binds parameters in order and returns rows as plain objects', async () => {
        const result = await sqliteReadAll(db,
          'SELECT id, time_created AS tc, data FROM message WHERE session_id = ? AND time_created > ? ORDER BY id;',
          ['ses_a', 1])
        expect(result).toEqual({ ok: true, via, rows: [{ id: 'm2', tc: 2, data: '{"role":"assistant"}' }] })
      })

      it('returns no rows, not an error, for an unknown session', async () => {
        const result = await sqliteReadAll(db, 'SELECT id FROM message WHERE session_id = ?;', ['nope'])
        expect(result).toEqual({ ok: true, via, rows: [] })
      })

      // A value with a quote in it must reach SQLite as data. The readers validate ids with a regex
      // before this, but the repair path passes directory names straight through.
      it('carries a quote inside a parameter as data', async () => {
        run(db, "INSERT INTO message VALUES ('m4','it''s',4,'{}');")
        const result = await sqliteReadAll(db, 'SELECT id FROM message WHERE session_id = ?;', ["it's"])
        expect(result).toEqual({ ok: true, via, rows: [{ id: 'm4' }] })
      })

      // The row that hung the sqlite3 CLI for good on one machine was ~7.5 MB. Whatever path is in use,
      // a row that size must come back whole, and quickly — this is the regression that blocked the app.
      it('reads a multi-megabyte row whole', async () => {
        const big = 'x'.repeat(8 * 1024 * 1024)
        writeFileSync(join(dir, 'big.sql'), `INSERT INTO message VALUES ('m5','ses_big',5,'${big}');`)
        execFileSync('sh', ['-c', `sqlite3 "${db}" < "${join(dir, 'big.sql')}"`])
        const started = Date.now()
        const result = await sqliteReadAll(db, 'SELECT data FROM message WHERE session_id = ?;', ['ses_big'])
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect((result.rows[0].data as string).length).toBe(big.length)
        expect(Date.now() - started).toBeLessThan(5_000)
      })

      // An engine's idle store must come back exactly as it was: no -wal or -shm made beside it (they
      // would be the daemon's, in the engine's folder, and a held handle keeps the engine from tidying).
      it('reads an idle WAL store without creating anything beside it, and a live one live', async () => {
        run(db, 'PRAGMA journal_mode=WAL;')
        expect(existsSync(`${db}-wal`)).toBe(false)
        expect(idleWalStore(db)).toBe(true)
        const idle = await sqliteReadAll(db, 'SELECT count(*) AS n FROM message;', [])
        expect(idle).toEqual({ ok: true, via, rows: [{ n: 3 }] })
        expect(existsSync(`${db}-wal`)).toBe(false)
        expect(existsSync(`${db}-shm`)).toBe(false)
        if (!hasBuiltin) return
        // Its engine opens it and writes: the next read is live, and sees the new row.
        // The engine's own connection, whichever way this test reads.
        type Writer = { exec(sql: string): void; close(): void }
        const sqlite = (process as unknown as { getBuiltinModule(id: string): { DatabaseSync: new (path: string) => Writer } })
          .getBuiltinModule('node:sqlite')
        const writer = new sqlite.DatabaseSync(db)
        try {
          writer.exec("INSERT INTO message VALUES ('m9','ses_c',9,'{}')")
          expect(existsSync(`${db}-wal`)).toBe(true)
          expect(idleWalStore(db)).toBe(false)
          expect(await sqliteReadAll(db, 'SELECT count(*) AS n FROM message;', [])).toEqual({ ok: true, via, rows: [{ n: 4 }] })
        } finally {
          writer.close()
        }
      })

      withBuiltin('sees a WAL write that finishes between reads, without leaving sidecars', async () => {
        run(db, 'PRAGMA journal_mode=WAL;')
        const query = "SELECT time_created AS time FROM message WHERE id = 'm1';"
        expect(await sqliteReadAll(db, query)).toEqual({ ok: true, via, rows: [{ time: 1 }] })
        expect(await sqliteReadAll(db, query)).toEqual({ ok: true, via, rows: [{ time: 1 }] })
        // The engine starts, updates an existing row, checkpoints, and closes before the next poll.
        // There is no WAL left to tell a cached immutable reader that its snapshot is stale.
        type Writer = { exec(sql: string): void; close(): void }
        const sqlite = (process as unknown as { getBuiltinModule(id: string): { DatabaseSync: new (path: string) => Writer } })
          .getBuiltinModule('node:sqlite')
        const writer = new sqlite.DatabaseSync(db)
        try {
          writer.exec("UPDATE message SET time_created = 9 WHERE id = 'm1'")
        } finally {
          writer.close()
        }
        expect(existsSync(`${db}-wal`)).toBe(false)
        expect(existsSync(`${db}-shm`)).toBe(false)
        expect(await sqliteReadAll(db, query)).toEqual({ ok: true, via, rows: [{ time: 9 }] })
        expect(existsSync(`${db}-wal`)).toBe(false)
        expect(existsSync(`${db}-shm`)).toBe(false)
      })

      it('reports a missing store as transient, and creates nothing', async () => {
        const result = await sqliteReadAll(join(dir, 'absent.db'), 'SELECT 1;', [])
        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.reason).toBe('transient')
        expect(() => execFileSync('ls', [join(dir, 'absent.db')], { stdio: 'ignore' })).toThrow()
      })
    })
  }

  // The handle is cached per path for the pollers' sake; a store rebuilt under the same name must
  // not keep answering from the file that was there before.
  withBuiltin('follows a store replaced on disk', async () => {
    overrideBuiltinSqlite(undefined)
    const first = await sqliteReadAll(db, 'SELECT count(*) AS n FROM message;', [])
    expect(first).toEqual({ ok: true, via: 'builtin', rows: [{ n: 3 }] })
    const fresh = join(dir, 'fresh.db')
    run(fresh, "CREATE TABLE message (id TEXT PRIMARY KEY); INSERT INTO message VALUES ('only');")
    renameSync(fresh, db)
    const second = await sqliteReadAll(db, 'SELECT count(*) AS n FROM message;', [])
    expect(second).toEqual({ ok: true, via: 'builtin', rows: [{ n: 1 }] })
  })

  it('never reads a store in the older journal mode, or no store, as idle', () => {
    expect(idleWalStore(db)).toBe(false)
    expect(idleWalStore(join(dir, 'absent.db'))).toBe(false)
    writeFileSync(join(dir, 'short.db'), 'tiny')
    expect(idleWalStore(join(dir, 'short.db'))).toBe(false)
  })

  it('reports missing when neither reader exists', async () => {
    overrideBuiltinSqlite(null)
    const realPath = process.env.PATH
    const empty = mkdtempSync(join(tmpdir(), 'no-sqlite-'))
    process.env.PATH = empty
    try {
      const result = await sqliteReadAll(db, 'SELECT 1;', [])
      expect(result).toMatchObject({ ok: false, reason: 'missing' })
    } finally {
      process.env.PATH = realPath
      rmSync(empty, { recursive: true, force: true })
    }
  })

  // The bound that was missing: a CLI that never answers used to hold its caller forever.
  it('gives up on a CLI that hangs', async () => {
    overrideBuiltinSqlite(null)
    const realPath = process.env.PATH
    const shim = mkdtempSync(join(tmpdir(), 'slow-sqlite-'))
    // `exec`, so the SIGKILL lands on the sleep itself rather than orphaning it under a dead shell.
    writeFileSync(join(shim, 'sqlite3'), '#!/bin/sh\nexec sleep 30\n')
    chmodSync(join(shim, 'sqlite3'), 0o755)
    process.env.PATH = shim
    try {
      const started = Date.now()
      const result = await sqliteReadAll(db, 'SELECT 1;', [], { cliTimeoutMs: 300 })
      expect(result).toMatchObject({ ok: false, reason: 'transient' })
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      process.env.PATH = realPath
      rmSync(shim, { recursive: true, force: true })
    }
  })
})
