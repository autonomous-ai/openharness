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
 *
 * ## v2
 *
 * Everything above is 1.x. OpenCode 2.0 keeps its sessions in `session_v2` / `session_message` (the
 * v1 tables are still there, and empty for every new session — so the SQL above finds nothing and
 * answers `OPENCODE_SESSION_NOT_FOUND`, which the retarget used to read as fine), its TUI has no
 * `-m`, and one background service owns the store. It also ships a writer: the service's
 * `session.switchModel` operation, reachable as `opencode api session.switchModel`. Measured on
 * 2.0.18 against a scratch session: the row's model changed, a `model-switched` message was
 * appended, a TUI attached to the session switched live, and `opencode -s <id>` (with or without
 * `--standalone`) reopened on the new model. So on v2 this goes through the API and never touches
 * the DB — [switchOpencodeSessionModel]. The service accepts a model it does not know without
 * complaint, so success is read back with `session.get` rather than assumed.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { opencodeBin } from '../../lib/engineBin.js'
import { isOpencodeV2 } from './version.js'

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
      code:
        | 'OPENCODE_SQLITE_MISSING'
        | 'OPENCODE_SESSION_NOT_FOUND'
        | 'OPENCODE_DB_WRITE_FAILED'
        | 'OPENCODE_MISSING'
        | 'OPENCODE_MODEL_SWITCH_FAILED'
        | 'OPENCODE_MODEL_UNKNOWN'
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
  return id ? parseOpencodeModelId(id) : null
}

/** A `provider/model` id split the way opencode splits it, or null when it names no provider. */
export function parseOpencodeModelId(id: string): OpencodeSessionModel | null {
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

/** Runs `opencode <args>`; resolves with stdout, rejects the way `execFile` does. A seam for specs. */
export type OpencodeApiRun = (args: string[], options: { cwd?: string }) => Promise<{ stdout: string }>

const runOpencode: OpencodeApiRun = async (args, options) => {
  // Bounded like the sqlite3 write: the service answers in well under a second (77ms measured).
  const { stdout } = await execFileAsync(opencodeBin(), args, {
    ...(options.cwd ? { cwd: options.cwd } : {}), timeout: 15_000, killSignal: 'SIGKILL',
  })
  return { stdout }
}

/** What a failed `opencode api` call said: the body is on stdout, the HTTP status on stderr. */
function apiFailure(err: unknown): { missing: boolean; text: string } {
  const error = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
  if (error?.code === 'ENOENT') return { missing: true, text: String(error.message ?? err) }
  const text = [error?.stdout, error?.stderr].map((part) => String(part ?? '').trim()).filter(Boolean).join(' · ')
  return { missing: false, text: text || String(error?.message ?? err) }
}

/**
 * Put `sessionId` on `model` through OpenCode v2's own API — see "v2" in the header.
 *
 * Talks to the background service (`opencode api` with no `--standalone`), which owns the store.
 * Proved on 2.0.18 that a session last opened by a `--standalone` pane is switched just the same,
 * and that the next pane reads it from the store whichever server it runs on. Never touches the DB.
 *
 * Measured on 2.0.18 that the service stores any id (`opencode/does-not-exist` reads back as set),
 * so with `checkCatalog` the model is looked for in `model.list` first — for a model of opencode's
 * own; a grid's provider is declared in its pane's own config, which the service never reads. A
 * switch that did not land is tried once more, after `retryDelayMs`; one that cannot (no such
 * session, no opencode, an unknown model) is not.
 */
export async function switchOpencodeSessionModel(
  sessionId: string,
  model: OpencodeSessionModel,
  options: { cwd?: string; run?: OpencodeApiRun; checkCatalog?: boolean; retryDelayMs?: number } = {},
): Promise<SetOpencodeSessionModelResult> {
  if (!ID_RE.test(sessionId)) {
    return { ok: false, code: 'OPENCODE_SESSION_NOT_FOUND', detail: `not an opencode session id: ${sessionId}` }
  }
  const run = options.run ?? runOpencode
  if (options.checkCatalog) {
    const known = await listsModel(run, model, options.cwd)
    if (known === false) {
      return { ok: false, code: 'OPENCODE_MODEL_UNKNOWN', detail: `opencode has no ${model.providerID}/${model.modelID} — \`opencode models\` lists the ones it has` }
    }
  }
  let result = await switchOnce(run, sessionId, model, options.cwd)
  if (!result.ok && result.code === 'OPENCODE_MODEL_SWITCH_FAILED') {
    console.warn(`[opencode] switch to ${model.providerID}/${model.modelID} did not land (${result.detail}) · trying once more`)
    await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 1_000))
    result = await switchOnce(run, sessionId, model, options.cwd)
  }
  return result
}

/**
 * A v2 model id and the effort it names: `model#high` is opencode's own way (`opencode run -m
 * provider/model#variant`). v1 never splits it — its `-m` and its rewrite take the id as written.
 */
