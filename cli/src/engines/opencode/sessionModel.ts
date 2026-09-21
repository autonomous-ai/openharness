/**
 * Put a RESUMED opencode session on a model, by writing what its own picker writes.
 *
 * ## Why a session launched with `-m` needs this at all
 *
 * When `opencode --session <id>` loads, the TUI sets its current model from the LAST USER MESSAGE's
 * `data.model` (`{providerID, modelID, variant?}` — `packages/tui/src/component/prompt/index.tsx`,
 * v1.18.31), which overrides `-m`; the server's prompt path falls back to the `session.model` column
 * (`{"id","providerID","variant":"default"}`). Nothing else — config `model`, `model.json`, `--fork`
 * — changes a resumed session's model (upstream: anomalyco/opencode #26901, #26351, #45204). So a
 * retarget that respawns with `--session` lands the right provider, key and argv on a pane that then
 * answers on the OLD model, and only the engine's own footer says so.
 *
 * The picker is the only writer opencode ships, and what it writes is those two rows. This writes the
 * same two rows, through SQL, in one transaction, before the respawn — so the TUI opens already on
 * the model, with nothing typed into it and no dependence on the picker's layout.
 *
 * ## Access
 *
 * The `sqlite3` CLI, exactly as `reader.ts` reads this DB: same binary, same `ENOENT` → "sqlite3
 * missing", no native dependency. opencode opens the DB in WAL mode with its own `busy_timeout 5000`,
 * so a concurrent UPDATE from here is safe; `PRAGMA busy_timeout` on this side covers a write that
 * lands during its checkpoint. ⚠️ Never copy, replace or delete the DB or its `-wal` / `-shm` files:
 * other opencode processes have them open, and that is how this DB was damaged during research.
 *
 * ## Rows
 *
 * Only the session's latest user message and its `session` row. Assistant messages, older user
 * messages, `event` rows and every other session are left alone. A session with no user message yet
 * has nothing to rewrite — and does not need it: with no message to restore from, the TUI takes `-m`
 * on the respawn. That case is reported as `OPENCODE_SESSION_NOT_FOUND` and the caller proceeds.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/** Same shape `reader.ts` accepts — an opencode session id is `ses_` + base62. */
const ID_RE = /^[A-Za-z0-9_]+$/

export interface OpencodeSessionModel {
  /** opencode's provider key, e.g. `opencode` or a grid's `gridProviderId(networkName)`. */
  providerID: string
  /** The model id under that provider, e.g. `big-pickle` or `Qwen3.6-35B-A3B`. */
  modelID: string
}

export type SetOpencodeSessionModelResult =
  | { ok: true }
  | {
      ok: false
      code: 'OPENCODE_SQLITE_MISSING' | 'OPENCODE_SESSION_NOT_FOUND' | 'OPENCODE_DB_WRITE_FAILED'
      detail: string
    }

/** A SQL string literal — the only way a value reaches the statement. */
function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * The `provider/model` an opencode argv names, split the way opencode splits it: the provider is
 * everything before the FIRST slash, the model is the rest (`vibe/minimax/minimax-m3` → `vibe` +
 * `minimax/minimax-m3`). Reads the LAST `-m`/`--model`, which is the one opencode honours.
 * Null when the argv names no model — then there is nothing to write and the engine decides.
 */
export function opencodeModelFromArgv(args: readonly string[]): OpencodeSessionModel | null {
  let id: string | null = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if ((arg === '-m' || arg === '--model') && i + 1 < args.length) { id = args[i + 1]; i++ }
    else if (arg.startsWith('--model=')) id = arg.slice('--model='.length)
  }
  if (!id) return null
  const slash = id.indexOf('/')
  if (slash <= 0 || slash === id.length - 1) return null
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) }
}

