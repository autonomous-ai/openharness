/**
 * The core's SQLite reads, on threads of their own (#1906).
 *
 * `node:sqlite` is synchronous: a read holds the thread that runs it for the whole query. On the core's main thread, one
 * Devin session read in full from a 36 GB store held it past the master's heartbeats, and the master killed the core
 * again and again until it parked it. The `sqlite3` CLI (Node without the binding, or `--no-experimental-sqlite`) kept
 * the core answering, but a read past its 5 s limit was asked again a second later, and the same heavy query ran on
 * every core: eight sqlite3 children at 639% of one core.
 *
 * So, here:
 * - **Off the main thread**: at most [THREADS] read threads, each one read at a time, started on the first read.
 * - **Coalesced**: a read the same as one still running (store, statement, parameters, limits) waits for that one and
 *   is handed its answer, so a poller that asks again while a read is still running starts nothing new.
 * - **Deadline**: a caller hears `transient` at its deadline. `node:sqlite` cannot interrupt a query: it finishes on its
 *   thread, never on the core's, and a caller that asks the same again joins it.
 * - **Bounded**: at most [MAX_WAITING] reads wait for a thread; past that a read is `transient` at once. A reply past
 *   `maxBuffer` is `transient`, as the CLI's stdout limit is.
 *
 * The rows of one read are handed to every caller that joined it: they are read, never changed (no reader does).
 * Only the core turns this on (`enableOffThreadSqlite`, core/main.ts); every other process, and every unit test, reads
 * on its own thread as before, as lib/offThreadExec.ts does for the core's probes.
 */
import { Worker } from 'node:worker_threads'
import { NATIVE_READER } from './sqliteBuiltin.js'
import type { SqliteParam, SqliteReadResult, SqliteRow } from './sqliteRead.js'

/** Two: one heavy read (a whole session) leaves a thread for every other poll. */
const THREADS = 2
const MAX_WAITING = 64

// CommonJS, evaluated in the thread: the bundle carries it as a string, with no file of its own. The binding's
// ExperimentalWarning is filtered here as on the main thread (sqliteBuiltin.ts `builtinSqlite`).
const threadSource = (): string => failingForTest ? 'throw new TypeError()' : `
const { parentPort } = require('node:worker_threads')
const previous = process.listeners('warning')
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return
  for (const listener of previous) listener.call(process, warning)
})
const reader = (function (fs, url, Database) {${NATIVE_READER}})(require('node:fs'), require('node:url'), process.getBuiltinModule('node:sqlite').DatabaseSync)
parentPort.on('message', ({ id, dbPath, sql, params, busyTimeoutMs, maxBuffer }) => {
  const read = reader.read(dbPath, sql, params, busyTimeoutMs)
  if (!read.ok) {
    parentPort.postMessage({ id, ok: false, message: String((read.error && read.error.message) || read.error) })
    return
  }
  // What the rows carry: a text's UTF-8 bytes, a blob's own length (a zstd row, as OpenClaw keeps them), 8 for a number.
  let bytes = 0
  for (const row of read.rows) {
    for (const column in row) {
      const value = row[column]
      bytes += column.length + (typeof value === 'string' ? Buffer.byteLength(value) : value && value.byteLength !== undefined ? value.byteLength : 8)
    }
  }
  parentPort.postMessage(bytes > maxBuffer
    ? { id, ok: false, message: 'the rows exceed the reply limit of ' + maxBuffer + ' bytes' }
    : { id, ok: true, rows: read.rows })
})
`

type Answer = { ok: true; rows: SqliteRow[] } | { ok: false; message: string }
interface Read {
  id: number
  dbPath: string; sql: string; params: SqliteParam[]; busyTimeoutMs: number; maxBuffer: number
  answer(answer: Answer): void
}
interface Thread { worker: Worker; read: Read | null }

/** Two exits this close together turn the route off for the rest of the process, as lib/offThreadExec.ts does. */
const DEATH_WINDOW_MS = 60_000

let enabled = false
let fallen = false
let failingForTest = false
const deaths: number[] = []
let nextId = 0
const threads: Thread[] = []
const waiting: Read[] = []
/** Reads still running or waiting, by what they ask: a caller asking the same joins one. */
const running = new Map<string, Promise<Answer>>()

export function enableOffThreadSqlite(): void {
  enabled = true
}

export function offThreadSqliteActive(): boolean {
  return enabled && !fallen
}

