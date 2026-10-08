/** Permanent, individually reviewed deletion. Project folders are never deletion targets. */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, lstatSync, realpathSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { env } from '../config/env.js'
import { hermesDbPath } from '../engines/hermes/home.js'
import { engineKeepsTranscriptFile, validTranscriptPath, type RegisteredSession } from './registry.js'
import { sqliteReadAll } from './sqliteRead.js'
import type { StoppedAgentStore } from './stoppedAgents.js'
import type { SessionCheckpointStore } from './sessionCheckpoint.js'
import type { StopAgentOptions } from './stopAgentService.js'
import { inspectWorkspace, inspectWorktree, removeReviewedWorktree, type WorktreeReview } from './worktreeDeletion.js'

const exec = promisify(execFile)
const identity = (s: RegisteredSession) => JSON.stringify([s.agentId, s.engine, s.sessionId,
  s.registeredAt, s.cwd, s.codexHome, s.hermesHome, s.transcriptPath, s.processIdentity])
const conversation = (s: RegisteredSession) => JSON.stringify([s.engine, s.codexHome, s.hermesHome, s.sessionId])
const fail = (message: string): never => { throw new Error(message) }
type File = { path: string; dev: number; ino: number; bytes: number }
type History = { file?: File; missingFile?: string; database?: string; databaseFile?: File; statements?: string[]; bytes: number | null }
const lit = (value: string) => "'" + value.replace(/'/g, "''") + "'"

function file(path: string): File {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || (process.getuid && info.uid !== process.getuid())) fail('The session data is not a private regular file. Nothing was deleted.')
  return { path: realpathSync(path), dev: info.dev, ino: info.ino, bytes: Number.isFinite(info.blocks) ? info.blocks * 512 : info.size }
}