/**
 * Rewrite `sessionId`'s model in `dbPath` so that resuming it opens on `model`.
 *
 * One transaction: both rows or neither. Refuses without writing when `sqlite3` is absent, when the
 * id is not an opencode session id, or when the session has no user message yet (see the header).
 */
export async function setOpencodeSessionModel(
  dbPath: string,
  sessionId: string,
  model: OpencodeSessionModel,
): Promise<SetOpencodeSessionModelResult> {
  if (!ID_RE.test(sessionId)) {
    return { ok: false, code: 'OPENCODE_SESSION_NOT_FOUND', detail: `not an opencode session id: ${sessionId}` }
  }
  if (!model.providerID || !model.modelID) {
    return { ok: false, code: 'OPENCODE_DB_WRITE_FAILED', detail: 'refusing to write an empty provider or model id' }
  }
  const sid = lit(sessionId)
  const provider = lit(model.providerID)
  const modelId = lit(model.modelID)
  // The user-message guard is repeated on the session UPDATE so a session with no user message is
  // touched by neither statement: the transaction then commits with nothing changed, which is how
  // "no user message yet" is told apart from a failed write. `changes()` after each UPDATE is the
  // only stdout this reads.
  const hasUser =
    `EXISTS (SELECT 1 FROM message WHERE session_id = ${sid} AND json_extract(data, '$.role') = 'user')`
  const sql = [
    'PRAGMA busy_timeout = 5000;',
    'BEGIN IMMEDIATE;',
    `UPDATE message SET data = json_set(data, '$.model.providerID', ${provider}, '$.model.modelID', ${modelId}) ` +
      `WHERE id = (SELECT id FROM message WHERE session_id = ${sid} AND json_extract(data, '$.role') = 'user' ` +
      'ORDER BY time_created DESC LIMIT 1);',
    'SELECT changes();',
    `UPDATE session SET model = json_object('id', ${modelId}, 'providerID', ${provider}, 'variant', 'default') ` +
      `WHERE id = ${sid} AND ${hasUser};`,
    'SELECT changes();',
    'COMMIT;',
  ].join('\n')

  let stdout: string
  try {
    // `-bail` stops at the first failing statement; the shell then exits with the transaction still
    // open, and SQLite rolls it back on close — so a failing second UPDATE leaves the first unapplied.
    // Bounded: a CLI that never answers used to hold this `agent_create` open for good. The write
    // itself waits at most `busy_timeout` (5s, above) for opencode's lock, so 15s is generous.
    ({ stdout } = await execFileAsync('sqlite3', ['-batch', '-bail', dbPath, sql], { timeout: 15_000, killSignal: 'SIGKILL' }))
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { stderr?: string }
    if (error?.code === 'ENOENT') {
      return { ok: false, code: 'OPENCODE_SQLITE_MISSING', detail: 'sqlite3 CLI not found on PATH' }
    }
    const stderr = String(error?.stderr ?? '').trim()
    return { ok: false, code: 'OPENCODE_DB_WRITE_FAILED', detail: stderr || String(error?.message ?? err) }
  }
  const lines = stdout.trim().split('\n').map((line) => line.trim()).filter(Boolean)
  // Lines: the pragma's echo, then the two change counts.
  const messages = Number(lines[lines.length - 2])
  const sessions = Number(lines[lines.length - 1])
  if (!Number.isFinite(messages) || !Number.isFinite(sessions)) {
    return { ok: false, code: 'OPENCODE_DB_WRITE_FAILED', detail: `unexpected sqlite3 output: ${stdout.trim().slice(0, 200)}` }
  }
  if (messages === 0) {
    return {
      ok: false,
      code: 'OPENCODE_SESSION_NOT_FOUND',
      detail: `session ${sessionId} has no user message yet — nothing to rewrite; -m applies on launch`,
    }
  }
  console.log(
    `[opencode] session model set to ${model.providerID}/${model.modelID} · ` +
    `${messages} message row, ${sessions} session row`,
  )
  return { ok: true }
}
