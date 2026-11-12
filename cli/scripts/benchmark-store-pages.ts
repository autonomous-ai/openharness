/** The store readers' pages (#4188), on synthetic stores in a temporary folder. Never a real store, never the daemon.
 * Run: node --import tsx scripts/benchmark-store-pages.ts [--src <the cli/src of a tree>] [output.json]
 * `--src` (default: this tree's) is where every module and fixture is loaded from, so the same script measures the base.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const at = args.indexOf('--src')
const src = resolve(at >= 0 ? args.splice(at, 2)[1] : join(import.meta.dirname, '../src'))
const output = args[0]
const load = (path: string): Promise<unknown> => import(pathToFileURL(join(src, path)).href)

const builtin = await load('lib/sqliteBuiltin.ts') as typeof import('../src/lib/sqliteBuiltin.js')
const thread = await load('lib/sqliteThread.ts') as typeof import('../src/lib/sqliteThread.js')
const openclaw = await load('engines/openclaw/reader.ts') as typeof import('../src/engines/openclaw/reader.js')
const opencode = await load('engines/opencode/reader.ts') as typeof import('../src/engines/opencode/reader.js')
// The binding through `builtinSqlite`, which filters its ExperimentalWarning as the daemon does.
const binding = builtin.builtinSqlite()
if (!binding) throw new Error('this benchmark needs node:sqlite (Node 24)')
const Database = binding

const KIB = 1024
const MIB = 1024 * KIB
const OPENCLAW_KEY = 'agent:main:plain'
const OPENCODE_SESSION = 'ses_bench0001'

/** Every `all()` on the caller's thread, its rows weighed as the read threads weigh a reply (lib/sqliteThread.ts). */
const seen = { reads: 0, largestReplyBytes: 0 }
class CountingDatabase extends Database {
  prepare(sql: string): ReturnType<InstanceType<typeof Database>['prepare']> {
    const statement = super.prepare(sql)
    return {
      all: (...params) => {
        const rows = statement.all(...params)
        let bytes = 0
        for (const row of rows) {
          for (const column in row) {
            const value = row[column]
            bytes += column.length + (typeof value === 'string' ? Buffer.byteLength(value)
              : value instanceof Uint8Array ? value.byteLength : 8)
          }
        }
        seen.reads++
        seen.largestReplyBytes = Math.max(seen.largestReplyBytes, bytes)
        return rows
      },
    }
  }
}

/** OpenClaw's recorded `plain` scenario, then 4,000 more rows on its window: 2 MiB on every 100th, 2 KiB on the rest. */
function buildOpenclaw(path: string): void {
  const db = new Database(path, { readOnly: false })
  try {
    const fixtures = join(src, 'engines/openclaw/__fixtures__')
    db.exec(readFileSync(join(fixtures, 'schema.sql'), 'utf8'))
    db.exec(readFileSync(join(fixtures, 'plain.sql'), 'utf8'))
    const window = String(db.prepare('SELECT current_session_id AS id FROM session_nodes WHERE session_key = ?').all(OPENCLAW_KEY)[0]?.id)
    const event = db.prepare('INSERT INTO transcript_events (session_id, seq, event_json, created_at, event_utf8_bytes, navigation_type, message_role) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const active = db.prepare('INSERT INTO session_transcript_active_events (session_id, active_position, event_seq, message_position, context_eligible) VALUES (?, ?, ?, NULL, 1)')
    db.exec('BEGIN')
    for (let seq = 8; seq <= 4007; seq++) {
      const content = 'a'.repeat(seq % 100 === 0 ? 2 * MIB : 2 * KIB)
      const json = JSON.stringify({ type: 'message', id: `b-${seq}`, message: { role: 'user', content } })
      event.all(window, seq, json, 1794299459000 + seq, Buffer.byteLength(json), 'message', 'user')
      active.all(window, 1000 + seq, seq)
    }
    db.exec('COMMIT')
  } finally { db.close() }
}

/** An OpenCode 1 store (opencode 1.18.31's DDL, lib/sessionSearch/externals/opencode.spec.ts): 2,000 messages of
 *  10 parts of 2 KiB, one part of message 700 being 6 MiB, and an empty `session_message`, as a 1.x store has. */
function buildOpencode(path: string): void {
  const db = new Database(path, { readOnly: false })
  try {
    db.exec(`
CREATE TABLE \`message\` (
  \`id\` text PRIMARY KEY, \`session_id\` text NOT NULL, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL,
  \`data\` text NOT NULL
);
CREATE TABLE \`part\` (
  \`id\` text PRIMARY KEY, \`message_id\` text NOT NULL, \`session_id\` text NOT NULL, \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL, \`data\` text NOT NULL
);
CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);
CREATE INDEX \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);
CREATE TABLE \`session_message\` (
  \`id\` text PRIMARY KEY, \`session_id\` text NOT NULL, \`type\` text NOT NULL, \`seq\` integer NOT NULL,
  \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL, \`data\` text NOT NULL
);
CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);
CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);
`)
    const message = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
    const part = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
    const padded = (fields: Record<string, unknown>, bytes: number): string => {
      const json = JSON.stringify({ ...fields, pad: '' })
      return JSON.stringify({ ...fields, pad: 'm'.repeat(bytes - json.length) })
    }
    db.exec('BEGIN')
    for (let i = 0; i < 2000; i++) {
      const id = `msg_${String(i).padStart(6, '0')}`
      const at = 1794299459000 + i
      message.all(id, OPENCODE_SESSION, at, at, padded({ role: i % 2 ? 'assistant' : 'user' }, 600))
      for (let j = 0; j < 10; j++) {
        const bytes = i === 700 && j === 0 ? 6 * MIB : 2 * KIB
        part.all(`prt_${String(i).padStart(6, '0')}_${j}`, id, OPENCODE_SESSION, at, at, padded({ type: 'text', text: '' }, bytes))
      }
    }
    db.exec('COMMIT')
  } finally { db.close() }
}

const median = (samples: number[]): number => samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]
const mib = (bytes: number): string => `${(bytes / MIB).toFixed(1)} MiB`

