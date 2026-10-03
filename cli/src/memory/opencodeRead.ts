/** Bounded, read-only access to one host-bound OpenCode session. Never loads the live UI's clipped text. */
import { z } from 'zod'
import { sqliteReadAll, type SqliteParam } from '../lib/sqliteRead.js'
import { MemoryError } from './types.js'
import type { OpenCodeSourceMessage } from './opencodeSource.js'

const time = z.number().int().nonnegative()
const nativeId = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_]+$/)
const sessionSchema = z.object({ parent_id: z.string().max(200).nullable(), directory: z.string().min(1).max(4096),
  version: z.literal('1.18.34'), time_created: time, revert: z.string().max(2048).nullable() })
const messageSchema = z.object({ id: nativeId, created: time, updated: time, data: z.string().max(64000).nullable(),
  parts: z.array(z.object({ id: nativeId, created: time, updated: time, data: z.string().max(64000).nullable() })).max(65),
  hasReply: z.boolean(), hasLaterUser: z.boolean(), afterOverflow: z.boolean() })

async function query(path: string, sql: string, params: SqliteParam[]) {
  const result = await sqliteReadAll(path, sql, params, { maxBuffer: 768 * 1024, cliTimeoutMs: 1000 })
  if (!result.ok) throw new MemoryError('source_unavailable')
  return result.rows
}

export async function readOpenCodeMemorySession(path: string, id: string) {
  const [row] = await query(path, `SELECT parent_id,substr(directory,1,4097) AS directory,
    substr(version,1,32) AS version,time_created,substr(revert,1,2049) AS revert FROM session WHERE id=?`, [id])
  const parsed = sessionSchema.safeParse(row)
  if (!parsed.success) throw new MemoryError('native_source_unsupported')
  return parsed.data
}

// Bound both row count and JSON bytes in SQL. sqliteReadAll's in-process path has no stdout cap.
// One huge tool result gets a null marker; it cannot consume the budget of subsequent small parts.
// On the recorded 1.18.34 overflow path, a successful automatic compaction writes a new user
// message by copying the request. It has fresh IDs/timestamps and no synthetic flag. Identify
// that first post-compaction user record from native causal metadata, never text equality.
// This also works when capture starts after the original request or restarts at the boundary.
const parts = `previous_user AS (
  SELECT previous.* FROM message previous
  WHERE previous.session_id=(SELECT session_id FROM candidate)
    AND (SELECT CASE WHEN json_valid(data) THEN json_extract(data,'$.role') END FROM candidate)='user'
    AND (previous.time_created,previous.id)<(SELECT time_created,id FROM candidate)
    AND CASE WHEN json_valid(previous.data) THEN json_extract(previous.data,'$.role') END='user'
  ORDER BY previous.time_created DESC,previous.id DESC LIMIT 1
), selected_parts AS (
  SELECT id,time_created,time_updated,CASE WHEN length(CAST(data AS BLOB))<=64000 THEN data END AS data
  FROM part WHERE session_id=? AND message_id=(SELECT id FROM candidate)
  ORDER BY time_created,id LIMIT 65
), weighted_parts AS (
  SELECT *,SUM(COALESCE(length(CAST(data AS BLOB)),0)) OVER (ORDER BY time_created,id) AS bytes FROM selected_parts
)
SELECT m.id,m.time_created AS created,m.time_updated AS updated,
  CASE WHEN length(CAST(m.data AS BLOB))<=64000 THEN m.data END AS data,
  (SELECT json_group_array(json_object('id',id,'created',time_created,'updated',time_updated,
    'data',CASE WHEN bytes<=96000 THEN data END)) FROM weighted_parts) AS parts,
  EXISTS(SELECT 1 FROM message reply WHERE reply.session_id=m.session_id AND reply.time_created>=m.time_created
    AND CASE WHEN json_valid(reply.data) THEN json_extract(reply.data,'$.parentID') END=m.id) AS has_reply,
  EXISTS(SELECT 1 FROM message later WHERE later.session_id=m.session_id
    AND (later.time_created>m.time_created OR (later.time_created=m.time_created AND later.id>m.id))
    AND CASE WHEN json_valid(later.data) THEN json_extract(later.data,'$.role') END='user') AS has_later_user,
  EXISTS(SELECT 1 FROM previous_user boundary WHERE
    EXISTS(SELECT 1 FROM part p WHERE p.session_id=m.session_id AND p.message_id=boundary.id
      AND CASE WHEN length(CAST(p.data AS BLOB))<=64000 AND json_valid(p.data) THEN
        json_extract(p.data,'$.type')='compaction' AND json_extract(p.data,'$.auto')=1 AND json_extract(p.data,'$.overflow')=1 END)
    AND EXISTS(SELECT 1 FROM message summary WHERE summary.session_id=m.session_id
      AND summary.time_created>=boundary.time_created AND summary.time_created<=m.time_created
      AND CASE WHEN json_valid(summary.data) THEN json_extract(summary.data,'$.role')='assistant'
        AND json_extract(summary.data,'$.parentID')=boundary.id AND json_extract(summary.data,'$.summary')=1
        AND json_extract(summary.data,'$.finish')='stop' AND json_extract(summary.data,'$.error') IS NULL
        AND json_type(summary.data,'$.time.completed')='integer'
        AND json_extract(summary.data,'$.time.completed')<=json_extract(m.data,'$.time.created') END)) AS after_overflow
FROM candidate m`

/** Cursor order is native SQL insertion time plus ID; evidence time is the separate native message timestamp. */
export async function readOpenCodeMemoryMessage(path: string, sessionId: string,
  after: { t: number; m: string } | { id: string }): Promise<OpenCodeSourceMessage | null> {
  const exact = 'id' in after
  const rows = await query(path, `WITH candidate AS (SELECT * FROM message WHERE session_id=? AND
    ${exact ? 'id=?' : '(time_created>? OR (time_created=? AND id>?))'} ORDER BY time_created,id LIMIT 1), ${parts}`,
  [sessionId, ...(exact ? [after.id] : [after.t, after.t, after.m]), sessionId])
  if (!rows.length) return null
  const row = rows[0]
  const parsed = messageSchema.safeParse({ ...row, parts: JSON.parse(String(row.parts)),
    hasReply: row.has_reply === 1, hasLaterUser: row.has_later_user === 1, afterOverflow: row.after_overflow === 1 })
  if (!parsed.success) throw new MemoryError('native_source_unsupported')
  return { ...parsed.data, sessionId }
}

export async function openCodeMemoryTail(path: string, sessionId: string): Promise<{ t: number; m: string }> {
  const [row] = await query(path, 'SELECT time_created AS t,id AS m FROM message WHERE session_id=? ORDER BY time_created DESC,id DESC LIMIT 1', [sessionId])
  if (!row) return { t: 0, m: '' }
  const parsed = z.object({ t: time, m: nativeId }).safeParse(row)
  if (!parsed.success) throw new MemoryError('native_source_unsupported')
  return parsed.data
}
