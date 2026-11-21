/** Read-only native history sizes, used only by the monitor's process. No deletion authority or write SQL. */
import { lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../../config/env.js'
import { hermesDbPath } from '../hermes/contract.js'
import { engineKeepsTranscriptFile } from '../transcriptBindings.js'
import { inspectNativeHistory } from '../../lib/purgeAgentService.js'
import { sqliteReadAll } from '../../lib/sqliteRead.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { SessionCheckpointStore } from '../../lib/sessionCheckpoint.js'

const fail = (message: string): never => { throw new Error(message) }
type File = { path: string; dev: bigint; ino: bigint; bytes: number }
const lit = (value: string) => "'" + value.replace(/'/g, "''") + "'"

function file(path: string): File {
  const info = lstatSync(path, { bigint: true })
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n
    || (process.getuid && info.uid !== BigInt(process.getuid()))) fail('The session data is not a private regular file. Size is unknown.')
  return { path: realpathSync(path), dev: info.dev, ino: info.ino,
    bytes: Number.isFinite(Number(info.blocks)) ? Number(info.blocks) * 512 : Number(info.size) }
}

async function databaseBytes(s: RegisteredSession): Promise<number> {
  let database: string, sessionTable: string, children: [string, string][]
  const id = lit(s.sessionId!)
  switch (s.engine) {
    case 'opencode': case 'kilo':
      database = s.engine === 'opencode' ? join(env.OPENCODE_DATA_DIR, 'opencode.db') : join(env.KILO_DATA_DIR, 'kilo.db')
      sessionTable = 'session'
      children = [['part', `message_id IN (SELECT id FROM message WHERE session_id = ${id})`], ['message', `session_id = ${id}`]]
      break
    case 'hermes':
      database = hermesDbPath(s.hermesHome ?? env.HERMES_HOME)
      sessionTable = 'sessions'; children = [['messages', `session_id = ${id}`]]
      break
    case 'devin':
      database = join(env.DEVIN_HOME, 'sessions.db')
      sessionTable = 'sessions'; children = [['message_nodes', `session_id = ${id}`]]
      break
    default: return fail('This engine has no native history size reader.')
  }
  file(database)
  const query = async (sql: string) => {
    const result = await sqliteReadAll(database, sql)
    if (!result.ok) return fail('The engine history could not be verified. Size is unknown.')
    return result.rows
  }
  if (s.engine === 'opencode' && (await query("SELECT name FROM sqlite_master WHERE type='table' AND name='session_v2'")).length
    && (await query(`SELECT id FROM session_v2 WHERE id = ${id}`)).length) {
    sessionTable = 'session_v2'
    // OpenCode 2 stores parts, attachment links and instructions beside messages. Shared blob bytes
    // belong to no single conversation, so only the links enter this read-only estimate.
    const present = new Set((await query("SELECT name FROM sqlite_master WHERE type='table'")).map(t => String(t.name)))
    children = ['session_part', 'blob_ref', 'session_message', 'instruction_entry', 'instruction_state', 'session_inbox', 'schedule']
      .filter(table => table === 'session_message' || present.has(table))
      .map(table => [table, `session_id = ${id}`])
  }
  await query(`SELECT id FROM ${sessionTable} WHERE id = ${id}`)
  // Keep the existing unknown result for stores whose dependencies prevent a reliable per-session estimate.
  const allowedTables = new Set([sessionTable, ...children.map(([table]) => table)])
  if ((await query("SELECT name, tbl_name FROM sqlite_master WHERE type='trigger'")).some(t => allowedTables.has(String(t.tbl_name)))) {
    return fail('This engine uses history triggers that Harness cannot safely verify. Size is unknown.')
  }
  for (const table of await query("SELECT name FROM sqlite_master WHERE type='table'")) {
    const name = String(table.name)
    if (allowedTables.has(name)) continue
    const references = await query(`PRAGMA foreign_key_list("${name.replace(/"/g, '""')}")`)
    if (references.some(r => allowedTables.has(String(r.table)))) {
      return fail('Other engine data references this conversation store. Size is unknown.')
    }
  }
  // Dependent conversations retain the existing unknown estimate.
  const columns = await query(`PRAGMA table_info(${sessionTable})`)
  const schemaVersion = Number((await query('PRAGMA schema_version'))[0]?.schema_version)
  if (!Number.isInteger(schemaVersion)) return fail('The engine history schema could not be verified.')
  for (const parent of ['parent_id', 'parent_session_id', 'fork_session_id']) if (columns.some(c => c.name === parent)) {
    const predicate = `${parent} = ${id} AND id <> ${id}`
    if ((await query(`SELECT id FROM ${sessionTable} WHERE ${predicate} LIMIT 1`)).length) {
      return fail('Other conversations depend on this session. Size is unknown.')
    }
  }
  // Unknown native schemas retain an unknown estimate.
  for (const [table, where] of children) await query(`SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`)
  let bytes = 0
  for (const [table, where] of [[sessionTable, `id = ${id}`], ...children]) {
    const fields = await query(`PRAGMA table_info(${table})`)
    const lengths = fields.map(c => `length(CAST(COALESCE("${String(c.name).replace(/"/g, '""')}", '') AS BLOB))`).join(' + ')
    const size = await query(`SELECT COALESCE(SUM(${lengths}), 0) AS bytes FROM ${table} WHERE ${where}`)
    bytes += Number(size[0]?.bytes ?? 0)
  }
  return bytes
}

export async function sessionDataBytes(s: RegisteredSession, checkpoints: SessionCheckpointStore): Promise<number | null> {
  try {
    const bytes = !s.sessionId || s.engine === 'terminal' || s.engine === 'openclaw' || engineKeepsTranscriptFile(s.engine)
      ? (await inspectNativeHistory(s)).bytes : await databaseBytes(s)
    if (bytes == null) return null
    const checkpointFiles = [s.sessionId, ...(s.earlierSessionIds ?? [])]
      .flatMap(sessionId => checkpoints.deletionFiles({ ...s, sessionId }))
    return bytes + checkpointFiles.reduce((n, path) => n + file(path).bytes, 0)
  } catch { return null }
}
