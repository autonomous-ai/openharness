/**
 * Profile-owned SQLite core. The daemon integration supplies authenticated scope and runs this
 * synchronous store outside its latency-sensitive thread. No provider calls or command execution.
 */
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { builtinSqlite } from '../lib/sqliteRead.js'
import { redact } from '../pair/learn/guard.js'
import { admission, assertSafe, canonical, digest, proposalFingerprint } from './admission.js'
import type { ProjectLocator } from './project.js'
import type { Database } from './database.js'
import { MemoryQueue, PENDING_RETENTION_MS, QUEUE_SCHEMA, TERMINAL_JOB_STATES } from './queue.js'
import { MemoryReceipts, RECEIPT_SCHEMA, type MemoryDeliveryBinding, type PreparedRecall, type RecallReceipt, type ActivityReceiver } from './receipts.js'
import { libraryActivityQuerySchema, type LibraryActivity, type LibraryActivityQuery } from './library.js'
import { MemoryNotebook, NOTEBOOK_SCHEMA, type NotebookInput, type NotebookLease, type NotebookProposal } from './notebook.js'
import type { InferenceTarget } from './queue.js'
import { visibleEvidenceSql } from './visibility.js'
import { sourceRecallText, type SourceRecallSelection } from './recallSources.js'
import { correctionSchema, libraryCommandSchema, libraryQuerySchema, libraryProjectQuerySchema, notebookQuerySchema, summarize, type NotebookQuery, type NotebookIndex, type NotebookSummary, type NotebookDetail, type LibraryProjectQuery, type LibraryProject, type LibraryProjects, type LibraryQuery, type LibraryPage, type LibraryDetail, type MemoryCorrection, type LibraryCommand, type LibraryPreview } from './library.js'
import {
  canAccess, conditionsOverlap, conditionsSchema, draftSchema, hasPointer, matches, MemoryError, parse, sourceSchema, topicSchema,
  type MemoryAccess, type MemoryDraft, type MemoryRecord, type MemoryScope, type MemoryState, type MemorySupport,
  type RecallItem, type RecallPacket, type RecallRequest, type SourceEvent, type TopicDraft, type TopicPage,
} from './types.js'

type Constructor = new (path: string, options?: Record<string, unknown>) => Database
interface OpenOptions { directory: string; profileId: string; now?: () => number }
type OpenResult = { ok: true; store: CodingMemoryStore } | { ok: false; reason: string }
interface Controls { learn: boolean; recall: boolean; generation: number; captureEpoch: number; learnSince: number | null }
export interface MemoryPreferences { learn: boolean; recall: boolean }
interface Compaction { compactedSources: number; deletedSources: number; removedBytes: number }

// v2 distinguishes intact bounded context from completed turns. A v1 reader must
// refuse this store rather than review queued segments as complete conversations.
// Memory records retain their v1 format; the upgrade only adds queue metadata.
const SCHEMA = 2
const EMPTY = (status: RecallPacket['status'] = 'ok'): RecallPacket => ({ status, items: [], text: '', estimatedTokens: 0 })
const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'not', 'to', 'of', 'for', 'in', 'on', 'is', 'it', 'with', 'this', 'that', 'please', 'can', 'you', 'we', 'our', 'my'])

export class CodingMemoryStore {
  private closed = false
  private transactionDepth = 0
  readonly learning: MemoryQueue
  private readonly receipts: MemoryReceipts
  private readonly notebook: MemoryNotebook
  private constructor(private readonly db: Database, readonly profileId: string, private readonly now: () => number) {
    this.receipts = new MemoryReceipts({ db, profileId, now, transaction: run => this.transaction(run),
      recall: (request, access) => this.recall(request, access), read: (id, access) => this.read(id, access),
      allowed: (binding, access) => access.profileId === this.profileId && access.includeProfile
        && (binding.projectId === null ? access.projectIds.length === 0
          : access.projectIds.length === 1 && access.projectIds[0] === binding.projectId)
        && this.capturePolicy(binding.projectId, binding.engine, binding.sessionId).included,
    })
    this.learning = new MemoryQueue({ db, profileId, now, transaction: operation => this.transaction(operation),
      controls: () => this.controls(), included: projectId => this.included(projectId),
      sessionIncluded: (engine, sessionId) => this.sessionPolicy(engine, sessionId).included,
      ingest: (event, generation) => this.ingest(event, generation), source: id => {
        const source = this.rawSource(id)
        return source && this.sourceIncluded(source) ? source : null
      },
      propose: (draft, access, generation) => this.propose(draft, access, generation),
      compact: sourceIds => { this.compactSources(sourceIds) },
    })
    this.notebook = new MemoryNotebook({ db, profileId, now, transaction: operation => this.transaction(operation),
      controls: () => this.controls(), inputs: (scope, facet) => this.notebookInputs(scope, facet),
      putTopic: (draft, access, revision, generation) => this.putTopic(draft, access, revision, generation),
    })
  }

