import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtinSqlite, closeSqliteHandles } from './sqliteBuiltin.js'
import { sqliteReadAll } from './sqliteRead.js'
import { enableOffThreadSqlite, failSqliteThreadsForTest, offThreadSqliteActive, resetOffThreadSqlite, sqliteThreadsForTest } from './sqliteThread.js'

// A read the store answers slowly, as a whole Devin session on a 36 GB store did (#1906): counting to ? in SQL.
const SLOW = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c'

const withBuiltin = builtinSqlite() ? describe : describe.skip

withBuiltin('SQLite reads off the core\'s thread', () => {
  let dir = ''
  let db = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sqlite-thread-'))
    db = join(dir, 'store.db')
    const Database = builtinSqlite()!
    const store = new Database(db, { readOnly: false })
    store.exec("CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT); INSERT INTO message VALUES ('m1', 'one'), ('m2', 'two');")
    store.close()
    enableOffThreadSqlite()
  })
  afterEach(async () => {
    await resetOffThreadSqlite()
    closeSqliteHandles()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  // #1906: a read on the core's own thread held it for the whole query, the master missed its heartbeats and killed it.
  it('keeps the caller\'s loop turning while a slow read runs', async () => {
    let turned = false
    setImmediate(() => { turned = true })
    const read = await sqliteReadAll(db, SLOW, [3_000_000])
    expect(read).toEqual({ ok: true, rows: [{ n: 3_000_000 }], via: 'builtin' })
    expect(turned).toBe(true)
  })

  // Slow enough to pass a 20 ms deadline, short enough to end soon after: a thread cannot be stopped mid-query, so the
  // reset after this test waits for it (50M counted for over 10 s on CI and timed the reset out).
  it('answers a read past its deadline as transient, and the read after it as ever', async () => {
    const late = await sqliteReadAll(db, SLOW, [3_000_000], { timeoutMs: 20 })
    expect(late).toMatchObject({ ok: false, reason: 'transient' })
    expect((late as { error: Error }).error.message).toMatch(/deadline/)
    expect(await sqliteReadAll(db, 'SELECT id FROM message ORDER BY id')).toEqual({ ok: true, rows: [{ id: 'm1' }, { id: 'm2' }], via: 'builtin' })
  })

  // A poller asks again every second: a read that outlasts its deadline was started again each time, and the same heavy
  // query ran on every core (#1906, eight sqlite3 children at 639%).
  it('runs an identical read once while it is still in flight', async () => {
    const [first, second] = await Promise.all([sqliteReadAll(db, SLOW, [1_000_000]), sqliteReadAll(db, SLOW, [1_000_000])])
    expect(first).toEqual({ ok: true, rows: [{ n: 1_000_000 }], via: 'builtin' })
    // One answer, handed to both: the same rows, not two copies.
    expect((second as { rows: unknown }).rows).toBe((first as { rows: unknown }).rows)
    const third = await sqliteReadAll(db, SLOW, [1_000_000])
    expect((third as { rows: unknown }).rows).not.toBe((first as { rows: unknown }).rows)
  })

  it('runs at most two reads at once, and the rest in turn', async () => {
    const reads = [1, 2, 3, 4, 5].map(n => sqliteReadAll(db, SLOW, [500_000 + n]))
    expect(sqliteThreadsForTest()).toBeLessThanOrEqual(2)
    expect((await Promise.all(reads)).map(read => read.ok ? read.rows[0].n : read.reason))
      .toEqual([500_001, 500_002, 500_003, 500_004, 500_005])
    expect(sqliteThreadsForTest()).toBeLessThanOrEqual(2)
  })

  it('refuses rows past the reply\'s limit, as the CLI\'s buffer does', async () => {
    const read = await sqliteReadAll(db, 'SELECT id, data FROM message', [], { maxBuffer: 16 })
    expect(read).toMatchObject({ ok: false, reason: 'transient' })
    expect((read as { error: Error }).error.message).toMatch(/limit/)
  })

  // A blob counts its own bytes: as JSON, a zstd row's Uint8Array is an object with a key per byte, five times its size.
  it('measures a blob by its bytes', async () => {
    const Database = builtinSqlite()!
    const store = new Database(db, { readOnly: false })
    store.exec("CREATE TABLE blob (data BLOB); INSERT INTO blob VALUES (zeroblob(1000))")
    store.close()
    const read = await sqliteReadAll(db, 'SELECT data FROM blob', [], { maxBuffer: 2_000 })
    expect(read.ok && (read.rows[0].data as Uint8Array).byteLength).toBe(1000)
  })

  // Harper's review of #4069: a thread that throws as it loads failed every read with nothing said, and was started again
  // for every poll.
  it('says why a read thread failed, by name only, and reads on the caller\'s thread after two in a minute', async () => {
    const said = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      failSqliteThreadsForTest()
      const query = 'SELECT data FROM message WHERE id = ?'
      expect(await sqliteReadAll(db, query, ['m1'])).toMatchObject({ ok: false, reason: 'transient' })
      expect(offThreadSqliteActive()).toBe(true)
      expect(await sqliteReadAll(db, query, ['m1'])).toMatchObject({ ok: false, reason: 'transient' })
      expect(said.mock.calls).toEqual([
        ['[sqlite] a read thread failed: TypeError'],
        ['[sqlite] a read thread failed: TypeError'],
        ['[sqlite] the read threads exited twice within a minute; SQLite reads run on the core thread from now on'],
      ])
      expect(offThreadSqliteActive()).toBe(false)
      expect(await sqliteReadAll(db, query, ['m1'])).toEqual({ ok: true, rows: [{ data: 'one' }], via: 'builtin' })
      expect(sqliteThreadsForTest()).toBe(0)
      expect(said.mock.calls.flat().join(' ')).not.toContain(db)
    } finally {
      said.mockRestore()
    }
  })

  it('reads a store that is not there as transient, and binds parameters as the thread does', async () => {
    expect(await sqliteReadAll(join(dir, 'absent.db'), 'SELECT 1')).toMatchObject({ ok: false, reason: 'transient' })
    expect(await sqliteReadAll(db, 'SELECT data FROM message WHERE id = ?', ['m2'])).toEqual({ ok: true, rows: [{ data: 'two' }], via: 'builtin' })
  })

  // A sandboxed agent's store may be a FIFO: a thread that opened it would wait for a writer for good, and two such
  // reads would hold both threads, and every store's read behind them.
  it.runIf(process.platform !== 'win32')('answers a FIFO store at once and keeps its threads free', async () => {
    const fifo = join(dir, 'fifo.db')
    execFileSync('mkfifo', [fifo])
    for (const sql of ['SELECT 1 AS one', 'SELECT 2 AS two']) {
      const read = await sqliteReadAll(fifo, sql, [], { timeoutMs: 2_000 })
      expect(read).toMatchObject({ ok: false, reason: 'transient' })
      expect((read as { error: Error }).error.message).toMatch(/not a regular file/)
    }
    expect(await sqliteReadAll(db, 'SELECT data FROM message WHERE id = ?', ['m1'])).toEqual({ ok: true, rows: [{ data: 'one' }], via: 'builtin' })
  })
})