/** Known native history layouts only. A shared database is never removed or vacuumed. */
export async function inspectNativeHistory(s: RegisteredSession): Promise<History> {
  if (!s.sessionId || s.engine === 'terminal') return { bytes: 0 }
  if (engineKeepsTranscriptFile(s.engine)) {
    const path = s.transcriptPath
    if (!path || !validTranscriptPath(s.engine, path, s.codexHome ?? undefined, true)) {
      return fail('The conversation file could not be verified. Refresh before deleting this harness.')
    }
    const name = basename(path), id = s.sessionId
    if (!(basename(dirname(path)) === id || name === id + '.jsonl' || name === id + '.json'
      || name.endsWith('-' + id + '.jsonl') || name.endsWith('_' + id + '.jsonl'))) {
      return fail('The conversation file does not match this harness. Nothing was deleted.')
    }
    // An interrupted deletion can leave checkpoints after the native file has gone.
    // Review the remaining files again, but never delete a newly recreated native file.
    if (!existsSync(path)) return { missingFile: join(realpathSync(dirname(path)), name), bytes: 0 }
    const target = file(path)
    return { file: target, bytes: target.bytes }
  }
  let database: string, sessionTable: string, children: [string, string][]
  const id = lit(s.sessionId)
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
    default: return fail('This engine does not support verified history deletion yet.')
  }
  const databaseFile = file(database)
  const query = async (sql: string) => {
    const result = await sqliteReadAll(database, sql)
    if (!result.ok) return fail('The engine history could not be verified. Nothing was deleted.')
    return result.rows
  }
  if (s.engine === 'opencode' && (await query("SELECT name FROM sqlite_master WHERE type='table' AND name='session_v2'")).length
    && (await query(`SELECT id FROM session_v2 WHERE id = ${id}`)).length) {
    sessionTable = 'session_v2'; children = [['session_message', `session_id = ${id}`]]
  }
  await query(`SELECT id FROM ${sessionTable} WHERE id = ${id}`)
  // The binding, only for a purge of a store-backed engine's history: the monitor's process imports this module.
  const { builtinSqlite } = await import('./sqliteBuiltin.js')
  if (!builtinSqlite()) await exec('sqlite3', ['--version'], { timeout: 2500, maxBuffer: 4096 })
  const allowedTables = new Set([sessionTable, ...children.map(([table]) => table)])
  if ((await query("SELECT name, tbl_name FROM sqlite_master WHERE type='trigger'")).some(t => allowedTables.has(String(t.tbl_name)))) {
    return fail('This engine uses history triggers that Harness cannot safely verify. Use the engine to delete its conversation.')
  }
  for (const table of await query("SELECT name FROM sqlite_master WHERE type='table'")) {
    const name = String(table.name)
    if (allowedTables.has(name)) continue
    const references = await query(`PRAGMA foreign_key_list("${name.replace(/"/g, '""')}")`)
    if (references.some(r => allowedTables.has(String(r.table)))) {
      return fail('Other engine data references this conversation store. Use the engine to delete its conversation.')
    }
  }
  // A native session can parent other conversations. Refuse rather than cascade into them.
  const columns = await query(`PRAGMA table_info(${sessionTable})`)
  const schemaVersion = Number((await query('PRAGMA schema_version'))[0]?.schema_version)
  if (!Number.isInteger(schemaVersion)) return fail('The engine history schema could not be verified.')
  const guards: string[] = [`INSERT INTO purge_guard SELECT 0 FROM pragma_schema_version WHERE schema_version <> ${schemaVersion};`]
  for (const parent of ['parent_id', 'parent_session_id']) if (columns.some(c => c.name === parent)) {
    const predicate = `${parent} = ${id} AND id <> ${id}`
    if ((await query(`SELECT id FROM ${sessionTable} WHERE ${predicate} LIMIT 1`)).length) {
      return fail('Other conversations depend on this session. Delete those through the engine before deleting this harness.')
    }
    guards.push(`INSERT INTO purge_guard SELECT 0 FROM ${sessionTable} WHERE ${predicate};`)
  }
  // Prepare every required table before asking to stop anything. Unknown schemas fail closed.
  for (const [table, where] of children) await query(`SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`)
  let bytes = 0
  for (const [table, where] of [[sessionTable, `id = ${id}`], ...children]) {
    const fields = await query(`PRAGMA table_info(${table})`)
    const lengths = fields.map(c => `length(CAST(COALESCE("${String(c.name).replace(/"/g, '""')}", '') AS BLOB))`).join(' + ')
    const size = await query(`SELECT COALESCE(SUM(${lengths}), 0) AS bytes FROM ${table} WHERE ${where}`)
    bytes += Number(size[0]?.bytes ?? 0)
  }
  return { database, databaseFile, bytes, statements: [
    'CREATE TEMP TABLE purge_guard (ok INTEGER CHECK(ok = 1));', ...guards,
    ...children.map(([table, where]) => `DELETE FROM ${table} WHERE ${where};`),
    `DELETE FROM ${sessionTable} WHERE id = ${id};`,
  ] }
}

export async function eraseNativeHistory(history: History): Promise<number> {
  if (history.missingFile && existsSync(history.missingFile)) fail('The conversation file was recreated. Review deletion again.')
  if (history.file) {
    const current = file(history.file.path)
    if (current.dev !== history.file.dev || current.ino !== history.file.ino) fail('The conversation file changed. Refresh and review deletion again.')
    unlinkSync(current.path)
    return current.bytes
  }
  if (history.database) {
    const current = file(history.database)
    if (current.dev !== history.databaseFile?.dev || current.ino !== history.databaseFile?.ino) fail('The engine history store changed. Review deletion again.')
    const sql = ['PRAGMA busy_timeout=1000;', 'PRAGMA foreign_keys=ON;', 'BEGIN IMMEDIATE;', ...history.statements!, 'COMMIT;'].join('\n')
    const Database = (await import('./sqliteBuiltin.js')).builtinSqlite()
    if (Database) {
      const db = new Database(history.database, { readOnly: false })
      try { db.exec(sql) } finally { db.close() }
    } else {
      // -bail rolls back on a schema, constraint or lock failure. Never vacuum a shared store.
      await exec('sqlite3', ['-batch', '-bail', history.database, sql], { timeout: 15_000, maxBuffer: 4096 })
    }
  }
  return 0
}