  static open(options: OpenOptions): OpenResult {
    let db: Database | undefined
    try {
      if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(options.profileId)) return { ok: false, reason: 'invalid_profile' }
      const Database = builtinSqlite() as unknown as Constructor | null
      if (!Database) return { ok: false, reason: 'sqlite_unavailable' }
      mkdirSync(options.directory, { recursive: true, mode: 0o700 })
      const path = join(options.directory, 'memory.sqlite')
      if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) return { ok: false, reason: 'invalid_store_path' }
      db = new Database(path)
      chmodSync(path, 0o600)
      db.exec('PRAGMA busy_timeout = 25; PRAGMA foreign_keys = ON;')
      const meta = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_meta'").get()
      if (meta) {
        const owner = db.prepare("SELECT value FROM memory_meta WHERE key = 'profile'").get()?.value
        const version = db.prepare("SELECT value FROM memory_meta WHERE key = 'schema'").get()?.value
        if (owner !== options.profileId) throw new MemoryError('profile_mismatch')
        if (version !== '1' && version !== String(SCHEMA)) throw new MemoryError('schema_unsupported')
      }
      // No long-lived WAL containing deleted text. Both ordinary pages and FTS segments are scrubbed.
      db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;')
      const store = new CodingMemoryStore(db, options.profileId, options.now ?? Date.now)
      store.transaction(() => {
        db!.exec(`
          CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, included INTEGER NOT NULL CHECK(included IN (0,1)));
          CREATE TABLE IF NOT EXISTS memory_project_names (
            project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
            name TEXT NOT NULL, location TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS memory_project_policy (
            project_id TEXT PRIMARY KEY REFERENCES projects(id), epoch INTEGER NOT NULL, live_from INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS memory_session_policy (
            engine TEXT NOT NULL, session_id TEXT NOT NULL, included INTEGER NOT NULL,
            epoch INTEGER NOT NULL, live_from INTEGER NOT NULL, PRIMARY KEY(engine, session_id)
          );
          CREATE TABLE IF NOT EXISTS project_locators (
            locator_key TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id)
          );
          CREATE TABLE IF NOT EXISTS sources (
            id TEXT PRIMARY KEY, native_key TEXT UNIQUE NOT NULL, project_id TEXT, digest TEXT NOT NULL, data TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS source_lifecycle (
            source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
            captured_at INTEGER NOT NULL, needs_compaction INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS retired_sources (
            id_hash TEXT PRIMARY KEY, native_key TEXT UNIQUE NOT NULL, digest TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS memories (
            rowid INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, revision INTEGER NOT NULL,
            project_id TEXT, task_id TEXT, branch_id TEXT, scope_key TEXT NOT NULL, conflict_key TEXT NOT NULL,
            state TEXT NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS memories_scope ON memories(project_id, state);
          CREATE INDEX IF NOT EXISTS memories_conflicts ON memories(scope_key, conflict_key, state);
          CREATE INDEX IF NOT EXISTS memories_conflict_key ON memories(conflict_key, state);
          CREATE INDEX IF NOT EXISTS memories_fingerprint ON memories(fingerprint);
          CREATE TABLE IF NOT EXISTS revisions (
            memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
            revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(memory_id, revision)
          );
          CREATE TABLE IF NOT EXISTS memory_scope_changes (
            memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
            revision INTEGER NOT NULL, from_scope TEXT NOT NULL, to_scope TEXT NOT NULL,
            changed_at INTEGER NOT NULL, PRIMARY KEY(memory_id, revision)
          );
          CREATE TABLE IF NOT EXISTS evidence (
            memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
            revision INTEGER NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id), quote TEXT NOT NULL,
            PRIMARY KEY(memory_id, revision, source_id, quote)
          );
          CREATE INDEX IF NOT EXISTS evidence_source ON evidence(source_id);
          CREATE TABLE IF NOT EXISTS memory_support (
            memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL,
            root_id TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
            quote TEXT NOT NULL, kind TEXT NOT NULL, session_key TEXT NOT NULL, observed_at INTEGER NOT NULL,
            PRIMARY KEY(memory_id, fingerprint, root_id)
          );
          CREATE INDEX IF NOT EXISTS memory_support_source ON memory_support(source_id);
          CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(claim, rationale, cues, tokenize='unicode61');
          CREATE TABLE IF NOT EXISTS topics (
            id TEXT PRIMARY KEY, revision INTEGER NOT NULL, project_id TEXT, scope_key TEXT NOT NULL, data TEXT
          );
          CREATE TABLE IF NOT EXISTS topic_dependencies (
            topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
            memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
            PRIMARY KEY(topic_id, memory_id)
          );
          CREATE INDEX IF NOT EXISTS topic_parents ON topic_dependencies(memory_id);
          CREATE TABLE IF NOT EXISTS source_dependencies (
            source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
            memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
            PRIMARY KEY(source_id, memory_id)
          );
          CREATE INDEX IF NOT EXISTS source_parents ON source_dependencies(memory_id);
          CREATE TABLE IF NOT EXISTS suppressed_sources (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS tombstones (id TEXT PRIMARY KEY, last_revision INTEGER NOT NULL, at INTEGER NOT NULL);
          ${QUEUE_SCHEMA}
          ${RECEIPT_SCHEMA}
          ${NOTEBOOK_SCHEMA}
        `)
        db!.prepare("INSERT OR IGNORE INTO memory_meta(key, value) VALUES('profile', ?)").run(options.profileId)
        db!.prepare("INSERT INTO memory_meta(key, value) VALUES('schema', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(SCHEMA))
        db!.prepare("INSERT OR IGNORE INTO memory_meta(key, value) VALUES('controls', ?)").run(JSON.stringify({ learn: false, recall: false, generation: 0, captureEpoch: 0, learnSince: null }))
        db!.prepare("INSERT OR IGNORE INTO memory_meta(key,value) VALUES('preferences',?)").run(JSON.stringify({ learn: true, recall: true }))
        db!.exec("INSERT OR IGNORE INTO memory_meta(key,value) VALUES('knowledge_epoch','0')")
        db!.prepare('INSERT OR IGNORE INTO source_lifecycle(source_id,captured_at,needs_compaction) SELECT id,?,1 FROM sources').run(store.now())
        db!.exec("INSERT INTO memory_fts(memory_fts, rank) VALUES('secure-delete', 1)")
      })
      return { ok: true, store }
    } catch (error) {
      try { db?.close() } catch { /* Preserve the typed failure; no source text in diagnostics. */ }
      return { ok: false, reason: error instanceof MemoryError ? error.code : 'store_unavailable' }
    }
  }

  close(): void { if (!this.closed) { this.db.close(); this.closed = true } }

  controls(): Controls {
    return JSON.parse(String(this.db.prepare("SELECT value FROM memory_meta WHERE key = 'controls'").get()!.value)) as Controls
  }

  preferences(): MemoryPreferences {
    return JSON.parse(String(this.db.prepare("SELECT value FROM memory_meta WHERE key='preferences'").get()!.value)) as MemoryPreferences
  }

  /** A settings form cannot overwrite a newer window's acknowledged choice. */
  changePreferences(value: MemoryPreferences, expected: MemoryPreferences, enabled = true): MemoryPreferences {
    if ([value.learn, value.recall, expected.learn, expected.recall].some(flag => typeof flag !== 'boolean')) throw new MemoryError('invalid_input')
    return this.transaction(() => {
      const previous = this.preferences()
      if (previous.learn !== expected.learn || previous.recall !== expected.recall) throw new MemoryError('revision_conflict')
      this.setPreferences(value)
      if (!enabled) this.setControls({ learn: false, recall: false })
      return this.preferences()
    })
  }

  /** Requested controls survive a temporary experimental/consent/account gate closing. */
  setPreferences(value: MemoryPreferences): void {
    if (typeof value.learn !== 'boolean' || typeof value.recall !== 'boolean') throw new MemoryError('invalid_input')
    this.transaction(() => {
      this.db.prepare("UPDATE memory_meta SET value=? WHERE key='preferences'").run(JSON.stringify({ learn: value.learn, recall: value.recall }))
      this.setControls(value)
    })
  }

  /** Trusted integration controls, not model-proposable fields. */
  setControls(value: { learn: boolean; recall: boolean }): void {
    if (typeof value.learn !== 'boolean' || typeof value.recall !== 'boolean') throw new MemoryError('invalid_input')
    this.transaction(() => {
      const previous = this.controls()
      if (previous.learn === value.learn && previous.recall === value.recall) return
      this.db.prepare("UPDATE memory_meta SET value = ? WHERE key = 'controls'")
        .run(JSON.stringify({ ...value, generation: previous.generation + 1,
          captureEpoch: previous.captureEpoch + (previous.learn !== value.learn ? 1 : 0),
          learnSince: value.learn ? previous.learn ? previous.learnSince : this.now() : null }))
    })
  }

  registerProject(projectId: string): void {
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(projectId)) throw new MemoryError('invalid_input')
    this.db.prepare('INSERT OR IGNORE INTO projects(id, included) VALUES(?, 1)').run(projectId)
  }

  projectForLocator(locator: ProjectLocator): string {
    const key = this.locatorKey(locator)
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT project_id FROM project_locators WHERE locator_key = ?').get(key)
      const id = existing ? String(existing.project_id) : randomUUID()
      if (!existing) {
        this.registerProject(id)
        this.db.prepare('INSERT INTO project_locators(locator_key, project_id) VALUES(?, ?)').run(key, id)
      }
      // Owner-facing identity only. Labels and local paths are never added to extraction or recall.
      // A worktree uses its common repository directory; an explicitly linked clone keeps the first label.
      const location = locator.kind === 'git_common_directory' && basename(locator.path) === '.git' ? dirname(locator.path) : locator.path
      this.db.prepare('INSERT OR IGNORE INTO memory_project_names(project_id,name,location) VALUES(?,?,?)')
        .run(id, redact(basename(location) || 'Project').slice(0, 160), redact(location))
      return id
    })
  }

  /** Explicit host-authorized alias for another clone; never inferred from a matching remote. */
  linkProjectLocator(projectId: string, locator: ProjectLocator): void {
    const key = this.locatorKey(locator)
    this.transaction(() => {
      if (!this.db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new MemoryError('unknown_project')
      const previous = this.db.prepare('SELECT project_id FROM project_locators WHERE locator_key = ?').get(key)
      if (previous && previous.project_id !== projectId) throw new MemoryError('project_identity_conflict')
      this.db.prepare('INSERT OR IGNORE INTO project_locators(locator_key, project_id) VALUES(?, ?)').run(key, projectId)
    })
  }

  setProjectIncluded(projectId: string, included: boolean): void {
    if (typeof included !== 'boolean' || !this.db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new MemoryError('unknown_project')
    this.transaction(() => {
      const previous = this.included(projectId)
      // An older writer may have changed privacy without removing receiver activity.
      // Reinclusion must not revive ratings from the excluded period.
      if (!previous || !included) this.receipts.withholdProject(projectId)
      if (previous === included) return
      this.db.prepare('UPDATE projects SET included = ? WHERE id = ?').run(included ? 1 : 0, projectId)
      this.db.prepare(`INSERT INTO memory_project_policy(project_id,epoch,live_from) VALUES(?,1,?)
        ON CONFLICT(project_id) DO UPDATE SET epoch=epoch+1,live_from=excluded.live_from`).run(projectId, this.now())
      this.db.exec('UPDATE topics SET data = NULL')
      this.notebook.invalidate()
      const controls = this.controls()
      this.db.prepare("UPDATE memory_meta SET value = ? WHERE key = 'controls'").run(JSON.stringify({ ...controls, generation: controls.generation + 1 }))
      this.db.prepare(`UPDATE memory_jobs SET state='cancelled', lease_token=NULL, lease_until=0, source_digest=NULL,
        last_error='project_privacy_changed', updated_at=? WHERE project_id=? AND state NOT IN ${TERMINAL_JOB_STATES}`)
        .run(this.now(), projectId)
      if (!included) this.cancelHiddenSources()
      else this.reconcileVisibleConflicts()
    })
  }

  sessionPolicy(engine: string, sessionId: string): { included: boolean; epoch: number; liveFrom: number } {
    if (![engine, sessionId].every(value => /^[A-Za-z0-9_.:-]{1,200}$/.test(value))) throw new MemoryError('invalid_input')
    const row = this.db.prepare('SELECT included, epoch, live_from FROM memory_session_policy WHERE engine=? AND session_id=?').get(engine, sessionId)
    return row ? { included: row.included === 1, epoch: Number(row.epoch), liveFrom: Number(row.live_from) }
      : { included: true, epoch: 0, liveFrom: 0 }
  }

  capturePolicy(projectId: string | null, engine: string, sessionId: string): Controls & { included: boolean; sessionEpoch: number; projectEpoch: number; liveFrom: number; knowledgeEpoch: number } {
    const policy = this.sessionPolicy(engine, sessionId)
    const project = this.db.prepare('SELECT epoch,live_from FROM memory_project_policy WHERE project_id=?').get(projectId)
    return { ...this.controls(), included: this.included(projectId) && policy.included,
      knowledgeEpoch: Number(this.db.prepare("SELECT value FROM memory_meta WHERE key='knowledge_epoch'").get()!.value),
      sessionEpoch: policy.epoch, projectEpoch: Number(project?.epoch ?? 0), liveFrom: Math.max(policy.liveFrom, Number(project?.live_from ?? 0)) }
  }

  /** Host-authorized privacy control. Withholds previous knowledge without erasing the native conversation. */
  setSessionIncluded(engine: string, sessionId: string, included: boolean): void {
    if (typeof included !== 'boolean') throw new MemoryError('invalid_input')
    this.transaction(() => {
      const previous = this.sessionPolicy(engine, sessionId)
      if (!previous.included || !included) this.receipts.withholdSession(engine, sessionId)
      if (previous.included === included) return
      this.db.prepare(`INSERT INTO memory_session_policy(engine,session_id,included,epoch,live_from) VALUES(?,?,?,?,?)
        ON CONFLICT(engine,session_id) DO UPDATE SET included=excluded.included, epoch=excluded.epoch, live_from=excluded.live_from`)
        .run(engine, sessionId, included ? 1 : 0, previous.epoch + 1, this.now())
      const controls = this.controls()
      this.db.prepare("UPDATE memory_meta SET value=? WHERE key='controls'").run(JSON.stringify({ ...controls, generation: controls.generation + 1 }))
      this.db.prepare(`UPDATE memory_jobs SET state='cancelled', lease_token=NULL, lease_until=0, source_digest=NULL,
        last_error='session_privacy_changed', updated_at=? WHERE stream_id IN
        (SELECT id FROM memory_streams WHERE engine=? AND session_id=?) AND state NOT IN ${TERMINAL_JOB_STATES}`)
        .run(this.now(), engine, sessionId)
      // Derived input can belong to a different stream while retaining this session's source roots.
      if (!included) this.cancelHiddenSources()
      else this.reconcileVisibleConflicts()
      // A derived page may combine several sessions. Rebuild it only from currently visible parents.
      this.db.exec('UPDATE topics SET data=NULL')
      this.notebook.invalidate()
    })
  }

  ingest(input: SourceEvent, expectedGeneration = this.controls().generation): { disposition: 'created' | 'duplicate' | 'suppressed' | 'retired' } {
    return this.ingestSource(input, expectedGeneration)
  }

  private ingestSource(input: SourceEvent, expectedGeneration: number, userAction = false): { disposition: 'created' | 'duplicate' | 'suppressed' | 'retired' } {
    const source = parse(sourceSchema, input)
    if (source.profileId !== this.profileId) throw new MemoryError('profile_mismatch')
    if (!userAction && !this.controls().learn) throw new MemoryError('learning_off')
    if (source.eligibility !== 'coding' || !this.included(source.projectId) || !this.sessionPolicy(source.engine, source.sessionId).included) throw new MemoryError('source_ineligible')
    // Native adapters preserve roles. Generated packets may only cite already known source roots.
    if (source.role !== 'derived' && (source.rootIds.length !== 1 || source.rootIds[0] !== source.id)) throw new MemoryError('invalid_lineage')
    const { text, ...metadata } = source
    assertSafe(metadata)
    const cleaned: SourceEvent = { ...source, text: redact(text) }
    const key = digest([source.engine, source.sessionId, source.nativeEventId])
    return this.transaction(() => {
      const controls = this.controls()
      if (!userAction && !controls.learn) throw new MemoryError('learning_off')
      if (controls.generation !== expectedGeneration) throw new MemoryError('generation_changed')
      if (!this.included(source.projectId)) throw new MemoryError('source_ineligible')
      if (this.isSuppressed(cleaned)) return { disposition: 'suppressed' as const }
      const receipt = this.db.prepare('SELECT id_hash,native_key,digest FROM retired_sources WHERE id_hash=? OR native_key=?').get(digest(source.id), key)
      if (receipt) {
        if (receipt.id_hash !== digest(source.id) || receipt.native_key !== key || receipt.digest !== digest(cleaned)) throw new MemoryError('source_identity_conflict')
        return { disposition: 'retired' as const }
      }
      if (source.role === 'derived') {
        const actualRoots = new Set<string>()
        for (const parent of source.derivedFrom!) {
          const row = this.db.prepare('SELECT data FROM memories WHERE id = ?').get(parent.memoryId)
          const record = row ? this.record(row) : null
          if (!record || record.revision !== parent.revision || record.state !== 'active' || !this.current(record)
            || !this.evidenceIncluded(record)) throw new MemoryError('invalid_lineage')
          if (record.scope.projectId && record.scope.projectId !== source.projectId) throw new MemoryError('evidence_scope')
          for (const key of ['taskId', 'branchId'] as const) {
            if (record.scope[key] !== undefined && record.scope[key] !== source[key]) throw new MemoryError('evidence_scope')
          }
          for (const evidence of record.evidence) for (const root of this.rawSource(evidence.sourceEventId)!.rootIds) actualRoots.add(root)
        }
        if (canonical([...actualRoots].sort()) !== canonical([...new Set(source.rootIds)].sort())) throw new MemoryError('invalid_lineage')
      }
      const existing = this.db.prepare('SELECT id, digest FROM sources WHERE id = ? OR native_key = ?').get(source.id, key)
      if (existing) {
        if (existing.id !== source.id || existing.digest !== digest(cleaned)) throw new MemoryError('source_identity_conflict')
        return { disposition: 'duplicate' as const }
      }
      this.db.prepare('INSERT INTO sources(id, native_key, project_id, digest, data) VALUES(?, ?, ?, ?, ?)')
        .run(source.id, key, source.projectId, digest(cleaned), JSON.stringify(cleaned))
      this.db.prepare('INSERT INTO source_lifecycle(source_id,captured_at,needs_compaction) VALUES(?,?,1)').run(source.id, this.now())
      for (const parent of source.derivedFrom ?? []) this.db.prepare('INSERT INTO source_dependencies(source_id, memory_id, revision) VALUES(?, ?, ?)')
        .run(source.id, parent.memoryId, parent.revision)
      return { disposition: 'created' as const }
    })
  }

  source(id: string, access: MemoryAccess): SourceEvent | null {
    const source = this.rawSource(id)
    return source && this.sourceIncluded(source) && this.allowed({ profileId: source.profileId, ...(source.projectId ? { projectId: source.projectId } : {}),
      ...(source.taskId ? { taskId: source.taskId } : {}), ...(source.branchId ? { branchId: source.branchId } : {}) }, access) ? source : null
  }

  /** No model calls. Completed work retains only evidence; unreviewed raw input expires after a week. */
  maintain(): Compaction & { expiredJobs: number } {
    return this.transaction(() => {
      const expiredJobs = this.learning.expire()
      const rows = this.db.prepare(`SELECT l.source_id FROM source_lifecycle l WHERE l.needs_compaction=1
        AND (l.captured_at<=? OR EXISTS (SELECT 1 FROM memory_job_sources js JOIN memory_jobs j ON j.id=js.job_id
          WHERE js.source_id=l.source_id AND j.state IN ${TERMINAL_JOB_STATES}))
        AND NOT EXISTS (SELECT 1 FROM memory_job_sources js JOIN memory_jobs j ON j.id=js.job_id
          WHERE js.source_id=l.source_id AND j.state NOT IN ${TERMINAL_JOB_STATES})
        ORDER BY l.captured_at LIMIT 512`).all(this.now() - PENDING_RETENTION_MS)
      const result = this.compactSources(rows.map(row => String(row.source_id)))
      this.learning.pruneMetadata()
      this.receipts.prune()
      this.notebook.pruneEmpty()
      return { ...result, expiredJobs }
    })
  }

  private compactSources(ids: string[]): Compaction {
    const result: Compaction = { compactedSources: 0, deletedSources: 0, removedBytes: 0 }
    for (const id of new Set(ids)) {
      if (this.db.prepare(`SELECT 1 FROM memory_job_sources js JOIN memory_jobs j ON j.id=js.job_id
        WHERE js.source_id=? AND j.state NOT IN ${TERMINAL_JOB_STATES} LIMIT 1`).get(id)) continue
      const row = this.db.prepare('SELECT * FROM sources WHERE id=?').get(id)
      if (!row) continue
      const quotes = this.db.prepare('SELECT quote FROM evidence WHERE source_id=? UNION SELECT quote FROM memory_support WHERE source_id=?')
        .all(id, id).map(row => String(row.quote))
      if (!quotes.length) {
        // Content-free receipts preserve idempotency when an old native record is replayed.
        this.db.prepare('INSERT OR IGNORE INTO retired_sources(id_hash,native_key,digest) VALUES(?,?,?)').run(digest(id), row.native_key, row.digest)
        this.db.prepare('DELETE FROM sources WHERE id=?').run(id)
        result.deletedSources++; result.removedBytes += Buffer.byteLength(String(row.data))
      } else {
        const source = JSON.parse(String(row.data)) as SourceEvent
        const text = retainExcerpts(source.text, quotes)
        const data = JSON.stringify({ ...source, text, retention: 'evidence_only' })
        this.db.prepare('UPDATE sources SET data=? WHERE id=?').run(data, id)
        this.db.prepare('UPDATE source_lifecycle SET needs_compaction=0 WHERE source_id=?').run(id)
        result.compactedSources++; result.removedBytes += Math.max(0, Buffer.byteLength(String(row.data)) - Buffer.byteLength(data))
      }
    }
    return result
  }

  propose(input: MemoryDraft, access: MemoryAccess, expectedGeneration = this.controls().generation): { record: MemoryRecord; disposition: 'created' | 'duplicate' } {
    const draft = parse(draftSchema, input)
    return this.transaction(() => {
      this.assertWritable(draft.scope, access, expectedGeneration)
      const state = this.validateEvidence(draft)
      const fingerprint = proposalFingerprint(draft)
      const duplicate = this.db.prepare("SELECT data FROM memories WHERE fingerprint = ? AND state != 'superseded'").get(fingerprint)
      if (duplicate) {
        let record = this.record(duplicate)
        // A fresh public statement can independently support the same meaning. Never return its
        // old private evidence to the caller; preserve that revision only in its private history.
        if (!this.evidenceIncluded(record)) {
          record = { ...record, ...draft, revision: record.revision + 1, state, updatedAt: this.now() }
          this.withholdConflicts(record)
          this.writeRecord(record)
        }
        this.recordSupport(record, draft)
        return { record, disposition: 'duplicate' as const }
      }
      const record: MemoryRecord = { ...draft, schemaVersion: 1, id: randomUUID(), revision: 1, state, createdAt: this.now(), updatedAt: this.now() }
      this.withholdConflicts(record)
      this.writeRecord(record)
      this.recordSupport(record, draft)
      return { record, disposition: 'created' as const }
    })
  }

  revise(id: string, expectedRevision: number, input: MemoryDraft, access: MemoryAccess,
    supersede: Array<{ id: string; revision: number }> = []): MemoryRecord {
    return this.reviseRecord(id, expectedRevision, input, access, supersede)
  }

  /** Host-only explicit form submission. Automatic extraction must use propose/revise instead. */
  correctFromUser(id: string, expectedRevision: number, input: Omit<MemoryDraft, 'evidence' | 'evidenceClass'>,
    access: MemoryAccess, supersede: Array<{ id: string; revision: number }> = []): MemoryRecord {
    return this.transaction(() => {
      this.requireRecord(id, expectedRevision, access)
      const eventId = randomUUID()
      const fields = ['claim', 'rationale', 'futureAction', 'applicability', 'exceptions', 'validity', 'details'] as const
      const evidence = fields.filter(field => input[field] !== undefined).map(field => ({
        sourceEventId: eventId, quote: canonical(input[field]), paths: [`/${field}`],
      }))
      const draft = parse(draftSchema, { ...input, evidenceClass: 'user_stated', evidence })
      this.assertWritable(draft.scope, access, this.controls().generation, true)
      this.ingestSource({ id: eventId, profileId: this.profileId, projectId: draft.scope.projectId ?? null,
        ...(draft.scope.taskId ? { taskId: draft.scope.taskId } : {}), ...(draft.scope.branchId ? { branchId: draft.scope.branchId } : {}),
        engine: 'harness_viewer', sessionId: `correction:${id}`, nativeEventId: eventId, role: 'user',
        eligibility: 'coding', observedAt: this.now(), rootIds: [eventId], text: canonical(input),
      }, this.controls().generation, true)
      return this.reviseRecord(id, expectedRevision, draft, access, supersede, true)
    })
  }

  private reviseRecord(id: string, expectedRevision: number, input: MemoryDraft, access: MemoryAccess,
    supersede: Array<{ id: string; revision: number }>, userAction = false): MemoryRecord {
    const draft = parse(draftSchema, input)
    return this.transaction(() => {
      const previous = this.requireRecord(id, expectedRevision, access)
      this.assertWritable(draft.scope, access, this.controls().generation, userAction)
      // A correction is backed by a new actual user event, never an old quotation or an agent claim.
      if (!draft.evidence.some(e => this.rawSource(e.sourceEventId)?.role === 'user'
        && !previous.evidence.some(old => old.sourceEventId === e.sourceEventId))) throw new MemoryError('correction_requires_user_evidence')
      const record: MemoryRecord = { ...draft, schemaVersion: 1, id, revision: previous.revision + 1,
        state: this.validateEvidence(draft), createdAt: previous.createdAt, updatedAt: this.now() }
      if (supersede.length > 32 || new Set(supersede.map(peer => peer.id)).size !== supersede.length) throw new MemoryError('invalid_resolution')
      const peers = supersede.map(peer => this.requireRecord(peer.id, peer.revision, access))
      for (const peer of peers) {
        if (peer.id === id || canonical(peer.scope) !== canonical(record.scope) || peer.conflictKey !== record.conflictKey
          || !['active', 'needs_verification'].includes(peer.state) || !conditionsOverlap(peer.applicability, record.applicability)) throw new MemoryError('invalid_resolution')
      }
      for (const peer of peers) this.writeRecord({ ...peer, revision: peer.revision + 1, state: 'superseded', updatedAt: this.now() })
      this.withholdConflicts(record)
      this.writeRecord(record)
      this.recordSupport(record, draft)
      this.invalidateLearning(previous)
      return record
    })
  }

  read(id: string, access: MemoryAccess): MemoryRecord | null {
    const row = this.db.prepare('SELECT data FROM memories WHERE id = ?').get(id)
    if (!row) return null
    const record = this.record(row)
    return this.allowed(record.scope, access) && this.evidenceIncluded(record) ? record : null
  }

  history(id: string, access: MemoryAccess): MemoryRecord[] {
    if (!this.read(id, access)) return []
    return this.db.prepare('SELECT data FROM revisions WHERE memory_id = ? ORDER BY revision').all(id)
      .map(row => this.record(row)).filter(record => this.allowed(record.scope, access) && this.evidenceIncluded(record))
  }

  support(id: string, access: MemoryAccess): MemorySupport | null {
    const record = this.read(id, access)
    if (!record) return null
    const rows = this.db.prepare('SELECT * FROM memory_support WHERE memory_id=? AND fingerprint=?')
      .all(id, proposalFingerprint(asDraft(record))).filter(row => {
        const source = this.rawSource(String(row.source_id))
        return source && this.sourceIncluded(source)
      })
    return { independentUserStatements: rows.filter(row => row.kind === 'user_statement').length,
      verifiedObservations: rows.filter(row => row.kind === 'verified_observation').length,
      distinctSessions: new Set(rows.map(row => row.session_key)).size,
      lastObservedAt: rows.length ? Math.max(...rows.map(row => Number(row.observed_at))) : null }
  }

  list(access: MemoryAccess, limit = 100): MemoryRecord[] {
    if (access.profileId !== this.profileId) return []
    const filter = this.scopeFilter(access)
    return this.db.prepare(`SELECT m.data FROM memories m WHERE ${filter.sql} AND ${visibleEvidenceSql()} ORDER BY m.rowid DESC LIMIT ?`)
      .all(...filter.params, bounded(limit, 100, 1, 200)).map(row => this.record(row)).filter(record => this.allowed(record.scope, access) && this.evidenceIncluded(record))
  }

  /** A separately authorized owner view, including task/branch scopes. Never use for an agent read. */
  libraryPage(owner: string, input: LibraryQuery = {}): LibraryPage {
    this.requireOwner(owner)
    const query = parse(libraryQuerySchema, input)
    if (query.projectId && query.scope === 'personal') throw new MemoryError('invalid_input')
    const { cursor, limit = 25, ...filters } = query
    const version = this.libraryVersion()
    const filterKey = digest(filters)
    let before = Number.MAX_SAFE_INTEGER
    if (cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>
        if (parsed.owner !== this.profileId || parsed.filter !== filterKey || !Number.isSafeInteger(parsed.before)
          || Number(parsed.before) <= 0) throw new MemoryError('invalid_cursor')
        if (parsed.generation !== version.generation || parsed.knowledge !== version.knowledge || parsed.preferences !== version.preferences) throw new MemoryError('page_changed')
        before = Number(parsed.before)
      } catch (error) { throw error instanceof MemoryError ? error : new MemoryError('invalid_cursor') }
    }
    const where = ['m.rowid < ?', '(m.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=m.project_id AND p.included=1))', visibleEvidenceSql()]
    const params: unknown[] = [before]
    if (query.scope === 'personal') where.push('m.project_id IS NULL')
    if (query.scope === 'project') where.push('m.project_id IS NOT NULL')
    if (query.projectId) { where.push('m.project_id=?'); params.push(query.projectId) }
    if (query.topicId) {
      where.push(`EXISTS (SELECT 1 FROM memory_notebook_jobs j WHERE j.id=? AND j.scope_key=m.scope_key AND j.facet=json_extract(m.data,'$.facet'))`)
      params.push(query.topicId)
    }
    if (query.state) { where.push('m.state=?'); params.push(query.state) }
    const rows = this.db.prepare(`SELECT m.rowid,m.data FROM memories m WHERE ${where.join(' AND ')} ORDER BY m.rowid DESC LIMIT ?`)
      .all(...params, limit + 1)
    const page = rows.slice(0, limit)
    return { items: page.map(row => summarize(this.record(row))), version,
      nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ owner: this.profileId, filter: filterKey,
        before: Number(page.at(-1)!.rowid), ...version })).toString('base64url') : null }
  }

  /** Exact retained quotations live in record.evidence; never expose unrelated source transcript text. */
  libraryDetail(owner: string, id: string): LibraryDetail | null {
    this.requireOwner(owner)
    const access = this.ownerRecordAccess(id)
    if (!access) return null
    const record = this.read(id, access)
    if (!record) return null
    const sources = [...new Set(record.evidence.map(evidence => evidence.sourceEventId))].map(id => this.rawSource(id)!)
      .map(({ id, engine, sessionId, role, observedAt }) => ({ id, engine, sessionId, role, observedAt }))
    const scopeChanges: LibraryDetail['scopeChanges'] = this.db.prepare(`SELECT * FROM memory_scope_changes WHERE memory_id=?
      ORDER BY revision DESC LIMIT 20`).all(id).map(row => ({ revision: Number(row.revision),
        from: JSON.parse(String(row.from_scope)), to: JSON.parse(String(row.to_scope)), changedAt: Number(row.changed_at), actor: 'owner' }))
    return { record, sources, support: this.support(id, access), scopeChanges,
      project: record.scope.projectId ? this.projectLabel(record.scope.projectId) : null,
      recalls: this.receipts.forMemory(record.id, record.revision).map(({ projectId, ...recall }) => ({ ...recall,
        project: projectId ? this.projectLabel(projectId) : null, canFeedback: record.state === 'active' && this.current(record) })) }
  }

  libraryProjects(owner: string, input: LibraryProjectQuery = {}): LibraryProjects {
    this.requireOwner(owner)
    const query = parse(libraryProjectQuerySchema, input)
    const limit = query.limit ?? 20
    // Privacy applies before the bounded page. Names/paths are literal search text, never SQL patterns.
    const rows = this.db.prepare(`SELECT p.rowid,p.id,n.name,n.location FROM projects p
      LEFT JOIN memory_project_names n ON n.project_id=p.id WHERE p.included=1 AND p.rowid<?
      AND instr(lower(COALESCE(n.name,p.id) || ' ' || COALESCE(n.location,'')),lower(?))>0
      ORDER BY p.rowid DESC LIMIT ?`).all(query.before ?? Number.MAX_SAFE_INTEGER, query.search ?? '', limit + 1)
    return { items: rows.slice(0, limit).map(row => this.projectLabel(String(row.id))),
      nextBefore: rows.length > limit ? Number(rows[limit - 1].rowid) : null }
  }

  /** Host-supplied open sessions; only the verified owner may inspect their latest selections. */
  libraryActivity(owner: string, receivers: ActivityReceiver[], input: LibraryActivityQuery = {}): LibraryActivity {
    this.requireOwner(owner)
    const query = parse(libraryActivityQuerySchema, input)
    return this.transaction(() => {
      const sessions = this.receipts.activity(receivers).map(({ projectId, ...row }) => ({ ...row,
        project: projectId ? this.projectLabel(projectId) : null }))
      const selectedAgentId = query.agentId ?? sessions[0]?.agentId ?? null
      const selection = sessions.find(row => row.agentId === selectedAgentId)
      const items: LibraryActivity['items'] = []
      for (const item of selection?.receiptId ? this.receipts.activityItems(selection.receiptId) : []) {
        const access = this.ownerRecordAccess(item.id)
        const record = access && this.read(item.id, access)
        if (!record || record.revision !== item.revision || record.state !== 'active' || !this.current(record)) continue
        const recall = this.receipts.forMemory(item.id, item.revision, selection!.receiptId!)[0]
        if (!recall) continue
        const { projectId, ...use } = recall
        items.push({ record: { ...summarize(record), applicability: record.applicability,
          rationale: record.rationale, futureAction: record.futureAction, exceptions: record.exceptions },
          recall: { ...use, canFeedback: true, project: projectId ? this.projectLabel(projectId) : null } })
      }
      return { sessions, selectedAgentId, items, version: this.libraryVersion() }
    })
  }

  private projectLabel(id: string): LibraryProject {
    const row = this.db.prepare('SELECT name,location FROM memory_project_names WHERE project_id=?').get(id)
    return { id, name: row ? String(row.name) : `Project ${id}`, location: row ? String(row.location) : null }
  }

  /** Restrict applicability through the person-only preview flow; this is not new truth evidence. */
  private libraryNarrow(owner: string, id: string, revision: number, projectId: string): LibraryPreview['effects'] {
    this.requireOwner(owner)
    return this.transaction(() => {
      const access = this.ownerRecordAccess(id)
      if (!access) throw new MemoryError('not_found')
      const previous = this.requireRecord(id, revision, access)
      if (previous.scope.projectId) throw new MemoryError('scope_narrowing_only')
      if (!['active', 'tentative', 'needs_verification'].includes(previous.state)) throw new MemoryError('memory_not_active')
      if (this.db.prepare('SELECT included FROM projects WHERE id=?').get(projectId)?.included !== 1) throw new MemoryError('project_unavailable')
      const scope = { ...previous.scope, projectId }
      const draft = { ...asDraft(previous), scope }
      this.assertWritable(scope, { ...access, projectIds: [projectId] }, this.controls().generation, true)
      const admitted = this.validateEvidence(draft)
      const record: MemoryRecord = { ...previous, scope, revision: previous.revision + 1, updatedAt: this.now(),
        state: previous.state === 'active' ? admitted : previous.state }
      const conflicts = this.withholdConflicts(record)
      this.writeRecord(record)
      // The claim is unchanged. Carry every existing independent root to the restricted scope,
      // including corroboration beyond record.evidence; narrowing adds no new confirmation.
      this.db.prepare(`INSERT OR IGNORE INTO memory_support
        (memory_id,fingerprint,root_id,source_id,quote,kind,session_key,observed_at)
        SELECT memory_id,?,root_id,source_id,quote,kind,session_key,observed_at FROM memory_support
        WHERE memory_id=? AND fingerprint=?`).run(proposalFingerprint(draft), id, proposalFingerprint(asDraft(previous)))
      this.invalidateLearning(previous)
      const scopeChange = { revision: record.revision, from: previous.scope, to: scope, changedAt: this.now(), actor: 'owner' as const }
      this.db.prepare('INSERT INTO memory_scope_changes VALUES(?,?,?,?,?)')
        .run(id, record.revision, canonical(previous.scope), canonical(scope), scopeChange.changedAt)
      return { record: summarize(record), scopeChange, project: this.projectLabel(projectId), conflicts: conflicts.map(summarize) }
    })
  }

  libraryCorrect(owner: string, id: string, revision: number, input: MemoryCorrection,
    supersede: Array<{ id: string; revision: number }> = []): MemoryRecord {
    this.requireOwner(owner)
    const fields = parse(correctionSchema, input)
    const access = this.ownerRecordAccess(id)
    if (!access) throw new MemoryError('not_found')
    const previous = this.requireRecord(id, revision, access)
    // A form edit is a user statement, not a test/benchmark result. Keep measured findings on the
    // evidence path; an owner may forget them, but cannot accidentally preserve a verification badge.
    if (previous.assertionType === 'verified_finding' || previous.details?.experiment?.runs) throw new MemoryError('verification_required')
    // Only submitted fields become a fresh user statement. In particular, do not silently promote
    // old inferred detail objects that the correction form did not include in its preview.
    const { evidence: _evidence, evidenceClass: _class, details: _details, ...draft } = asDraft(previous)
    return this.correctFromUser(id, revision, { ...draft, ...fields }, access, supersede)
  }

  libraryForget(owner: string, id: string, revision: number): ReturnType<CodingMemoryStore['forget']> {
    this.requireOwner(owner)
    const access = this.ownerRecordAccess(id)
    if (!access) throw new MemoryError('not_found')
    return this.forget(id, revision, access)
  }

  libraryPreview(owner: string, input: LibraryCommand): LibraryPreview {
    this.requireOwner(owner)
    const command = parse(libraryCommandSchema, input)
    const rollback = {}
    let preview: LibraryPreview | undefined
    try {
      this.transaction(() => {
        const version = this.libraryVersion()
        const effects = this.runLibraryCommand(owner, command, false)
        if (Buffer.byteLength(JSON.stringify(effects), 'utf8') > 256_000) throw new MemoryError('preview_too_large')
        preview = { version, command, effects }
        throw rollback
      })
    } catch (error) { if (error !== rollback) throw error }
    return preview!
  }

  /** The transport spends a person-only capability, then commits exactly the previewed snapshot. */
  libraryApply(owner: string, input: LibraryCommand, expected: LibraryPage['version'], enabled: boolean): LibraryPreview['effects'] {
    this.requireOwner(owner)
    const command = parse(libraryCommandSchema, input)
    return this.transaction(() => {
      if (canonical(expected) !== canonical(this.libraryVersion())) throw new MemoryError('preview_changed')
      return this.runLibraryCommand(owner, command, enabled)
    })
  }

  private runLibraryCommand(owner: string, command: LibraryCommand, enabled: boolean): LibraryPreview['effects'] {
    switch (command.kind) {
      case 'correct': return { record: summarize(this.libraryCorrect(owner, command.id, command.revision, command.fields, command.supersede)) }
      case 'forget': return this.libraryForget(owner, command.id, command.revision)
      case 'narrow': return this.libraryNarrow(owner, command.id, command.revision, command.projectId)
      case 'feedback': {
        const access = this.ownerRecordAccess(command.id)
        if (!access) throw new MemoryError('not_found')
        const record = this.requireRecord(command.id, command.revision, access)
        if (record.state !== 'active' || !this.current(record)) throw new MemoryError('recall_unavailable')
        return { feedback: this.receipts.feedback(record.id, record.revision, command.receiptId, command.value, command.expected) }
      }
      case 'configure': return { preferences: this.changePreferences(command.preferences, command.expected, enabled) }
    }
  }

  private requireOwner(owner: string): void {
    if (owner !== this.profileId) throw new MemoryError('scope_denied')
  }

  private libraryVersion(): LibraryPage['version'] {
    return { generation: this.controls().generation,
      knowledge: Number(this.db.prepare("SELECT value FROM memory_meta WHERE key='knowledge_epoch'").get()!.value),
      preferences: digest(this.preferences()) }
  }

  private ownerRecordAccess(id: string): MemoryAccess | null {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(id)) throw new MemoryError('invalid_input')
    const row = this.db.prepare('SELECT data FROM memories WHERE id=?').get(id)
    if (!row) return null
    const { profileId, projectId, taskId, branchId } = this.record(row).scope
    return { profileId, projectIds: projectId ? [projectId] : [], includeProfile: true, taskId, branchId }
  }

  recall(request: RecallRequest, access: MemoryAccess): RecallPacket {
    if (access.profileId !== this.profileId) return EMPTY('denied')
    if (!this.controls().recall) return EMPTY('off')
    if (typeof request.query !== 'string') throw new MemoryError('invalid_input')
    if (request.format !== undefined && !['summary', 'source_excerpts'].includes(request.format)) throw new MemoryError('invalid_input')
    const actual = parse(conditionsSchema, request.conditions ?? {})
    const excluded = request.excludeIds ?? []
    if (!Array.isArray(excluded) || excluded.length > 1_000 || excluded.some(id => typeof id !== 'string' || id.length > 200)) throw new MemoryError('invalid_input')
    const terms = [...new Set(request.query.slice(0, 4_000).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])]
      .filter(word => word.length >= 2 && !STOP_WORDS.has(word)).slice(0, 16)
    if (!terms.length) return EMPTY()
    const filter = this.scopeFilter(access)
    const now = this.now()
    const specific = this.scopeFilter(access, 'specific')
    // Quoted tokens contain no FTS operators. Scope/state filtering happens before candidate limiting.
    // Drive the join from FTS once. A scope-index-first plan reruns MATCH for every project row
    // (measured at ~160 ms for 10k rows); the fixed join order still filters access before LIMIT.
    const rows = this.db.prepare(`WITH context(actual) AS (VALUES (?))
      SELECT m.id,m.revision,m.data,bm25(memory_fts, 4, 1, 3) AS lexical_rank FROM memory_fts CROSS JOIN memories m ON m.rowid = memory_fts.rowid
      WHERE memory_fts MATCH ? AND m.state = 'active' AND ${filter.sql}
      AND ${visibleEvidenceSql()}
      AND ${applicabilitySql("json_extract(m.data, '$.applicability')")}
      AND NOT EXISTS (SELECT 1 FROM json_each(m.data, '$.exceptions') exception
        WHERE ${applicabilitySql("json_extract(exception.value, '$.when')")})
      AND (json_extract(m.data, '$.validity.validFrom') IS NULL OR json_extract(m.data, '$.validity.validFrom') <= ?)
      AND (json_extract(m.data, '$.validity.validUntil') IS NULL OR json_extract(m.data, '$.validity.validUntil') > ?)
      AND NOT EXISTS (SELECT 1 FROM memories specific WHERE specific.conflict_key=m.conflict_key
        AND specific.state IN ('active','needs_verification') AND ${specific.sql}
        AND (m.project_id IS NULL OR m.project_id=specific.project_id)
        AND (m.task_id IS NULL OR m.task_id=specific.task_id)
        AND (m.branch_id IS NULL OR m.branch_id=specific.branch_id)
        AND ((m.project_id IS NULL AND specific.project_id IS NOT NULL)
          OR (m.task_id IS NULL AND specific.task_id IS NOT NULL) OR (m.branch_id IS NULL AND specific.branch_id IS NOT NULL))
        AND ${visibleEvidenceSql('specific')}
        AND ${applicabilitySql("json_extract(specific.data, '$.applicability')")}
        AND NOT EXISTS (SELECT 1 FROM json_each(specific.data, '$.exceptions') specific_exception
          WHERE ${applicabilitySql("json_extract(specific_exception.value, '$.when')")})
        AND (json_extract(specific.data,'$.validity.validFrom') IS NULL OR json_extract(specific.data,'$.validity.validFrom')<=?)
        AND (json_extract(specific.data,'$.validity.validUntil') IS NULL OR json_extract(specific.data,'$.validity.validUntil')>?))
      ${excluded.length ? `AND m.id NOT IN (${excluded.map(() => '?').join(',')})` : ''}
      ORDER BY bm25(memory_fts, 4, 1, 3), m.rowid DESC LIMIT 120`)
      .all(JSON.stringify(actual), terms.map(term => `"${term}"`).join(' OR '), ...filter.params, now, now, ...specific.params, now, now, ...excluded)
    const utility = this.receipts.usefulness(rows.map(row => ({ id: String(row.id), revision: Number(row.revision) })), access, actual)
    if (utility.size) {
      const score = (row: Record<string, unknown>) => Number(row.lexical_rank) * (1 + (utility.get(String(row.id)) ?? 0))
      rows.sort((left, right) => score(left) - score(right))
    }
    const packet = EMPTY()
    const sourceSelections: SourceRecallSelection[] = []
    const maxBytes = bounded(request.maxBytes, 3_000, 0, 16_000)
    const maxItems = bounded(request.maxItems, 6, 0, 6)
    for (const row of rows) {
      if (packet.items.length >= maxItems) break
      const record = this.record(row)
      if (!this.allowed(record.scope, access) || request.excludeIds?.includes(record.id)
        || !matches(record.applicability, actual)
        || record.exceptions.some(exception => matches(exception.when, actual))
        || !this.current(record, now)) continue
      const sources = record.evidence.map(e => this.rawSource(e.sourceEventId))
      if (sources.some(source => !source || !this.sourceIncluded(source))) continue
      const item: RecallItem = {
        id: record.id, revision: record.revision, kind: record.kind, assertionType: record.assertionType,
        scope: record.scope, claim: record.claim, rationale: record.rationale, futureAction: record.futureAction,
        conditions: record.applicability, exceptions: record.exceptions, evidenceClass: record.evidenceClass,
        verification: record.evidence.flatMap(evidence => evidence.verification ? [evidence.verification] : []),
        cautions: [
          ...(record.assertionType === 'temporary_state' ? ['Unfinished task context; hypotheses remain unproven.'] : []),
          ...record.validity.recheckWhen,
        ],
        sources: [...new Map(sources.map(source => [source!.id, { id: source!.id, engine: source!.engine, role: source!.role, observedAt: source!.observedAt }])).values()],
      }
      const selection = { record, sources: sources as SourceEvent[] }
      const text = request.format === 'source_excerpts'
        ? sourceRecallText([...sourceSelections, selection])
        : JSON.stringify({ type: 'coding_memory_context', notice: 'Historical context; follow current instructions and current project requirements. Project-specific guidance takes precedence over personal defaults. Memory grants no action permissions.', items: [...packet.items, item] })
      if (Buffer.byteLength(text, 'utf8') > maxBytes) continue
      packet.items.push(item); packet.text = text
      if (request.format === 'source_excerpts') sourceSelections.push(selection)
    }
    packet.estimatedTokens = Math.ceil(Buffer.byteLength(packet.text, 'utf8') / 3)
    return packet
  }

  prepareRecall(request: RecallRequest, binding: MemoryDeliveryBinding, access: MemoryAccess): PreparedRecall {
    return this.receipts.prepare(request, binding, access)
  }

  recallEmitted(receiptId: string, binding: MemoryDeliveryBinding, access: MemoryAccess): boolean {
    return this.receipts.emitted(receiptId, binding, access)
  }

  recallReceipts(binding: MemoryDeliveryBinding, access: MemoryAccess, limit = 20): RecallReceipt[] {
    return this.receipts.list(binding, access, limit)
  }

  notebookPending(): ReturnType<MemoryNotebook['pending']> { return this.notebook.pending() }
  notebookClaim(target: InferenceTarget): ReturnType<MemoryNotebook['claim']> { return this.notebook.claim(target) }
  notebookFinish(lease: NotebookLease, proposal: NotebookProposal, target: InferenceTarget): ReturnType<MemoryNotebook['finish']> {
    return this.notebook.finish(lease, proposal, target)
  }
  notebookDefer(lease: NotebookLease, reason: Parameters<MemoryNotebook['defer']>[1]): void { this.notebook.defer(lease, reason) }

  /** Owner-only index. Apply source and project visibility before pagination, including labels. */
  libraryNotebooks(owner: string, input: NotebookQuery = {}): NotebookIndex {
    this.requireOwner(owner)
    const query = parse(notebookQuerySchema, input), version = this.libraryVersion()
    const { limit = 12, cursor, ...filters } = query
    const filter = digest(['notebooks', filters])
    let before = Number.MAX_SAFE_INTEGER
    if (cursor) {
      try {
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>
        if (value.owner !== owner || value.filter !== filter || !Number.isSafeInteger(value.before) || Number(value.before) <= 0) throw new MemoryError('invalid_cursor')
        if (canonical(value.version) !== canonical(version)) throw new MemoryError('page_changed')
        before = Number(value.before)
      } catch (error) { throw error instanceof MemoryError ? error : new MemoryError('invalid_cursor') }
    }
    const rows = this.db.prepare(`SELECT j.rowid,j.* FROM memory_notebook_jobs j
      JOIN projects p ON p.id=j.project_id AND p.included=1 WHERE j.rowid<?
      ${query.projectId ? 'AND j.project_id=?' : ''}
      AND EXISTS (SELECT 1 FROM memories m WHERE m.scope_key=j.scope_key AND json_extract(m.data,'$.facet')=j.facet
        AND m.state IN ('active','tentative','needs_verification') AND ${visibleEvidenceSql()})
      ORDER BY j.rowid DESC LIMIT ?`).all(before, ...(query.projectId ? [query.projectId] : []), limit + 1)
    const page = rows.slice(0, limit)
    return { items: page.map(row => this.notebookSummary(row)), version,
      nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ owner, filter, version, before: Number(page.at(-1)!.rowid) })).toString('base64url') : null }
  }

  libraryNotebook(owner: string, id: string): NotebookDetail | null {
    this.requireOwner(owner)
    const row = this.db.prepare(`SELECT j.* FROM memory_notebook_jobs j JOIN projects p ON p.id=j.project_id AND p.included=1
      WHERE j.id=? AND EXISTS (SELECT 1 FROM memories m WHERE m.scope_key=j.scope_key AND json_extract(m.data,'$.facet')=j.facet
        AND m.state IN ('active','tentative','needs_verification') AND ${visibleEvidenceSql()})`).get(id)
    if (!row) return null
    const summary = this.notebookSummary(row), access = this.notebookAccess(summary.scope)
    const explanation = this.topic(id, access)
    const ids = new Set(explanation?.statements.flatMap(statement => statement.supports.map(support => support.memoryId)) ?? [])
    return { summary, explanation, supporting: [...ids].map(id => summarize(this.read(id, access)!)),
      memories: this.libraryPage(owner, { topicId: id, limit: 20 }) }
  }

  private notebookAccess(scope: MemoryScope): MemoryAccess {
    return { profileId: this.profileId, projectIds: scope.projectId ? [scope.projectId] : [], includeProfile: false,
      ...(scope.taskId ? { taskId: scope.taskId } : {}), ...(scope.branchId ? { branchId: scope.branchId } : {}) }
  }

  private notebookSummary(row: Record<string, unknown>): NotebookSummary {
    const scope = JSON.parse(String(row.scope_key)) as MemoryScope
    const input = this.notebookInputs(scope, String(row.facet))
    const page = this.topic(String(row.id), this.notebookAccess(scope))
    return { id: String(row.id), title: String(row.facet).replace(/[_.:-]+/g, ' ').replace(/^./, letter => letter.toUpperCase()).slice(0, 120),
      scope, project: this.projectLabel(scope.projectId!),
      state: row.state === 'ready' && !page ? 'queued' : row.state as NotebookSummary['state'], updatedAt: page?.updatedAt ?? null,
      activeRecords: input.total, unresolvedRecords: input.unresolved,
      supportingRecords: new Set(page?.statements.flatMap(statement => statement.supports.map(support => support.memoryId)) ?? []).size }
  }

  private notebookInputs(scope: MemoryScope, facet: string): NotebookInput {
    const empty: NotebookInput = { records: [], total: 0, unresolved: 0, nextChangeAt: null }
    if (scope.profileId !== this.profileId || !scope.projectId || !this.included(scope.projectId)) return empty
    const now = this.now(), params = [canonical(scope), facet]
    const common = `m.scope_key=? AND json_extract(m.data,'$.facet')=? AND ${visibleEvidenceSql()}`
    const current = `(json_extract(m.data,'$.validity.validFrom') IS NULL OR json_extract(m.data,'$.validity.validFrom')<=?)
      AND (json_extract(m.data,'$.validity.validUntil') IS NULL OR json_extract(m.data,'$.validity.validUntil')>?)`
    const counts = this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN m.state='active' THEN 1 ELSE 0 END),0) AS total,
      COALESCE(SUM(CASE WHEN m.state IN ('tentative','needs_verification') THEN 1 ELSE 0 END),0) AS unresolved
      FROM memories m WHERE ${common} AND ${current}`).get(...params, now, now)!
    const boundary = this.db.prepare(`SELECT MIN(at) AS at FROM (
      SELECT json_extract(m.data,'$.validity.validFrom') AS at FROM memories m WHERE ${common}
        AND m.state IN ('active','tentative','needs_verification') AND json_extract(m.data,'$.validity.validFrom')>?
      UNION ALL SELECT json_extract(m.data,'$.validity.validUntil') AS at FROM memories m WHERE ${common}
        AND m.state IN ('active','tentative','needs_verification') AND json_extract(m.data,'$.validity.validUntil')>?)`)
      .get(...params, now, ...params, now)!.at
    const rows = this.db.prepare(`SELECT m.data FROM memories m WHERE ${common} AND m.state='active' AND ${current}
      ORDER BY json_extract(m.data,'$.updatedAt') DESC,m.rowid DESC LIMIT 24`).all(...params, now, now)
    let bytes = 0
    const records: MemoryRecord[] = []
    for (const row of rows) {
      const size = Buffer.byteLength(String(row.data))
      if (bytes + size > 48_000) continue
      records.push(this.record(row)); bytes += size
    }
    return { records, total: Number(counts.total), unresolved: Number(counts.unresolved),
      nextChangeAt: boundary == null ? null : Number(boundary) }
  }

  putTopic(input: TopicDraft, access: MemoryAccess, expectedRevision = 0, expectedGeneration = this.controls().generation): TopicPage {
    const draft = parse(topicSchema, input)
    assertSafe(draft)
    return this.transaction(() => {
      this.assertWritable(draft.scope, access, expectedGeneration)
      const dependencies = new Map<string, number>()
      for (const statement of draft.statements) for (const support of statement.supports) {
        const parent = this.read(support.memoryId, access)
        if (!parent || parent.state !== 'active' || parent.revision !== support.revision || !this.current(parent)) throw new MemoryError('stale_dependency')
        for (const key of ['profileId', 'projectId', 'taskId', 'branchId'] as const) {
          if (parent.scope[key] !== undefined && parent.scope[key] !== draft.scope[key]) throw new MemoryError('dependency_scope')
        }
        if (support.paths.some(path => !hasPointer(parent, path))) throw new MemoryError('evidence_path')
        dependencies.set(parent.id, parent.revision)
      }
      const previous = this.db.prepare('SELECT revision, scope_key FROM topics WHERE id = ?').get(draft.id)
      if (previous && !this.allowed(JSON.parse(String(previous.scope_key)) as MemoryScope, access)) throw new MemoryError('not_found')
      if (Number(previous?.revision ?? 0) !== expectedRevision) throw new MemoryError('revision_conflict')
      const page: TopicPage = { ...draft, revision: Number(previous?.revision ?? 0) + 1, updatedAt: this.now(),
        statements: draft.statements.map(statement => ({ ...statement,
          constraints: statement.supports.map(support => {
            const parent = this.read(support.memoryId, access)!
            return { memoryId: parent.id, applicability: parent.applicability, exceptions: parent.exceptions, validity: parent.validity }
          }),
        })) }
      this.db.prepare('INSERT INTO topics(id, revision, project_id, scope_key, data) VALUES(?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, project_id=excluded.project_id, scope_key=excluded.scope_key, data=excluded.data')
        .run(page.id, page.revision, page.scope.projectId ?? null, canonical(page.scope), JSON.stringify(page))
      this.db.prepare('DELETE FROM topic_dependencies WHERE topic_id = ?').run(page.id)
      for (const [memoryId, revision] of dependencies) this.db.prepare('INSERT INTO topic_dependencies(topic_id, memory_id, revision) VALUES(?, ?, ?)').run(page.id, memoryId, revision)
      this.bumpKnowledgeEpoch()
      return page
    })
  }

  topic(id: string, access: MemoryAccess): TopicPage | null {
    const notebook = this.db.prepare('SELECT state,available_at FROM memory_notebook_jobs WHERE id=?').get(id)
    if (notebook && (notebook.state !== 'ready' || (Number(notebook.available_at) > 0 && Number(notebook.available_at) <= this.now()))) return null
    const row = this.db.prepare('SELECT data FROM topics WHERE id = ?').get(id)
    if (!row || row.data === null) return null
    const page = JSON.parse(String(row.data)) as TopicPage
    if (!this.allowed(page.scope, access)) return null
    for (const statement of page.statements) for (const support of statement.supports) {
      const parent = this.read(support.memoryId, access)
      if (!parent || parent.state !== 'active' || parent.revision !== support.revision || !this.current(parent)) return null
    }
    return page
  }

  forget(id: string, expectedRevision: number, access: MemoryAccess): { deletedIds: string[]; deletedTopicIds: string[]; alreadyDeliveredContent: 'not_erased' } {
    return this.transaction(() => {
      this.requireRecord(id, expectedRevision, access, true)
      const affected = this.forgetDependencies(id)
      const sourceIds = new Set<string>()
      const topicIds = new Set<string>()
      for (const record of affected) {
        for (const row of this.db.prepare(`SELECT source_id FROM evidence WHERE memory_id = ?
          UNION SELECT source_id FROM source_dependencies WHERE memory_id = ?
          UNION SELECT source_id FROM memory_support WHERE memory_id = ?`).all(record.id, record.id, record.id)) sourceIds.add(String(row.source_id))
        for (const row of this.db.prepare('SELECT topic_id FROM topic_dependencies WHERE memory_id = ?').all(record.id)) topicIds.add(String(row.topic_id))
      }
      for (const sourceId of sourceIds) {
        const source = this.rawSource(sourceId)
        for (const root of [sourceId, ...(source?.rootIds ?? [])]) this.db.prepare('INSERT OR IGNORE INTO suppressed_sources(key, at) VALUES(?, ?)').run(this.suppressionKey(root), this.now())
      }
      this.learning.invalidateSources(sourceIds)
      for (const record of affected) {
        this.invalidateTopics(record.id)
        this.notebook.changed(record)
        this.db.prepare('DELETE FROM memory_fts WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)').run(record.id)
        this.db.prepare('DELETE FROM memories WHERE id = ?').run(record.id)
        this.db.prepare('INSERT INTO tombstones(id, last_revision, at) VALUES(?, ?, ?)').run(record.id, record.revision, this.now())
      }
      this.notebook.pruneEmpty()
      this.bumpKnowledgeEpoch()
      for (const sourceId of sourceIds) {
        const quotes = this.db.prepare('SELECT quote FROM evidence WHERE source_id = ? UNION SELECT quote FROM memory_support WHERE source_id = ?')
          .all(sourceId, sourceId).map(row => String(row.quote))
        if (!quotes.length) this.db.prepare('DELETE FROM sources WHERE id = ?').run(sourceId)
        else {
          // Shared events retain only the evidence spans still owned by remaining records.
          const source = this.rawSource(sourceId)!
          source.text = retainExcerpts(source.text, quotes)
          source.retention = 'evidence_only'
          this.db.prepare('UPDATE sources SET data = ? WHERE id = ?').run(JSON.stringify(source), sourceId)
        }
      }
      return { deletedIds: affected.map(record => record.id), deletedTopicIds: [...topicIds], alreadyDeliveredContent: 'not_erased' as const }
    })
  }

  private included(projectId: string | null | undefined): boolean {
    return projectId == null || this.db.prepare('SELECT included FROM projects WHERE id = ?').get(projectId)?.included === 1
  }

  private sourceIncluded(source: SourceEvent): boolean {
    if (!this.included(source.projectId) || !this.sessionPolicy(source.engine, source.sessionId).included) return false
    return source.rootIds.every(id => {
      if (id === source.id) return true
      const root = this.rawSource(id)
      return !!root && this.included(root.projectId) && this.sessionPolicy(root.engine, root.sessionId).included
    })
  }

  private evidenceIncluded(record: MemoryRecord): boolean {
    return record.evidence.every(evidence => {
      const source = this.rawSource(evidence.sourceEventId)
      return !!source && this.sourceIncluded(source)
    })
  }

  private cancelHiddenSources(): void {
    this.learning.invalidateSources(this.db.prepare('SELECT DISTINCT s.data FROM memory_job_sources j JOIN sources s ON s.id=j.source_id').all()
      .map(row => JSON.parse(String(row.data)) as SourceEvent).filter(source => !this.sourceIncluded(source)).map(source => source.id))
  }

  private reconcileVisibleConflicts(): void {
    const candidates = this.db.prepare(`SELECT m.id FROM memories m WHERE m.state='active' AND EXISTS
      (SELECT 1 FROM memories peer WHERE peer.scope_key=m.scope_key AND peer.conflict_key=m.conflict_key
        AND peer.id!=m.id AND peer.state IN ('active','needs_verification'))`).all()
    for (const { id } of candidates) {
      const record = this.record(this.db.prepare('SELECT data FROM memories WHERE id=?').get(id)!)
      if (record.state !== 'active' || !this.evidenceIncluded(record)) continue
      this.withholdConflicts(record)
      if (record.state !== 'active') this.writeRecord({ ...record, revision: record.revision + 1, updatedAt: this.now() })
    }
  }

  private locatorKey(locator: ProjectLocator): string {
    if (!['git_common_directory', 'directory'].includes(locator.kind) || !isAbsolute(locator.path)
      || locator.path.length > 4096 || /[\x00-\x1f\x7f]/.test(locator.path)) throw new MemoryError('invalid_locator')
    return digest([locator.kind, locator.path])
  }

  private current(record: MemoryRecord, now = this.now()): boolean {
    return (record.validity.validFrom === null || record.validity.validFrom <= now)
      && (record.validity.validUntil === null || record.validity.validUntil > now)
  }

  private allowed(scope: MemoryScope, access: MemoryAccess): boolean {
    return scope.profileId === this.profileId && canAccess(scope, access) && this.included(scope.projectId)
  }

  private rawSource(id: string): SourceEvent | null {
    const row = this.db.prepare('SELECT data FROM sources WHERE id = ?').get(id)
    return row ? JSON.parse(String(row.data)) as SourceEvent : null
  }

  private suppressionKey(root: string): string { return digest([this.profileId, root]) }
  private isSuppressed(source: Pick<SourceEvent, 'id' | 'rootIds'>): boolean {
    return [source.id, ...source.rootIds].some(root => !!this.db.prepare('SELECT key FROM suppressed_sources WHERE key = ?').get(this.suppressionKey(root)))
  }

  private validateEvidence(draft: MemoryDraft): MemoryState {
    const sources = new Map<string, SourceEvent>()
    for (const evidence of draft.evidence) {
      if (this.isSuppressed({ id: evidence.sourceEventId, rootIds: [] })) throw new MemoryError('source_suppressed')
      const source = this.rawSource(evidence.sourceEventId)
      if (!source) throw new MemoryError('evidence_missing')
      if (this.isSuppressed(source)) throw new MemoryError('source_suppressed')
      if (!this.sourceIncluded(source)) throw new MemoryError('source_ineligible')
      for (const dependency of source.derivedFrom ?? []) {
        const row = this.db.prepare('SELECT data FROM memories WHERE id = ?').get(dependency.memoryId)
        const parent = row ? this.record(row) : null
        if (!parent || parent.revision !== dependency.revision || parent.state !== 'active' || !this.current(parent)) throw new MemoryError('stale_dependency')
      }
      sources.set(source.id, source)
    }
    return admission(draft, sources)
  }

  private assertWritable(scope: MemoryScope, access: MemoryAccess, generation: number, userAction = false): void {
    if (!this.allowed(scope, access)) throw new MemoryError('scope_denied')
    const controls = this.controls()
    if (!userAction && !controls.learn) throw new MemoryError('learning_off')
    if (controls.generation !== generation) throw new MemoryError('generation_changed')
  }

  private requireRecord(id: string, revision: number, access: MemoryAccess, allowExcluded = false): MemoryRecord {
    const row = this.db.prepare('SELECT data FROM memories WHERE id = ?').get(id)
    const record = row ? this.record(row) : null
    if (!record || record.scope.profileId !== this.profileId || !canAccess(record.scope, access)
      || (!allowExcluded && (!this.included(record.scope.projectId) || !this.evidenceIncluded(record)))) throw new MemoryError('not_found')
    if (record.revision !== revision) throw new MemoryError('revision_conflict')
    return record
  }

  private withholdConflicts(record: MemoryRecord): MemoryRecord[] {
    if (record.state !== 'active') return []
    const peers = this.db.prepare("SELECT data FROM memories WHERE scope_key = ? AND conflict_key = ? AND id != ? AND state IN ('active', 'needs_verification')")
      .all(canonical(record.scope), record.conflictKey, record.id).map(row => this.record(row))
      .filter(peer => this.evidenceIncluded(peer) && peer.claim !== record.claim && conditionsOverlap(peer.applicability, record.applicability))
    if (!peers.length) return []
    record.state = 'needs_verification'
    for (const peer of peers) {
      if (peer.state === 'needs_verification') continue
      peer.revision++
      peer.state = 'needs_verification'
      peer.updatedAt = this.now()
      this.writeRecord(peer)
    }
    return peers
  }

  private writeRecord(record: MemoryRecord, invalidateDescendants = true): void {
    const old = this.db.prepare('SELECT data FROM memories WHERE id=?').get(record.id)
    const previous = old ? this.record(old) : null
    this.bumpKnowledgeEpoch()
    this.invalidateTopics(record.id)
    this.db.prepare(`INSERT INTO memories(id, revision, project_id, task_id, branch_id, scope_key, conflict_key, state, fingerprint, data)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,
      project_id=excluded.project_id, task_id=excluded.task_id, branch_id=excluded.branch_id, scope_key=excluded.scope_key,
      conflict_key=excluded.conflict_key, state=excluded.state, fingerprint=excluded.fingerprint, data=excluded.data`)
      .run(record.id, record.revision, record.scope.projectId ?? null, record.scope.taskId ?? null, record.scope.branchId ?? null,
        canonical(record.scope), record.conflictKey, record.state, proposalFingerprint(asDraft(record)), JSON.stringify(record))
    this.db.prepare('INSERT INTO revisions(memory_id, revision, data) VALUES(?, ?, ?)').run(record.id, record.revision, JSON.stringify(record))
    for (const evidence of record.evidence) this.db.prepare('INSERT OR IGNORE INTO evidence(memory_id, revision, source_id, quote) VALUES(?, ?, ?, ?)')
      .run(record.id, record.revision, evidence.sourceEventId, evidence.quote)
    const rowid = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(record.id)!.rowid
    this.db.prepare('DELETE FROM memory_fts WHERE rowid = ?').run(rowid)
    if (record.state === 'active') this.db.prepare('INSERT INTO memory_fts(rowid, claim, rationale, cues) VALUES(?, ?, ?, ?)')
      .run(rowid, record.claim, record.rationale, record.retrievalCues.join(' '))
    if (previous && (canonical(previous.scope) !== canonical(record.scope) || previous.facet !== record.facet)) this.notebook.changed(previous)
    this.notebook.changed(record)
    if (invalidateDescendants) {
      // Follow only the evidence of each current record, not obsolete historical dependencies.
      // UNION terminates even when successive revisions form a cycle between record identities.
      const descendants = this.db.prepare(`WITH RECURSIVE affected(id) AS (
        SELECT e.memory_id FROM source_dependencies d JOIN evidence e ON e.source_id = d.source_id
          JOIN memories m ON m.id = e.memory_id AND m.revision = e.revision
          WHERE d.memory_id = ? AND d.revision != ?
        UNION SELECT e.memory_id FROM affected a JOIN source_dependencies d ON d.memory_id = a.id
          JOIN evidence e ON e.source_id = d.source_id JOIN memories m ON m.id = e.memory_id AND m.revision = e.revision
      ) SELECT m.data FROM affected a JOIN memories m ON m.id = a.id WHERE m.id != ?`).all(record.id, record.revision, record.id)
      for (const row of descendants) {
        const dependent = this.record(row)
        if (!['active', 'tentative'].includes(dependent.state)) continue
        this.writeRecord({ ...dependent, revision: dependent.revision + 1, state: 'needs_verification', updatedAt: this.now() }, false)
      }
    }
  }

  private recordSupport(record: MemoryRecord, draft: MemoryDraft): void {
    if (['inferred', 'imported'].includes(draft.evidenceClass)) return
    let changed = false
    for (const evidence of draft.evidence) {
      if (!evidence.paths.includes('/claim')) continue
      const source = this.rawSource(evidence.sourceEventId)!
      const kind = source.role === 'user' ? 'user_statement'
        : source.role === 'tool' && evidence.verification ? 'verified_observation' : null
      // Derived summaries and assistant repetitions never create independent confirmation.
      if (!kind || source.derivedFrom) continue
      for (const root of source.rootIds) {
        const result = this.db.prepare(`INSERT OR IGNORE INTO memory_support
          (memory_id, fingerprint, root_id, source_id, quote, kind, session_key, observed_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(record.id, proposalFingerprint(draft), root, source.id, evidence.quote, kind,
            digest([source.engine, source.sessionId]), source.observedAt) as { changes: number | bigint }
        if (Number(result.changes) > 0) changed = true
      }
    }
    // Independent support can connect overlapping evidence and expand a future forget operation,
    // without revising the meaning. Replayed roots do not change that dependency snapshot.
    if (changed) this.bumpKnowledgeEpoch()
  }

  private invalidateLearning(previous: MemoryRecord): void {
    this.learning.invalidateSources([...previous.evidence.map(evidence => evidence.sourceEventId),
      ...this.db.prepare('SELECT source_id FROM memory_support WHERE memory_id=? AND fingerprint=?')
        .all(previous.id, proposalFingerprint(asDraft(previous))).map(row => String(row.source_id)),
    ])
  }

  private forgetDependencies(id: string): MemoryRecord[] {
    const pending = [id]
    const affected = new Map<string, MemoryRecord>()
    while (pending.length) {
      const current = pending.pop()!
      if (affected.has(current)) continue
      const row = this.db.prepare('SELECT data FROM memories WHERE id = ?').get(current)
      if (!row) continue
      affected.set(current, this.record(row))
      for (const dependent of this.db.prepare(`SELECT DISTINCT e.memory_id FROM source_dependencies d
        JOIN evidence e ON e.source_id = d.source_id WHERE d.memory_id = ?`).all(current)) pending.push(String(dependent.memory_id))
      for (const owned of this.db.prepare(`SELECT source_id, quote FROM evidence WHERE memory_id = ?
        UNION SELECT source_id, quote FROM memory_support WHERE memory_id = ?`).all(current, current)) {
        const source = this.rawSource(String(owned.source_id))
        if (!source) continue
        for (const shared of this.db.prepare(`SELECT memory_id, quote FROM evidence WHERE source_id = ?
          UNION SELECT memory_id, quote FROM memory_support WHERE source_id = ?`).all(owned.source_id, owned.source_id)) {
          // A broad quote can contain forgotten knowledge even when its record has a different claim.
          // Conservatively forget that dependent record rather than preserve the deleted excerpt.
          if (quotesOverlap(source.text, String(owned.quote), String(shared.quote))) pending.push(String(shared.memory_id))
        }
      }
    }
    return [...affected.values()]
  }

  private invalidateTopics(memoryId: string): void {
    this.db.prepare('UPDATE topics SET data = NULL WHERE id IN (SELECT topic_id FROM topic_dependencies WHERE memory_id = ?)').run(memoryId)
  }

  /** Separate from capture consent: a batch may publish several records under one learning lease. */
  private bumpKnowledgeEpoch(): void {
    this.db.exec("UPDATE memory_meta SET value=CAST(value AS INTEGER)+1 WHERE key='knowledge_epoch'")
  }

  private scopeFilter(access: MemoryAccess, alias = 'm'): { sql: string; params: unknown[] } {
    if (access.projectIds.length > 1_000) throw new MemoryError('scope_too_broad')
    const clauses: string[] = []
    const params: unknown[] = []
    if (access.includeProfile) clauses.push(`${alias}.project_id IS NULL`)
    if (access.projectIds.length) {
      clauses.push(`(${alias}.project_id IN (${access.projectIds.map(() => '?').join(',')}) AND ${alias}.project_id IN (SELECT id FROM projects WHERE included = 1))`)
      params.push(...access.projectIds)
    }
    return { sql: `(${clauses.join(' OR ') || '0'}) AND (${alias}.task_id IS NULL OR ${alias}.task_id = ?) AND (${alias}.branch_id IS NULL OR ${alias}.branch_id = ?)`, params: [...params, access.taskId ?? null, access.branchId ?? null] }
  }

  private record(row: Record<string, unknown>): MemoryRecord { return JSON.parse(String(row.data)) as MemoryRecord }

  private transaction<T>(operation: () => T): T {
    const level = this.transactionDepth
    this.db.exec(level ? `SAVEPOINT memory_${level}` : 'BEGIN IMMEDIATE')
    this.transactionDepth++
    try {
      const result = operation()
      this.db.exec(level ? `RELEASE memory_${level}` : 'COMMIT')
      return result
    } catch (error) {
      try { this.db.exec(level ? `ROLLBACK TO memory_${level}; RELEASE memory_${level}` : 'ROLLBACK') } catch { /* Original failure is more useful. */ }
      throw error
    } finally {
      this.transactionDepth--
    }
  }
}