/** Test seam: every read thread started from now on throws as it loads. */
export function failSqliteThreadsForTest(): void {
  failingForTest = true
}

/** Test seam: how many read threads there are. */
export function sqliteThreadsForTest(): number {
  return threads.length
}

/** Test seam: the route off, every thread gone, every waiting read answered. */
export async function resetOffThreadSqlite(): Promise<void> {
  enabled = false
  fallen = false
  failingForTest = false
  deaths.length = 0
  const stopping = threads.splice(0)
  for (const read of waiting.splice(0)) read.answer({ ok: false, message: 'the SQLite read threads were reset' })
  for (const thread of stopping) thread.read?.answer({ ok: false, message: 'the SQLite read threads were reset' })
  running.clear()
  await Promise.all(stopping.map(thread => thread.worker.terminate()))
}

const transient = (message: string): SqliteReadResult => ({ ok: false, reason: 'transient', error: new Error(message) })

export function readOffThread(dbPath: string, sql: string, params: SqliteParam[], busyTimeoutMs: number,
  timeoutMs: number, maxBuffer: number): Promise<SqliteReadResult> {
  const key = JSON.stringify([dbPath, sql, params, busyTimeoutMs, maxBuffer])
  let answer = running.get(key)
  if (!answer) {
    if (waiting.length >= MAX_WAITING) return Promise.resolve(transient(`${MAX_WAITING} SQLite reads are already waiting`))
    const asked = new Promise<Answer>((resolve) => {
      waiting.push({ id: nextId++, dbPath, sql, params, busyTimeoutMs, maxBuffer, answer: resolve })
    })
    answer = asked
    running.set(key, asked)
    void asked.then(() => { if (running.get(key) === asked) running.delete(key) })
    dispatch()
  }
  const settled = answer
  return new Promise((resolve) => {
    // The main thread is never held by a read, so its own timer is on time.
    const timer = setTimeout(() => resolve(transient(`the SQLite read passed its deadline of ${timeoutMs} ms`)), timeoutMs)
    void settled.then((done) => {
      clearTimeout(timer)
      resolve(done.ok ? { ok: true, rows: done.rows, via: 'builtin' } : transient(done.message))
    })
  })
}

/** Hand waiting reads to free threads, starting one while there are fewer than [THREADS]. */
function dispatch(): void {
  while (waiting.length && !fallen) {
    const thread = threads.find(candidate => !candidate.read) ?? (threads.length < THREADS ? start() : null)
    if (!thread) return
    const read = waiting.shift()!
    thread.read = read
    // A read in flight holds the process open, as a child process would; an idle thread never does.
    thread.worker.ref()
    const { id, dbPath, sql, params, busyTimeoutMs, maxBuffer } = read
    thread.worker.postMessage({ id, dbPath, sql, params, busyTimeoutMs, maxBuffer })
  }
}

function start(): Thread {
  const thread: Thread = { worker: new Worker(threadSource(), { eval: true }), read: null }
  thread.worker.on('message', (reply: Answer & { id: number }) => {
    const read = thread.read
    if (!read || read.id !== reply.id) return
    thread.read = null
    thread.worker.unref()
    read.answer(reply.ok ? { ok: true, rows: reply.rows } : { ok: false, message: reply.message })
    dispatch()
  })
  // An uncaught error ends the thread; `exit` follows and answers its read. Its name only: a message can quote a path.
  thread.worker.on('error', (error) => { console.warn(`[sqlite] a read thread failed: ${error.name}`) })
  thread.worker.once('exit', () => {
    const at = threads.indexOf(thread)
    if (at < 0) return
    threads.splice(at, 1)
    thread.read?.answer({ ok: false, message: 'the SQLite read thread exited' })
    // A thread that cannot load would otherwise be started again for every poll, and every read would fail (Harper's
    // review of #4069). Twice in a minute, the core reads on its own thread again, as it did before the read threads.
    const now = Date.now()
    deaths.push(now)
    while (deaths.length && now - deaths[0] > DEATH_WINDOW_MS) deaths.shift()
    if (deaths.length >= 2 && !fallen) {
      fallen = true
      console.warn('[sqlite] the read threads exited twice within a minute; SQLite reads run on the core thread from now on')
      for (const read of waiting.splice(0)) read.answer({ ok: false, message: 'the SQLite read threads are off' })
      return
    }
    dispatch()
  })
  thread.worker.unref()
  threads.push(thread)
  return thread
}