export async function sessionDataBytes(s: RegisteredSession, checkpoints: SessionCheckpointStore): Promise<number | null> {
  try {
    const history = await inspectNativeHistory(s)
    if (history.bytes == null) return null
    return history.bytes + checkpoints.deletionFiles(s).reduce((n, path) => n + file(path).bytes, 0)
  } catch { return null }
}

export interface PurgeRequest {
  agentId: string; sessionId: string | null; createdAt: number; mode: 'inspect' | 'delete'; reviewId?: string
  includeWorktree?: boolean; choices?: { sessionData: boolean; worktreeData: boolean }; path?: string; discardChanges?: boolean
}
export type WorktreeRequest = Omit<PurgeRequest, 'mode'> & { mode: 'describe' | 'inspect' | 'delete'; path?: string; discardChanges?: boolean }
export interface PurgeDeps {
  live(id: string): RegisteredSession | undefined
  sessions(): RegisteredSession[]
  stopped: StoppedAgentStore
  checkpoints: SessionCheckpointStore
  stop(id: string, options: StopAgentOptions): Promise<void>
  restarting(id: string): boolean
  deleted(session: RegisteredSession): void
  inspect?: typeof inspectNativeHistory
  erase?: typeof eraseNativeHistory
  now?: () => number
}

export class PurgeAgentService {
  private readonly reviews = new Map<string, { session: RegisteredSession; signature: string; expires: number;
    history: History | null; worktree?: WorktreeReview; includesWorktree: boolean }>()
  private readonly jobs = new Set<string>()
  private readonly worktreeJobs = new Map<string, string>()
  private readonly worktreeReviews = new Map<string, { session: RegisteredSession; signature: string; expires: number; worktree: WorktreeReview }>()
  constructor(private readonly deps: PurgeDeps) {}
  busy(id: string): boolean { return this.jobs.has(id) }
  blocksFolder(cwd: string | null | undefined): boolean {
    if (!cwd) return false
    let path: string
    try { path = realpathSync(cwd) } catch { path = resolve(cwd) }
    return [...this.worktreeJobs.values()].some(root => path === root || path.startsWith(root + sep) || root.startsWith(path + sep))
  }

  async worktreeRequest(request: WorktreeRequest): Promise<Record<string, unknown>> {
    let stopped = false
    try {
      if (this.busy(request.agentId)) throw new Error('Wait for the current harness operation to finish.')
      const now = this.deps.now?.() ?? Date.now()
      for (const [id, review] of this.worktreeReviews) if (review.expires <= now) this.worktreeReviews.delete(id)
      const current = this.current(request, false)
      if (request.mode === 'describe') {
        const signature = identity(current), workspace = await inspectWorkspace(current, this.deps.sessions())
        if (identity(this.current(request, false)) !== signature) throw new Error('The harness changed. Reopen Inspect to check its workspace again.')
        return { workspace }
      }
      if (request.mode === 'inspect') {
        const signature = identity(current), worktree = await inspectWorktree(current, this.deps.sessions())
        if (identity(this.current(request, false)) !== signature) throw new Error('The harness changed. Review its worktree again.')
        const reviewId = randomUUID()
        if (this.worktreeReviews.size >= 64) this.worktreeReviews.delete(this.worktreeReviews.keys().next().value!)
        this.worktreeReviews.set(reviewId, { session: { ...current }, signature, worktree, expires: now + 120_000 })
        return { reviewId, worktree }
      }
      const review = this.worktreeReviews.get(request.reviewId ?? '')
      this.worktreeReviews.delete(request.reviewId ?? '')
      if (!review || review.signature !== identity(current) || request.path !== review.worktree.path) {
        throw new Error('Confirm the reviewed worktree path before deleting it.')
      }
      if (review.worktree.dirty && request.discardChanges !== true) throw new Error('Confirm discarding uncommitted files before deleting this worktree.')
      this.jobs.add(request.agentId)
      this.worktreeJobs.set(request.agentId, review.worktree.path)
      try {
        if (this.deps.live(request.agentId)) await this.deps.stop(request.agentId, { current: () => {
          const live = this.deps.live(request.agentId)
          return !!live && identity(live) === review.signature
        } })
        if (this.deps.live(request.agentId)) throw new Error('The harness did not stop. Its worktree was kept.')
        stopped = true
        const saved = this.current(request, false), reservation = this.deps.stopped.beginResume(request.agentId)
        if (!reservation) throw new Error('Another operation is using this harness. Its worktree was kept.')
        try { await removeReviewedWorktree(review.worktree, saved, this.deps.sessions(), request.discardChanges === true) }
        finally { this.deps.stopped.finishResume(request.agentId, reservation) }
        return { deleted: true, path: review.worktree.path, historyKept: true, branchKept: true }
      } finally { this.jobs.delete(request.agentId); this.worktreeJobs.delete(request.agentId) }
    } catch (error) {
      return { error: 'WORKTREE_DELETE_REFUSED', stopped, detail: (error instanceof Error ? error.message : 'The worktree could not be deleted.')
        + (stopped ? ' The harness is stopped. Review its worktree again before retrying.' : '') }
    }
  }