function splitVariant(modelID: string): { id: string; variant?: string } {
  const at = modelID.lastIndexOf('#')
  return at > 0 && at < modelID.length - 1 ? { id: modelID.slice(0, at), variant: modelID.slice(at + 1) } : { id: modelID }
}

/** Whether the service's `model.list` has [model]; null when the list could not be read. */
async function listsModel(run: OpencodeApiRun, model: OpencodeSessionModel, cwd?: string): Promise<boolean | null> {
  try {
    const { stdout } = await run(['api', 'model.list'], { cwd })
    const parsed = JSON.parse(stdout) as { data?: unknown } | unknown[]
    const rows = (Array.isArray(parsed) ? parsed : (parsed as { data?: unknown }).data) as Array<{ id?: unknown; modelID?: unknown; providerID?: unknown }> | undefined
    if (!Array.isArray(rows)) return null
    const { id } = splitVariant(model.modelID)
    return rows.some((m) => m.providerID === model.providerID && (m.id === id || m.modelID === id))
  } catch {
    return null
  }
}

/** One switch through the service, read back. */
async function switchOnce(run: OpencodeApiRun, sessionId: string, model: OpencodeSessionModel, cwd?: string): Promise<SetOpencodeSessionModelResult> {
  const options = { cwd }
  const param = `sessionID=${sessionId}`
  const { id, variant } = splitVariant(model.modelID)
  const body = JSON.stringify({ model: { id, providerID: model.providerID, ...(variant ? { variant } : {}) } })
  try {
    await run(['api', 'session.switchModel', '--param', param, '-d', body], { cwd: options.cwd })
  } catch (err) {
    const failure = apiFailure(err)
    if (failure.missing) return { ok: false, code: 'OPENCODE_MISSING', detail: `opencode not found: ${failure.text}` }
    const code = /SessionNotFoundError|HTTP 404/.test(failure.text) ? 'OPENCODE_SESSION_NOT_FOUND' : 'OPENCODE_MODEL_SWITCH_FAILED'
    return { ok: false, code, detail: failure.text }
  }
  // Read back: the service answers 204 for any model, known or not, so only the session itself can
  // say the switch landed.
  let stdout: string
  try {
    ({ stdout } = await run(['api', 'session.get', '--param', param], { cwd: options.cwd }))
  } catch (err) {
    return { ok: false, code: 'OPENCODE_MODEL_SWITCH_FAILED', detail: `could not read the session back · ${apiFailure(err).text}` }
  }
  let now: { id?: unknown; providerID?: unknown; variant?: unknown } | undefined
  try {
    now = (JSON.parse(stdout) as { data?: { model?: { id?: unknown; providerID?: unknown; variant?: unknown } } }).data?.model
  } catch {
    now = undefined
  }
  // (A variant asked for must read back too; none asked for, the service's own is fine.)
  if (now?.id !== id || now?.providerID !== model.providerID || (variant && now?.variant !== variant)) {
    const seen = now ? `${String(now.providerID)}/${String(now.id)}${now.variant ? `#${String(now.variant)}` : ''}` : stdout.trim().slice(0, 200)
    return { ok: false, code: 'OPENCODE_MODEL_SWITCH_FAILED', detail: `session ${sessionId} is still on ${seen}` }
  }
  console.log(`[opencode] session model switched to ${model.providerID}/${model.modelID} through the service`)
  return { ok: true }
}

/**
 * Put a resumed session on `model` the way the installed OpenCode needs, BEFORE its pane is
 * relaunched. A failure here is the caller's refusal: the live process has not been touched yet.
 *
 *  * v1 (or a version not read): the SQL rewrite above. A session with no user message yet is fine
 *    there — the relaunch's `-m` applies to it — so that one answer is success.
 *  * v2: the API. Every failure is a failure, `SESSION_NOT_FOUND` included: the relaunch carries no
 *    `-m`, so a switch that did not land is a pane on the old model with the move reported done.
 */
export async function applyOpencodeSessionModel(
  input: { opencodeMajor: number | null | undefined; dbPath: string; sessionId: string; model: OpencodeSessionModel; cwd?: string; checkCatalog?: boolean },
  deps: { run?: OpencodeApiRun; retryDelayMs?: number } = {},
): Promise<SetOpencodeSessionModelResult> {
  if (isOpencodeV2(input.opencodeMajor)) {
    return switchOpencodeSessionModel(input.sessionId, input.model, { cwd: input.cwd, run: deps.run, checkCatalog: input.checkCatalog, retryDelayMs: deps.retryDelayMs })
  }
  const written = await setOpencodeSessionModel(input.dbPath, input.sessionId, input.model)
  return !written.ok && written.code === 'OPENCODE_SESSION_NOT_FOUND' ? { ok: true } : written
}
