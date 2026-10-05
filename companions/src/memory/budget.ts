/** One durable allowance for extraction and derived notebook work. Caller owns the transaction. */
import { randomUUID } from 'node:crypto'
import type { Database } from './database.js'

export const MEMORY_CALL_WINDOW_MS = 3_600_000
export const MAX_MEMORY_CALLS = 6
export const MEMORY_CALL_PURPOSE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_inference_purpose (
    call_id TEXT PRIMARY KEY REFERENCES memory_inference_calls(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK(purpose IN ('extraction','notebook'))
  );
`

export function memoryCallAllowance(db: Database, now: number): { count: number; notebookCalls: number; retryAt: number | null } {
  const row = db.prepare(`SELECT COUNT(*) AS count, MIN(c.started_at) AS first,
    COALESCE(SUM(CASE WHEN p.purpose='notebook' THEN 1 ELSE 0 END),0) AS notebooks
    FROM memory_inference_calls c LEFT JOIN memory_inference_purpose p ON p.call_id=c.id
    WHERE c.started_at>?`).get(now - MEMORY_CALL_WINDOW_MS)!
  const count = Number(row.count)
  return { count, notebookCalls: Number(row.notebooks),
    retryAt: count >= MAX_MEMORY_CALLS ? Number(row.first) + MEMORY_CALL_WINDOW_MS + 1 : null }
}

export function reserveMemoryCall(db: Database, now: number, contextKey: string, purpose: 'extraction' | 'notebook'): string {
  const token = randomUUID()
  db.prepare('INSERT INTO memory_inference_calls(id,started_at,context_key) VALUES(?,?,?)').run(token, now, contextKey)
  db.prepare('INSERT INTO memory_inference_purpose(call_id,purpose) VALUES(?,?)').run(token, purpose)
  return token
}