  private current(request: Pick<PurgeRequest, 'agentId' | 'sessionId' | 'createdAt'>, deletingHistory = true): RegisteredSession {
    const s = this.deps.live(request.agentId) ?? this.deps.stopped.get(request.agentId)
    if (!s || (s.sessionId || null) !== request.sessionId || s.registeredAt !== request.createdAt) return fail('This harness changed. Refresh and review deletion again.')
    if (s.dsh === 'autonomous/harness-monitor' || s.launch?.state === 'starting') return fail('This harness cannot be deleted from this monitor.')
    if (this.deps.restarting(s.agentId)) return fail('Wait for the current harness operation to finish, then try again.')
    if (deletingHistory && s.sessionId && this.deps.sessions().some(other => other.agentId !== s.agentId && other.sessionId === s.sessionId)) {
      return fail('Another harness uses this conversation. Its shared history cannot be deleted here.')
    }
    return s
  }

  async request(request: PurgeRequest): Promise<Record<string, unknown>> {
    let stopped = false, worktreeDeleted = false, sessionDeleted = false
    const sessionData = request.choices ? request.choices.sessionData === true : true
    const worktreeData = request.choices?.worktreeData === true
    try {
      if (this.busy(request.agentId)) return { error: 'DELETE_IN_PROGRESS', detail: 'This harness is already being deleted.' }
      const now = this.deps.now?.() ?? Date.now()
      for (const [id, review] of this.reviews) if (review.expires <= now) this.reviews.delete(id)
      const current = this.current(request, request.mode === 'inspect' ? !request.includeWorktree : sessionData)
      if (request.mode === 'inspect') {
        const signature = identity(current)
        let history: History | null = null, checkpointFiles: File[] = [], historyReason = ''
        try {
          this.current(request)
          history = await (this.deps.inspect ?? inspectNativeHistory)(current)
          checkpointFiles = this.deps.checkpoints.deletionFiles(current).map(file)
        } catch (error) {
          if (!request.includeWorktree) throw error
          history = null
          historyReason = error instanceof Error ? error.message : 'Session data could not be verified.'
        }
        let worktree: WorktreeReview | undefined, worktreeReason = ''
        if (request.includeWorktree) {
          try { worktree = await inspectWorktree(current, this.deps.sessions()) }
          catch (error) { worktreeReason = error instanceof Error ? error.message : 'The worktree could not be verified.' }
        }
        if (identity(this.current(request, !request.includeWorktree)) !== signature) return fail('The harness changed while checking its data. Try again.')
        const sessionBytes = history?.bytes == null ? null : history.bytes + checkpointFiles.reduce((n, f) => n + f.bytes, 0)
        const paths = history ? [history.file?.path ?? history.missingFile ?? history.database, ...checkpointFiles.map(f => f.path)].filter(Boolean) : []
        const reviewId = randomUUID()
        if (this.reviews.size >= 64) this.reviews.delete(this.reviews.keys().next().value!)
        this.reviews.set(reviewId, { session: { ...current }, signature, history, worktree, includesWorktree: request.includeWorktree === true, expires: now + 120_000 })
        return { reviewId, sessionBytes, sessionPaths: paths,
          sharedStore: !!history?.database, workspaceKept: true, workspacePath: current.cwd,
          ...(request.includeWorktree ? { choices: {
            sessionData: { available: history !== null, bytes: sessionBytes, paths, sharedStore: !!history?.database, reason: historyReason },
            worktreeData: { available: !!worktree, path: worktree?.path ?? current.cwd, bytes: worktree?.bytes ?? null,
              mainPath: worktree?.main, branch: worktree?.branch, dirty: worktree?.dirty ?? false, changes: worktree?.changes ?? [], reason: worktreeReason },
          } } : {}) }
      }
      const review = this.reviews.get(request.reviewId ?? '')
      this.reviews.delete(request.reviewId ?? '')
      if (!review || review.signature !== identity(current)) return fail('The deletion review expired or changed. Review this harness again.')
      if (!sessionData && !worktreeData) return fail('Select session data, worktree data, or both.')
      if (sessionData && !review.history) return fail('Session data was not verified. Review this harness again.')
      if (worktreeData && (!review.includesWorktree || !review.worktree || request.path !== review.worktree.path)) {
        return fail('Only the reviewed worktree folder can be deleted. Review it again.')
      }
      if (worktreeData && review.worktree?.dirty && !request.discardChanges) return fail('Confirm discarding the listed uncommitted files before deleting this worktree.')
      this.jobs.add(request.agentId)
      if (worktreeData) this.worktreeJobs.set(request.agentId, review.worktree!.path)
      try {
        if (this.deps.live(request.agentId)) {
          await this.deps.stop(request.agentId, { current: () => {
            const live = this.deps.live(request.agentId)
            return !!live && identity(live) === review.signature
          } })
        }
        if (this.deps.live(request.agentId)) return fail('The harness did not stop. No session data was deleted.')
        stopped = true
        const saved = this.current(request, sessionData)
        if (sessionData && (conversation(saved) !== conversation(review.session) || saved.transcriptPath !== review.session.transcriptPath)) {
          return fail('The saved conversation changed while stopping. Review it before deleting.')
        }
        // Stop has saved its final archive. Reserve it while asynchronous native DB deletion runs.
        const reservation = this.deps.stopped.beginResume(request.agentId)
        if (!reservation) return fail('Another operation is using this saved harness. Nothing was deleted.')
        try {
          const files = sessionData ? this.deps.checkpoints.deletionFiles(saved).map(file) : []
          if (worktreeData) {
            await removeReviewedWorktree(review.worktree!, saved, this.deps.sessions(), request.discardChanges === true)
            worktreeDeleted = true
          }
          let freedBytes = 0
          if (sessionData) {
            freedBytes = await (this.deps.erase ?? eraseNativeHistory)(review.history!)
            for (const target of files) {
              const current = file(target.path)
              if (current.dev !== target.dev || current.ino !== target.ino) return fail('Saved session data changed. Some data may already have been deleted; refresh to check.')
              unlinkSync(target.path); freedBytes += current.bytes
            }
            this.deps.deleted(saved)
            this.deps.stopped.remove(request.agentId)
            sessionDeleted = true
          }
          return { deleted: true, sessionDeleted, worktreeDeleted, freedBytes,
            sharedStore: sessionData && !!review.history?.database, workspaceKept: !worktreeDeleted, historyKept: !sessionData, branchKept: true }
        } finally { this.deps.stopped.finishResume(request.agentId, reservation) }
      } finally { this.jobs.delete(request.agentId); this.worktreeJobs.delete(request.agentId) }
    } catch (error) {
      return { error: 'DELETE_REFUSED', stopped, worktreeDeleted, sessionDeleted,
        detail: (error instanceof Error ? error.message : 'Could not delete this harness.')
          + (worktreeDeleted ? ' The worktree was deleted.' : '')
          + (sessionDeleted ? ' Session data was deleted.' : worktreeDeleted && sessionData ? ' Session data deletion did not finish.' : '')
          + (stopped ? ' The harness is stopped; refresh before trying again.' : '') }
    }
  }
}