function retainExcerpts(text: string, quotes: string[]): string {
  const spans = quotes.map(quote => {
    const start = text.indexOf(quote)
    if (start < 0) throw new MemoryError('evidence_mismatch')
    return { start, end: start + quote.length }
  }).sort((a, b) => a.start - b.start)
  const merged: Array<{ start: number; end: number }> = []
  for (const span of spans) {
    const previous = merged.at(-1)
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end)
    else merged.push({ ...span })
  }
  // A one-character separator never expands the original source size. Each exact evidence span
  // survives; the retention marker makes clear that surrounding conversation text was removed.
  return merged.map(span => text.slice(span.start, span.end)).join('\n')
}

/** Same scalar/array overlap semantics as matches(), applied before the candidate limit. */
function applicabilitySql(required: string): string {
  return `NOT EXISTS (SELECT 1 FROM json_each(${required}) requirement WHERE NOT EXISTS (
    SELECT 1 FROM json_each((SELECT actual FROM context)) actual WHERE actual.key = requirement.key AND CASE
      WHEN requirement.type = 'array' AND actual.type = 'array' THEN EXISTS (
        SELECT 1 FROM json_each(requirement.value) r, json_each(actual.value) a WHERE r.type = a.type AND r.value = a.value)
      WHEN requirement.type = 'array' THEN EXISTS (
        SELECT 1 FROM json_each(requirement.value) r WHERE r.type = actual.type AND r.value = actual.value)
      WHEN actual.type = 'array' THEN EXISTS (
        SELECT 1 FROM json_each(actual.value) a WHERE a.type = requirement.type AND a.value = requirement.value)
      ELSE requirement.type = actual.type AND requirement.value = actual.value END))`
}

function asDraft(record: MemoryRecord): MemoryDraft {
  const { schemaVersion: _schema, id: _id, revision: _revision, state: _state, createdAt: _created, updatedAt: _updated, ...draft } = record
  return draft
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback
}

function quotesOverlap(text: string, first: string, second: string): boolean {
  for (let a = text.indexOf(first); a !== -1; a = text.indexOf(first, a + 1)) {
    // An overlapping occurrence starts no earlier than this and ends after a.
    const b = text.indexOf(second, Math.max(0, a - second.length + 1))
    if (b !== -1 && b < a + first.length) return true
  }
  return false
}
