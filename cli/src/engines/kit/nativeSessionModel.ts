/** Native launch writes from an engine's declared SQLite transaction or CLI API protocol.
 * Optional history readers never own these operations. Compatibility extraction first;
 * cancellation and uncertain-write corrections are tracked in the OpenCode control research note. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export interface NativeSessionModel { providerID: string; modelID: string }
export type NativeModelResult = { ok: true } | { ok: false; code: string; detail: string }
export type NativeApiRun = (args: string[], options: { cwd?: string }) => Promise<{ stdout: string }>
export interface NativeModelRule {
  label: string; serviceMajor: number; id: RegExp; modelFlags: readonly string[]; modelEquals: string; variantSeparator: string
  errors: { sqliteMissing: string; sessionMissing: string; writeFailed: string; binaryMissing: string; switchFailed: string; unknownModel: string }
  sqlite: { args: readonly string[]; timeoutMs: number; statements: readonly string[] }
  api: { timeoutMs: number; retryDelayMs: number; list: readonly string[]; switch: readonly string[]; get: readonly string[];
    paramFlag: string; sessionParam: string; bodyFlag: string; missingSession: RegExp;
    fields: { data: string; model: string; id: string; alternativeId: string; provider: string; variant: string } }
}
const execFileAsync = promisify(execFile)

export function createSessionModelControl(rule: NativeModelRule, binary: () => string) {
  const ID_RE = rule.id
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
  function modelFromArgv(args: readonly string[]): NativeSessionModel | null {
    let id: string | null = null
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (rule.modelFlags.includes(arg) && i + 1 < args.length) { id = args[i + 1]; i++ }
      else if (arg.startsWith(rule.modelEquals)) id = arg.slice(rule.modelEquals.length)
    }
    return id ? parseModelId(id) : null
  }

  /** A `provider/model` id split the way opencode splits it, or null when it names no provider. */
  function parseModelId(id: string): NativeSessionModel | null {
    const slash = id.indexOf('/')
    if (slash <= 0 || slash === id.length - 1) return null
    return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) }
  }

  /**
   * Rewrite `sessionId`'s model in `dbPath` so that resuming it opens on `model`.
   *
   * One transaction: both rows or neither. Refuses without writing when `sqlite3` is absent, when the
   * id is not an opencode session id, or when the session has no user message yet (the declared transaction guards it).
   */
  async function setSessionModel(
    dbPath: string,
    sessionId: string,
    model: NativeSessionModel,
  ): Promise<NativeModelResult> {
    if (!ID_RE.test(sessionId)) {
      return { ok: false, code: rule.errors.sessionMissing, detail: `not an ${rule.label} session id: ${sessionId}` }
    }
    if (!model.providerID || !model.modelID) {
      return { ok: false, code: rule.errors.writeFailed, detail: 'refusing to write an empty provider or model id' }
    }
    const values: Record<string, string> = { session: lit(sessionId), provider: lit(model.providerID), model: lit(model.modelID) }
    const sql = rule.sqlite.statements.join('\n').replace(/\{\{(session|provider|model)\}\}/g, (_token, key: string) => values[key]!)

    let stdout: string
    try {
      // `-bail` stops at the first failing statement; the shell then exits with the transaction still
      // open, and SQLite rolls it back on close — so a failing second UPDATE leaves the first unapplied.
      // Bounded: a CLI that never answers used to hold this `agent_create` open for good. The write
      // itself waits at most `busy_timeout` (5s, above) for opencode's lock, so 15s is generous.
      ({ stdout } = await execFileAsync('sqlite3', [...rule.sqlite.args, dbPath, sql], { timeout: rule.sqlite.timeoutMs, killSignal: 'SIGKILL' }))
    } catch (err) {
      const error = err as NodeJS.ErrnoException & { stderr?: string }
      if (error?.code === 'ENOENT') {
        return { ok: false, code: rule.errors.sqliteMissing, detail: 'sqlite3 CLI not found on PATH' }
      }
      const stderr = String(error?.stderr ?? '').trim()
      return { ok: false, code: rule.errors.writeFailed, detail: stderr || String(error?.message ?? err) }
    }
    const lines = stdout.trim().split('\n').map((line) => line.trim()).filter(Boolean)
    // Lines: the pragma's echo, then the two change counts.
    const messages = Number(lines[lines.length - 2])
    const sessions = Number(lines[lines.length - 1])
    if (!Number.isFinite(messages) || !Number.isFinite(sessions)) {
      return { ok: false, code: rule.errors.writeFailed, detail: `unexpected sqlite3 output: ${stdout.trim().slice(0, 200)}` }
    }
    if (messages === 0) {
      return {
        ok: false,
        code: rule.errors.sessionMissing,
        detail: `session ${sessionId} has no user message yet — nothing to rewrite; -m applies on launch`,
      }
    }
    console.log(
      `[${rule.label}] session model set to ${model.providerID}/${model.modelID} · ` +
      `${messages} message row, ${sessions} session row`,
    )
    return { ok: true }
  }

  const runNative: NativeApiRun = async (args, options) => {
    // Bounded like the sqlite3 write: the service answers in well under a second (77ms measured).
    const { stdout } = await execFileAsync(binary(), args, {
      ...(options.cwd ? { cwd: options.cwd } : {}), timeout: rule.api.timeoutMs, killSignal: 'SIGKILL',
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
   * Put `sessionId` on `model` through the engine's declared native API.
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
  async function switchSessionModel(
    sessionId: string,
    model: NativeSessionModel,
    options: { cwd?: string; run?: NativeApiRun; checkCatalog?: boolean; retryDelayMs?: number } = {},
  ): Promise<NativeModelResult> {
    if (!ID_RE.test(sessionId)) {
      return { ok: false, code: rule.errors.sessionMissing, detail: `not an ${rule.label} session id: ${sessionId}` }
    }
    const run = options.run ?? runNative
    if (options.checkCatalog) {
      const known = await listsModel(run, model, options.cwd)
      if (known === false) {
        return { ok: false, code: rule.errors.unknownModel, detail: `${rule.label} has no ${model.providerID}/${model.modelID} — \`${rule.label} models\` lists the ones it has` }
      }
    }
    let result = await switchOnce(run, sessionId, model, options.cwd)
    if (!result.ok && result.code === rule.errors.switchFailed) {
      console.warn(`[${rule.label}] switch to ${model.providerID}/${model.modelID} did not land (${result.detail}) · trying once more`)
      await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? rule.api.retryDelayMs))
      result = await switchOnce(run, sessionId, model, options.cwd)
    }
    return result
  }

  /**
   * A v2 model id and the effort it names: `model#high` is opencode's own way (`opencode run -m
   * provider/model#variant`). v1 never splits it — its `-m` and its rewrite take the id as written.
   */
  function splitVariant(modelID: string): { id: string; variant?: string } {
    const at = modelID.lastIndexOf(rule.variantSeparator)
    return at > 0 && at < modelID.length - rule.variantSeparator.length ? { id: modelID.slice(0, at), variant: modelID.slice(at + rule.variantSeparator.length) } : { id: modelID }
  }

  /** Whether the service's `model.list` has [model]; null when the list could not be read. */
  async function listsModel(run: NativeApiRun, model: NativeSessionModel, cwd?: string): Promise<boolean | null> {
    try {
      const { stdout } = await run([...rule.api.list], { cwd })
      const parsed = JSON.parse(stdout) as Record<string, unknown> | unknown[]
      const fields = rule.api.fields
      const rows = (Array.isArray(parsed) ? parsed : parsed[fields.data]) as Array<Record<string, unknown>> | undefined
      if (!Array.isArray(rows)) return null
      const { id } = splitVariant(model.modelID)
      return rows.some((m) => m[fields.provider] === model.providerID && (m[fields.id] === id || m[fields.alternativeId] === id))
    } catch {
      return null
    }
  }

  /** One switch through the service, read back. */
  async function switchOnce(run: NativeApiRun, sessionId: string, model: NativeSessionModel, cwd?: string): Promise<NativeModelResult> {
    const options = { cwd }
    const param = `${rule.api.sessionParam}=${sessionId}`
    const { id, variant } = splitVariant(model.modelID)
    const fields = rule.api.fields
    const body = JSON.stringify({ [fields.model]: { [fields.id]: id, [fields.provider]: model.providerID, ...(variant ? { [fields.variant]: variant } : {}) } })
    try {
      await run([...rule.api.switch, rule.api.paramFlag, param, rule.api.bodyFlag, body], { cwd: options.cwd })
    } catch (err) {
      const failure = apiFailure(err)
      if (failure.missing) return { ok: false, code: rule.errors.binaryMissing, detail: `${rule.label} not found: ${failure.text}` }
      const code = rule.api.missingSession.test(failure.text) ? rule.errors.sessionMissing : rule.errors.switchFailed
      return { ok: false, code, detail: failure.text }
    }
    // Read back: the service answers 204 for any model, known or not, so only the session itself can
    // say the switch landed.
    let stdout: string
    try {
      ({ stdout } = await run([...rule.api.get, rule.api.paramFlag, param], { cwd: options.cwd }))
    } catch (err) {
      return { ok: false, code: rule.errors.switchFailed, detail: `could not read the session back · ${apiFailure(err).text}` }
    }
    let now: Record<string, unknown> | undefined
    try {
      now = (JSON.parse(stdout) as Record<string, Record<string, Record<string, unknown>>>)[fields.data]?.[fields.model]
    } catch {
      now = undefined
    }
    // (A variant asked for must read back too; none asked for, the service's own is fine.)
    if (now?.[fields.id] !== id || now?.[fields.provider] !== model.providerID || (variant && now?.[fields.variant] !== variant)) {
      const seen = now ? `${String(now[fields.provider])}/${String(now[fields.id])}${now[fields.variant] ? `#${String(now[fields.variant])}` : ''}` : stdout.trim().slice(0, 200)
      return { ok: false, code: rule.errors.switchFailed, detail: `session ${sessionId} is still on ${seen}` }
    }
    console.log(`[${rule.label}] session model switched to ${model.providerID}/${model.modelID} through the service`)
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
  async function applySessionModel(
    input: { major: number | null | undefined; dbPath: string; sessionId: string; model: NativeSessionModel; cwd?: string; checkCatalog?: boolean },
    deps: { run?: NativeApiRun; retryDelayMs?: number } = {},
  ): Promise<NativeModelResult> {
    if ((input.major ?? 0) >= rule.serviceMajor) {
      return switchSessionModel(input.sessionId, input.model, { cwd: input.cwd, run: deps.run, checkCatalog: input.checkCatalog, retryDelayMs: deps.retryDelayMs })
    }
    const written = await setSessionModel(input.dbPath, input.sessionId, input.model)
    return !written.ok && written.code === rule.errors.sessionMissing ? { ok: true } : written
  }

  return { modelFromArgv, parseModelId, setSessionModel, switchSessionModel, applySessionModel }
}