/** One untimed run, then the median of 5. `count` is null when the read was refused. */
async function measure(read: () => Promise<number | null>): Promise<{ count: number | null; medianMs: number }> {
  const count = await read()
  const samples: number[] = []
  for (let i = 0; i < 5; i++) {
    const start = performance.now()
    await read()
    samples.push(performance.now() - start)
  }
  return { count, medianMs: median(samples) }
}

const stores = [
  { store: 'openclaw', unit: 'events', file: 'openclaw-agent.sqlite', build: buildOpenclaw,
    // OpenClaw throws on a refused page.
    read: async (db: string) => { try { return (await openclaw.readOpenclawHistory(db, OPENCLAW_KEY)).length } catch { return null } } },
  { store: 'opencode', unit: 'messages', file: 'opencode.db', build: buildOpencode,
    // OpenCode returns no message for a store that did not answer.
    read: async (db: string) => (await opencode.readOpencodeMessages(db, OPENCODE_SESSION)).length || null },
]

const root = mkdtempSync(join(tmpdir(), 'harness-store-pages-'))
const results: Record<string, unknown>[] = []
try {
  for (const { store, unit, file, build, read } of stores) {
    const db = join(root, file)
    build(db)

    builtin.overrideBuiltinSqlite(CountingDatabase)
    Object.assign(seen, { reads: 0, largestReplyBytes: 0 })
    await read(db)
    const { reads, largestReplyBytes } = seen
    const caller = await measure(() => read(db))
    builtin.closeSqliteHandles()
    builtin.overrideBuiltinSqlite(undefined)
    results.push({ store, path: 'caller', result: caller.count === null ? 'refused' : 'read', [unit]: caller.count,
      reads, largestReplyBytes, medianMs: caller.medianMs })
    console.log(`${store} caller: ${caller.count === null ? 'refused' : `read ${caller.count} ${unit}`} · ${reads} reads · ` +
      `largest reply ${mib(largestReplyBytes)} · median ${caller.medianMs.toFixed(1)} ms`)

    thread.enableOffThreadSqlite()
    const threads = await measure(() => read(db))
    await thread.resetOffThreadSqlite()
    builtin.closeSqliteHandles()
    results.push({ store, path: 'threads', result: threads.count === null ? 'refused' : 'read', [unit]: threads.count,
      medianMs: threads.medianMs })
    console.log(`${store} threads: ${threads.count === null ? 'refused' : `read ${threads.count} ${unit}`} · ` +
      `median ${threads.medianMs.toFixed(1)} ms`)
  }
  const memory = new Database(':memory:', { readOnly: false })
  const sqlite = String(memory.prepare('SELECT sqlite_version() AS v').all()[0]?.v)
  memory.close()
  const result = { kind: 'synthetic-store-pages', src, node: process.version, sqlite, platform: process.platform,
    arch: process.arch, results }
  if (output) writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
} finally {
  await thread.resetOffThreadSqlite()
  builtin.closeSqliteHandles()
  rmSync(root, { recursive: true, force: true })
}
