/**
 * How many background commands a Hermes session still runs (docs/plans/2026-11-12-background-count-design.md).
 *
 * Hermes keeps the list itself: `processes.json` in its home, rewritten on every background spawn and every exit
 * (`tools/process_registry.py` `_write_checkpoint`), holding only the processes still running. The file is trusted as
 * written: its pids are host pids Harness cannot check from inside a pid namespace (the reporter's sandbox), and after a
 * gateway crash Hermes adopts them back from this very file, so it is a better truth than a pid check.
 *
 * Every answer Harness cannot stand behind is `null`, never `0`: `0` would let a close end a harness whose commands
 * still run.
 */

import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { HERMES_HISTORY_ID_RE, hermesDbPath } from './contract.js'
import { sqliteReadAll } from '../../lib/sqliteRead.js'

export const HERMES_PROCESSES_MAX_BYTES = 1 << 20
export const HERMES_PROCESSES_MAX_ENTRIES = 1_024
export const HERMES_ANCESTORS_MAX = 32

/**
 * The session and the ones it was compressed from: Hermes carries a compressed conversation on under a new id whose
 * `parent_session_id` is the old one, and a process started before keeps the old id as its key. Bounded, so a parent
 * loop in the store ends.
 */
const CHAIN_SQL = `WITH RECURSIVE chain(id, depth) AS (
  SELECT id, 0 FROM sessions WHERE id = ?
  UNION ALL
  SELECT s.parent_session_id, chain.depth + 1 FROM sessions s JOIN chain ON s.id = chain.id
  WHERE s.parent_session_id IS NOT NULL AND chain.depth < ${HERMES_ANCESTORS_MAX}
)
SELECT id FROM chain;`

/** The file's text, or null when it is missing, unreadable or longer than the bound. */
async function readBounded(path: string): Promise<string | null> {
  let file
  try {
    file = await open(path, 'r')
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(HERMES_PROCESSES_MAX_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    return length > HERMES_PROCESSES_MAX_BYTES ? null : buffer.toString('utf8', 0, length)
  } catch {
    return null
  } finally {
    await file.close().catch(() => {})
  }
}

/** Each entry's session key, or null unless the list is the shape Hermes writes. */
function sessionKeys(text: string): string[] | null {
  let list: unknown
  try {
    list = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(list) || list.length > HERMES_PROCESSES_MAX_ENTRIES) return null
  const keys: string[] = []
  for (const item of list) {
    // An entry without the field is an older format whose processes cannot be tied to a session.
    if (typeof item !== 'object' || item === null || typeof (item as { session_key?: unknown }).session_key !== 'string') return null
    keys.push((item as { session_key: string }).session_key)
  }
  return keys
}

/**
 * The count for `sessionId` in `home`. No file is `null`, not `0`: Hermes writes it only at its first background
 * process (as `[]` once none run), so a missing file says nothing, and an older Hermes that never writes it can never
 * read a wrong `0`. Never throws.
 */
export async function hermesBackgroundCommands(home: string, sessionId: string): Promise<number | null> {
  if (!HERMES_HISTORY_ID_RE.test(sessionId)) return null
  const text = await readBounded(join(home, 'processes.json'))
  if (text === null) return null
  const keys = sessionKeys(text)
  if (keys === null) return null
  const read = await sqliteReadAll(hermesDbPath(home), CHAIN_SQL, [sessionId], { maxBuffer: 1 << 16 })
  if (!read.ok || read.rows.length === 0) return null
  const chain = new Set(read.rows.map((row) => row.id))
  // An empty key cannot be tied to a session.
  return keys.filter((key) => key !== '' && chain.has(key)).length
}
