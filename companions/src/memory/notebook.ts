/** Derived project pages. Jobs retain references and hashes, never another copy of source prose. */
import { z } from 'zod'
import { canonical, digest } from './admission.js'
import { memoryCallAllowance, reserveMemoryCall, MAX_MEMORY_CALLS } from './budget.js'
import type { Database } from './database.js'
import type { InferenceTarget } from './queue.js'
import { inferenceWaitReason, type InferenceWaitReason } from './inferenceStatus.js'
import { hasPointer, MemoryError, parse, topicSchema, type MemoryAccess, type MemoryRecord, type MemoryScope, type TopicDraft, type TopicPage } from './types.js'

export const NOTEBOOK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_notebook_jobs (
    id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, project_id TEXT NOT NULL, facet TEXT NOT NULL,
    version INTEGER NOT NULL, state TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
    available_at INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
    generation INTEGER, context_key TEXT, input_digest TEXT, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memory_notebook_ready ON memory_notebook_jobs(state,available_at,updated_at);
  CREATE INDEX IF NOT EXISTS memory_notebook_records ON memories(scope_key,json_extract(data,'$.facet'),state);
  CREATE TABLE IF NOT EXISTS memory_notebook_waits (
    job_id TEXT PRIMARY KEY REFERENCES memory_notebook_jobs(id) ON DELETE CASCADE,
    job_version INTEGER NOT NULL, job_updated_at INTEGER NOT NULL, reason TEXT NOT NULL
  );
`

// Wait metadata is additive for existing stores. Its job version and timestamp
// prevent an older writer from attaching a previous reason to revised work.

export const notebookProposalSchema = z.object({ statements: z.array(topicSchema.shape.statements.element).max(24) }).strict()
export type NotebookProposal = z.infer<typeof notebookProposalSchema>
export interface NotebookInput {
  records: MemoryRecord[]
  /** Includes current records omitted by the bounded input; never implies a complete project account. */
  total: number
  /** Visible tentative/conflicted records stay outside generated assertions. */
  unresolved: number
  nextChangeAt: number | null
}
export interface NotebookLease {
  id: string; token: string; version: number; generation: number; contextKey: string
  scope: MemoryScope; facet: string; input: NotebookInput
}
export type NotebookState = 'queued' | 'reviewing' | 'ready' | 'empty' | 'waiting_for_model' | 'budget_deferred' | 'failed'
export type NotebookClaim = { state: 'claimed'; lease: NotebookLease }
  | { state: 'idle' | 'learning_off' | 'foreground_busy' | 'waiting_for_model' | 'budget_deferred'; retryAt?: number; reason?: InferenceWaitReason }
export interface NotebookPending {
  state: 'ready' | 'idle' | 'learning_off' | 'indexing' | 'waiting_for_model' | 'budget_deferred'
  prefer: boolean
  reason?: InferenceWaitReason
}
interface Deps {
  db: Database; profileId: string; now(): number
  transaction<T>(run: () => T): T
  controls(): { learn: boolean; generation: number }
  inputs(scope: MemoryScope, facet: string): NotebookInput
  putTopic(draft: TopicDraft, access: MemoryAccess, revision: number, generation: number): TopicPage
}
const HOUR = 3_600_000
const LEASE_MS = 120_000
const key = (scope: MemoryScope, facet: string) => `notebook:${digest([scope, facet])}`
const title = (facet: string) => facet.replace(/[_.:-]+/g, ' ').replace(/^./, value => value.toUpperCase()).slice(0, 120)
const access = (scope: MemoryScope): MemoryAccess => ({ profileId: scope.profileId,
  projectIds: scope.projectId ? [scope.projectId] : [], includeProfile: false,
  ...(scope.taskId ? { taskId: scope.taskId } : {}), ...(scope.branchId ? { branchId: scope.branchId } : {}) })

export class MemoryNotebook {
  constructor(private readonly deps: Deps) {}

  /** Runs in the same transaction as a record change. Any earlier synthesis loses its lease. */
  changed(record: MemoryRecord): void {
    if (!record.scope.projectId) return
    const { db, now } = this.deps
    const id = key(record.scope, record.facet)
    db.prepare(`INSERT INTO memory_notebook_jobs(id,scope_key,project_id,facet,version,state,updated_at)
      VALUES(?,?,?,?,1,'queued',?) ON CONFLICT(id) DO UPDATE SET
        version=version+1,state='queued',failures=0,available_at=0,lease_token=NULL,lease_until=0,
        input_digest=NULL,updated_at=excluded.updated_at`)
      .run(id, canonical(record.scope), record.scope.projectId, record.facet, now())
    db.prepare('UPDATE topics SET data=NULL WHERE id=?').run(id)
    db.prepare('DELETE FROM memory_notebook_waits WHERE job_id=?').run(id)
  }

  /** Privacy can change without revising a memory. A new page must use a fresh visible snapshot. */
  invalidate(): void {
    this.deps.db.prepare(`UPDATE memory_notebook_jobs SET version=version+1,state='queued',failures=0,
      available_at=0,lease_token=NULL,lease_until=0,input_digest=NULL,updated_at=?`).run(this.deps.now())
    this.deps.db.exec('DELETE FROM memory_notebook_waits')
  }

  /** Forgetting the last record in a group also removes its derived index metadata. */
  pruneEmpty(): void {
    const rows = this.deps.db.prepare(`SELECT j.id FROM memory_notebook_jobs j WHERE NOT EXISTS
      (SELECT 1 FROM memories m WHERE m.scope_key=j.scope_key AND json_extract(m.data,'$.facet')=j.facet)`).all()
    for (const row of rows) {
      this.deps.db.prepare('DELETE FROM topics WHERE id=?').run(row.id)
      this.deps.db.prepare('DELETE FROM memory_notebook_jobs WHERE id=?').run(row.id)
    }
  }

  /** Migrate existing records in bounded worker-sized chunks, without holding up opening the DB. */
  private discover(): boolean {
    const rowid = Number(this.deps.db.prepare("SELECT value FROM memory_meta WHERE key='notebook_cursor'").get()?.value ?? 0)
    const rows = this.deps.db.prepare('SELECT rowid,data FROM memories WHERE rowid>? ORDER BY rowid LIMIT 50').all(rowid)
    for (const row of rows) this.changed(JSON.parse(String(row.data)) as MemoryRecord)
    if (rows.length) this.deps.db.prepare("INSERT INTO memory_meta(key,value) VALUES('notebook_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(String(rows.at(-1)!.rowid))
    return rows.length === 50
  }

  pending(): NotebookPending {
    return this.deps.transaction(() => {
      if (!this.deps.controls().learn) return { state: 'learning_off', prefer: false }
      const indexing = this.discover()
      if (indexing) return { state: 'indexing', prefer: false }
      const row = this.next()
      if (!row) return this.deferred() ?? { state: 'idle', prefer: false }
      const usage = memoryCallAllowance(this.deps.db, this.deps.now())
      if (usage.retryAt !== null) {
        this.deps.db.prepare('UPDATE topics SET data=NULL WHERE id=?').run(row.id)
        this.release(String(row.id), 'budget_deferred', usage.retryAt)
        return { state: 'budget_deferred', prefer: false }
      }
      // Completed episodes normally go first. Keep one of the existing six calls available for
      // a pending notebook so sustained coding cannot starve every derived explanation forever.
      return { state: 'ready', prefer: usage.count === MAX_MEMORY_CALLS - 1 && usage.notebookCalls === 0 }
    })
  }

  /** A retry delay is unfinished work. Read its status without probing a model. */
  private deferred(): NotebookPending | null {
    const { db, now } = this.deps
    for (let scanned = 0; scanned < 8; scanned++) {
      const row = db.prepare(`SELECT j.*,w.reason FROM memory_notebook_jobs j
        JOIN projects p ON p.id=j.project_id AND p.included=1
        LEFT JOIN memory_notebook_waits w ON w.job_id=j.id AND w.job_version=j.version
          AND w.job_updated_at=j.updated_at
        WHERE j.state IN ('waiting_for_model','budget_deferred') AND j.available_at>? AND j.failures<3
        ORDER BY CASE j.state WHEN 'waiting_for_model' THEN 0 ELSE 1 END,j.updated_at,j.id LIMIT 1`).get(now())
      if (!row) return null
      const input = this.deps.inputs(JSON.parse(String(row.scope_key)) as MemoryScope, String(row.facet))
      if (!input.records.length) {
        db.prepare('UPDATE topics SET data=NULL WHERE id=?').run(row.id)
        this.release(String(row.id), 'empty', input.nextChangeAt ?? 0)
        continue
      }
      const reason = row.state === 'waiting_for_model' ? inferenceWaitReason(row.reason) : undefined
      return { state: row.state as 'waiting_for_model' | 'budget_deferred', prefer: false,
        ...(reason ? { reason } : {}) }
    }
    return null
  }

  private next(): Record<string, unknown> | undefined {
    const { db, now } = this.deps
    for (let scanned = 0; scanned < 8; scanned++) {
      const row = db.prepare(`SELECT j.* FROM memory_notebook_jobs j JOIN projects p ON p.id=j.project_id AND p.included=1
      WHERE (((j.state IN ('queued','waiting_for_model','budget_deferred','failed') AND j.failures<3)
        OR (j.state IN ('ready','empty') AND j.available_at>0)) AND j.available_at<=?
        OR (j.state='ready' AND NOT EXISTS (SELECT 1 FROM topics t WHERE t.id=j.id AND t.data IS NOT NULL))
        OR (j.state='reviewing' AND j.lease_until<=?))
      AND NOT EXISTS (SELECT 1 FROM memory_jobs active WHERE active.project_id=j.project_id
        AND active.state='reviewing' AND active.lease_until>?)
      AND NOT EXISTS (SELECT 1 FROM memory_notebook_jobs active WHERE active.id!=j.id
        AND active.state='reviewing' AND active.lease_until>?)
      ORDER BY j.updated_at,j.id LIMIT 1`).get(now(), now(), now(), now())
      if (!row) return
      const input = this.deps.inputs(JSON.parse(String(row.scope_key)) as MemoryScope, String(row.facet))
      if (input.records.length) return row
      db.prepare('UPDATE topics SET data=NULL WHERE id=?').run(row.id)
      this.release(String(row.id), 'empty', input.nextChangeAt ?? 0)
    }
  }

  claim(target: InferenceTarget): NotebookClaim {
    return this.deps.transaction(() => {
      const { db, now } = this.deps
      const controls = this.deps.controls()
      if (!controls.learn) return { state: 'learning_off' as const }
      if (target.foregroundBusy) return { state: 'foreground_busy' as const }
      const row = this.next()
      if (!row) return { state: 'idle' as const }
      const scope = JSON.parse(String(row.scope_key)) as MemoryScope
      const input = this.deps.inputs(scope, String(row.facet))
      db.prepare('UPDATE topics SET data=NULL WHERE id=?').run(row.id)
      if (!input.records.length) {
        this.release(String(row.id), 'empty', input.nextChangeAt ?? 0)
        return { state: 'idle' as const }
      }
      if (target.state !== 'ready' || !target.key) {
        const reason = inferenceWaitReason(target.reason)
        this.release(String(row.id), 'waiting_for_model', now() + 60_000, reason)
        return { state: 'waiting_for_model' as const, ...(reason ? { reason } : {}) }
      }
      const usage = memoryCallAllowance(db, now())
      if (usage.retryAt !== null) {
        this.release(String(row.id), 'budget_deferred', usage.retryAt)
        return { state: 'budget_deferred' as const, retryAt: usage.retryAt }
      }
      const contextKey = digest(target.key)
      const token = reserveMemoryCall(db, now(), contextKey, 'notebook')
      db.prepare('DELETE FROM memory_notebook_waits WHERE job_id=?').run(row.id)
      db.prepare(`UPDATE memory_notebook_jobs SET state='reviewing',lease_token=?,lease_until=?,generation=?,
        context_key=?,input_digest=?,updated_at=? WHERE id=?`)
        .run(token, now() + LEASE_MS, controls.generation, contextKey, digest(input), now(), row.id)
      return { state: 'claimed' as const, lease: { id: String(row.id), token, version: Number(row.version),
        generation: controls.generation, contextKey, scope, facet: String(row.facet), input } }
    })
  }

  finish(lease: NotebookLease, output: NotebookProposal, target: InferenceTarget): { state: 'ready' | 'empty' | 'stale'; topicId?: string } {
    return this.deps.transaction(() => {
      const { db, now } = this.deps
      const row = db.prepare('SELECT * FROM memory_notebook_jobs WHERE id=?').get(lease.id)
      if (!row || row.state !== 'reviewing' || row.lease_token !== lease.token) return { state: 'stale' as const }
      const scope = JSON.parse(String(row.scope_key)) as MemoryScope
      const input = this.deps.inputs(scope, String(row.facet))
      const controls = this.deps.controls()
      if (!controls.learn || controls.generation !== row.generation || Number(row.lease_until) <= now()
        || target.state !== 'ready' || !target.key || digest(target.key) !== row.context_key
        || digest(input) !== row.input_digest || Number(row.version) !== lease.version) {
        this.release(lease.id, 'queued', now())
        return { state: 'stale' as const }
      }
      const proposal = parse(notebookProposalSchema, output)
      const inputs = new Map(input.records.map(record => [record.id, record]))
      for (const statement of proposal.statements) for (const support of statement.supports) {
        const parent = inputs.get(support.memoryId)
        if (parent?.revision !== support.revision) throw new MemoryError('notebook_dependency')
        // Identity/timestamps cannot support a substantive explanation. This checks structural
        // provenance only; faithful paraphrasing still needs the independent model-quality review.
        if (support.paths.some(path => !/^\/(claim|rationale|futureAction|applicability|exceptions|details|validity)(\/|$)/.test(path)
          || !hasPointer(parent, path))) throw new MemoryError('evidence_path')
      }
      if (proposal.statements.length) {
        const revision = Number(db.prepare('SELECT revision FROM topics WHERE id=?').get(row.id)?.revision ?? 0)
        this.deps.putTopic({ id: String(row.id), scope, title: title(String(row.facet)), statements: proposal.statements },
          access(scope), revision, controls.generation)
      }
      const state = proposal.statements.length ? 'ready' as const : 'empty' as const
      this.release(lease.id, state, input.nextChangeAt ?? 0)
      return { state, ...(state === 'ready' ? { topicId: lease.id } : {}) }
    })
  }

  defer(lease: NotebookLease, reason: 'queued' | 'waiting_for_model' | 'budget_deferred' | 'failed', waitReason?: InferenceWaitReason): void {
    this.deps.transaction(() => {
      const row = this.deps.db.prepare('SELECT state,lease_token FROM memory_notebook_jobs WHERE id=?').get(lease.id)
      if (row?.state !== 'reviewing' || row.lease_token !== lease.token) return
      if (reason === 'failed') this.deps.db.prepare('UPDATE memory_notebook_jobs SET failures=failures+1 WHERE id=?').run(lease.id)
      this.release(lease.id, reason, this.deps.now() + (reason === 'queued' ? 0 : reason === 'budget_deferred' ? HOUR : 60_000), waitReason)
    })
  }

  private release(id: string, state: NotebookState, at: number, waitReason?: InferenceWaitReason): void {
    const { db, now } = this.deps
    db.prepare(`UPDATE memory_notebook_jobs SET state=?,available_at=?,lease_token=NULL,
      lease_until=0,input_digest=NULL,updated_at=? WHERE id=?`).run(state, at, now(), id)
    db.prepare('DELETE FROM memory_notebook_waits WHERE job_id=?').run(id)
    const reason = state === 'waiting_for_model' ? inferenceWaitReason(waitReason) : undefined
    if (reason) db.prepare(`INSERT INTO memory_notebook_waits(job_id,job_version,job_updated_at,reason)
      SELECT id,version,updated_at,? FROM memory_notebook_jobs WHERE id=?`).run(reason, id)
  }
}
