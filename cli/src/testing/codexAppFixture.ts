/**
 * A Codex home as the ChatGPT app keeps it, for the reader's spec, its benchmark and the end-to-end test: the `threads`
 * table of `state_5.sqlite` (the subset of Codex 0.169.0's columns, with its constraints and recency index), the
 * sidebar's `.codex-global-state.json` and the thread names of `session_index.jsonl`. Always made in a temp folder or a
 * throwaway HOME, never in anyone's own `~/.codex`.
 */
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { builtinSqlite, type DatabaseLike } from '../lib/sqliteBuiltin.js'

/** Written to every row's title, name, first message and preview: a reader that lets any of them out shows it. */
export const NEVER_READ = 'NEVER-READ-7f3c'

export interface FixtureThread {
  id: string
  cwd: string
  source?: string
  archived?: 0 | 1
  recencyAtMs?: number
  updatedAtMs?: number | null
}

const SCHEMA = [
  'PRAGMA journal_mode = WAL',
  `CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, source TEXT NOT NULL, model_provider TEXT NOT NULL, cwd TEXT NOT NULL,
    title TEXT NOT NULL, sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0, first_user_message TEXT NOT NULL DEFAULT '', updated_at_ms INTEGER,
    preview TEXT NOT NULL DEFAULT '', recency_at_ms INTEGER NOT NULL DEFAULT 0, name TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_threads_recency_at_ms ON threads(recency_at_ms DESC, id DESC)',
]

const INSERT = `INSERT OR REPLACE INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
  sandbox_policy, approval_mode, archived, first_user_message, updated_at_ms, preview, recency_at_ms, name)
  VALUES (?, ?, 0, 0, ?, 'openai', ?, ?, 'workspace-write', 'on-request', ?, ?, ?, ?, ?, ?)`

const COLUMNS = { archived: 'archived', recencyAtMs: 'recency_at_ms', updatedAtMs: 'updated_at_ms' } as const

export interface CodexAppFixture {
  readonly home: string
  /** Makes the store (WAL) and its index when missing, writes the rows (INSERT OR REPLACE) and closes it. */
  threads(rows: readonly FixtureThread[]): void
  update(id: string, fields: Partial<Pick<FixtureThread, 'archived' | 'recencyAtMs' | 'updatedAtMs'>>): void
  /** The sidebar's file, padded with spaces to `padTo` bytes; a string is written as it is. */
  state(state: { projectOrder?: unknown; assignments?: unknown; padTo?: number } | string): void
  /** Appends Codex's name for a thread to `session_index.jsonl`. */
  name(id: string, threadName: string): void
  /** A connection held open, as the app's own writer is while it runs. */
  writer(): { exec(sql: string): void; close(): void }
}

export function codexAppFixture(home: string): CodexAppFixture {
  const store = join(home, 'state_5.sqlite')
  const statePath = join(home, '.codex-global-state.json')

  const open = (): DatabaseLike => {
    const Database = builtinSqlite()
    if (!Database) throw new Error('this Node has no node:sqlite to make the fixture with')
    mkdirSync(home, { recursive: true })
    return new Database(store, { readOnly: false })
  }
  const withStore = (work: (db: DatabaseLike) => void): void => {
    const db = open()
    try { work(db) } finally { db.close() }
  }

  return {
    home,
    threads(rows): void {
      withStore((db) => {
        for (const statement of SCHEMA) db.exec(statement)
        const insert = db.prepare(INSERT)
        for (const row of rows) {
          insert.all(row.id, `/rollouts/${row.id}.jsonl`, row.source ?? 'vscode', row.cwd, NEVER_READ, row.archived ?? 0,
            NEVER_READ, row.updatedAtMs ?? null, NEVER_READ, row.recencyAtMs ?? 0, NEVER_READ)
        }
      })
    },
    update(id, fields): void {
      const keys = Object.keys(fields) as Array<keyof typeof COLUMNS>
      if (keys.length === 0) return
      withStore((db) => {
        db.prepare(`UPDATE threads SET ${keys.map((key) => `${COLUMNS[key]} = ?`).join(', ')} WHERE id = ?`)
          .all(...keys.map((key) => fields[key] ?? null), id)
      })
    },
    // The app writes the file whole and renames it into place: a reader sees the old file or the new one.
    state(state): void {
      let text = typeof state === 'string'
        ? state
        : JSON.stringify({ 'project-order': state.projectOrder, 'thread-project-assignments': state.assignments })
      if (typeof state !== 'string' && state.padTo) text += ' '.repeat(Math.max(0, state.padTo - Buffer.byteLength(text)))
      mkdirSync(home, { recursive: true })
      const temp = `${statePath}.tmp`
      writeFileSync(temp, text)
      renameSync(temp, statePath)
    },
    name(id, threadName): void {
      mkdirSync(home, { recursive: true })
      appendFileSync(join(home, 'session_index.jsonl'), JSON.stringify({ id, thread_name: threadName }) + '\n')
    },
    writer() {
      const db = open()
      return { exec: (sql) => db.exec(sql), close: () => db.close() }
    },
  }
}
