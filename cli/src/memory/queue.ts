/** Durable episode intake and inference leases. No provider calls or raw transcripts in job metadata. */
import { z } from 'zod'
import { digest } from './admission.js'
import { memoryCallAllowance, reserveMemoryCall, MEMORY_CALL_PURPOSE_SCHEMA } from './budget.js'
import type { Database } from './database.js'
import { inferenceWaitReason, type InferenceWaitReason } from './inferenceStatus.js'
import { MemoryError, parse, sourceSchema, type MemoryAccess, type MemoryDraft, type MemoryRecord, type SourceEvent } from './types.js'

export const QUEUE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_streams (
    id TEXT PRIMARY KEY, engine TEXT NOT NULL, session_id TEXT NOT NULL, project_id TEXT,
    cursor TEXT NOT NULL, cursor_digest TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memory_jobs (
    id TEXT PRIMARY KEY, stream_id TEXT NOT NULL REFERENCES memory_streams(id), project_id TEXT,
    state TEXT NOT NULL, priority INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
    available_at INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
    generation INTEGER, context_key TEXT, source_digest TEXT, last_error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memory_jobs_ready ON memory_jobs(state, available_at, priority, created_at);
  CREATE TABLE IF NOT EXISTS memory_job_context (
    job_id TEXT PRIMARY KEY REFERENCES memory_jobs(id) ON DELETE CASCADE,
    context TEXT NOT NULL CHECK(context='bounded')
  );
  CREATE TABLE IF NOT EXISTS memory_job_sources (
    job_id TEXT NOT NULL REFERENCES memory_jobs(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL,
    PRIMARY KEY(job_id, source_id)
  );
  CREATE INDEX IF NOT EXISTS memory_job_source ON memory_job_sources(source_id);
  CREATE TABLE IF NOT EXISTS memory_inference_calls (
    id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, context_key TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memory_calls_time ON memory_inference_calls(started_at);
  CREATE TABLE IF NOT EXISTS memory_inference_jobs (
    call_id TEXT NOT NULL REFERENCES memory_inference_calls(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL REFERENCES memory_jobs(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL,
    PRIMARY KEY(call_id, job_id)
  );
  CREATE TABLE IF NOT EXISTS memory_queue_totals (key TEXT PRIMARY KEY,value INTEGER NOT NULL);
  ${MEMORY_CALL_PURPOSE_SCHEMA}
`
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/)
const cursor = z.string().min(1).max(256)
const captureSchema = z.object({
  streamId: id, engine: id, sessionId: id, projectId: id.nullable(), episodeId: id,
  from: cursor.nullable(), to: cursor, events: z.array(sourceSchema).max(64),
  boundary: z.enum(['open', 'complete', 'bounded', 'incomplete']), priority: z.enum(['routine', 'important']).default('routine'),
  generation: z.number().int().nonnegative().optional(),
}).strict()
const checkpointSchema = captureSchema.pick({ streamId: true, engine: true, sessionId: true, projectId: true, from: true, to: true })
  .extend({ generation: z.number().int().nonnegative() }).strict()
export type CaptureBatch = z.input<typeof captureSchema>
export type JobState = 'open' | 'queued' | 'reviewing' | 'waiting_for_model' | 'budget_deferred' | 'source_incomplete'
  | 'failed' | 'learned' | 'no_useful_memory' | 'cancelled' | 'expired'
export const TERMINAL_JOB_STATES = "('learned','no_useful_memory','cancelled','expired')"
export const MAX_PENDING_EPISODES = 256
export const PENDING_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
export interface InferenceTarget {
  state: 'ready' | 'waiting' | 'off' | 'unsupported'
  /** Opaque host-derived identity of the selected account, collection, model, and effort. */
  key?: string
  /** Recognized availability code, never raw native/provider output. */
  reason?: InferenceWaitReason
  foregroundBusy?: boolean
}
export interface LearningLease {
  jobId: string; token: string; until: number; generation: number; contextKey: string
  sources: SourceEvent[]; access: MemoryAccess
  /** Explicit boundaries; the store's durable membership remains the publication authority. */
  episodes: Array<{ jobId: string; sourceIds: string[]; context: 'complete' | 'bounded' }>
}
export type ClaimResult = { state: 'claimed'; lease: LearningLease }
  | { state: 'idle' | 'learning_off' | 'foreground_busy' | 'waiting_for_model' | 'budget_deferred' | 'source_incomplete'; retryAt?: number; reason?: InferenceWaitReason }
export type FinishResult = { state: 'learned' | 'no_useful_memory'; records: MemoryRecord[] }
  | { state: 'stale' | 'failed'; reason: string }

interface QueueDeps {
  db: Database; profileId: string; now: () => number
  transaction: <T>(operation: () => T) => T
  controls: () => { learn: boolean; generation: number }
  included: (projectId: string | null) => boolean
  sessionIncluded: (engine: string, sessionId: string) => boolean
  ingest: (event: SourceEvent, generation: number) => { disposition: string }
  source: (id: string) => SourceEvent | null
  propose: (draft: MemoryDraft, access: MemoryAccess, generation: number) => { record: MemoryRecord }
  compact: (sourceIds: string[]) => void
}

const HOUR = 3_600_000
const LEASE_MS = 120_000
export const MAX_EPISODES_PER_CALL = 4
const MAX_REVIEW_SOURCES = 128
const MAX_REVIEW_SOURCE_BYTES = 96_000
const RETRYABLE = "('queued', 'waiting_for_model', 'budget_deferred', 'failed')"

export class MemoryQueue {
  constructor(private readonly deps: QueueDeps) {}

  capture(input: CaptureBatch): { disposition: 'captured' | 'duplicate'; sourceCount: number; state: JobState } {
    const batch = parse(captureSchema, input)
    const { db, now, profileId } = this.deps
    const fingerprint = digest(batch)
    return this.deps.transaction(() => {
      const controls = this.deps.controls()
      if (!controls.learn) throw new MemoryError('learning_off')
      if (batch.generation !== undefined && batch.generation !== controls.generation) throw new MemoryError('generation_changed')
      if (!this.deps.included(batch.projectId) || !this.deps.sessionIncluded(batch.engine, batch.sessionId)) throw new MemoryError('source_ineligible')
      const stream = db.prepare('SELECT * FROM memory_streams WHERE id = ?').get(batch.streamId)
      if (stream && (stream.engine !== batch.engine || stream.session_id !== batch.sessionId || stream.project_id !== batch.projectId)) throw new MemoryError('stream_identity_conflict')
      const job = db.prepare('SELECT * FROM memory_jobs WHERE id = ?').get(batch.episodeId)
      if (stream?.cursor === batch.to && stream.cursor_digest === fingerprint && job) {
        return { disposition: 'duplicate' as const, sourceCount: this.sources(batch.episodeId).length, state: job.state as JobState }
      }
      if ((stream?.cursor ?? null) !== batch.from || batch.from === batch.to) throw new MemoryError('cursor_conflict')
      if (job && (job.stream_id !== batch.streamId || !['open', 'source_incomplete'].includes(String(job.state)))) throw new MemoryError('episode_closed')
      if (!job && Number(db.prepare(`SELECT COUNT(*) AS count FROM memory_jobs WHERE state NOT IN ${TERMINAL_JOB_STATES}`).get()!.count)
        >= MAX_PENDING_EPISODES) throw new MemoryError('memory_backlog_full')
      if (batch.events.some(event => event.profileId !== profileId || event.engine !== batch.engine || event.sessionId !== batch.sessionId
        || event.projectId !== batch.projectId)) throw new MemoryError('episode_scope')
      db.prepare(`INSERT INTO memory_streams(id, engine, session_id, project_id, cursor, cursor_digest, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor, cursor_digest=excluded.cursor_digest, updated_at=excluded.updated_at`)
        .run(batch.streamId, batch.engine, batch.sessionId, batch.projectId, batch.to, fingerprint, now())
      if (!job) db.prepare(`INSERT INTO memory_jobs(id, stream_id, project_id, state, priority, created_at, updated_at)
        VALUES(?, ?, ?, 'open', ?, ?, ?)`).run(batch.episodeId, batch.streamId, batch.projectId, batch.priority === 'important' ? 1 : 0, now(), now())
      let ordinal = Number(db.prepare('SELECT COALESCE(MAX(ordinal), -1) AS n FROM memory_job_sources WHERE job_id = ?').get(batch.episodeId)!.n) + 1
      for (const event of batch.events) {
        if (['suppressed', 'retired'].includes(this.deps.ingest(event, controls.generation).disposition)) continue
        db.prepare('INSERT OR IGNORE INTO memory_job_sources(job_id, source_id, ordinal) VALUES(?, ?, ?)').run(batch.episodeId, event.id, ordinal++)
      }
      const sources = this.sources(batch.episodeId)
      commonScope(sources)
      if (sources.length > MAX_REVIEW_SOURCES || Buffer.byteLength(JSON.stringify(sources)) > MAX_REVIEW_SOURCE_BYTES) throw new MemoryError('episode_too_large')
      const state: JobState = batch.boundary === 'open' ? 'open' : batch.boundary === 'incomplete' ? 'source_incomplete'
        : sources.length ? 'queued' : 'cancelled'
      if (batch.boundary === 'bounded') db.prepare("INSERT OR IGNORE INTO memory_job_context(job_id,context) VALUES(?,'bounded')").run(batch.episodeId)
      db.prepare('UPDATE memory_jobs SET state = ?, priority = MAX(priority, ?), updated_at = ? WHERE id = ?')
        .run(state, batch.priority === 'important' ? 1 : 0, now(), batch.episodeId)
      return { disposition: 'captured' as const, sourceCount: sources.length, state }
    })
  }

  /** Advance over metadata or establish a live-only baseline without manufacturing source events. */
  checkpoint(input: z.infer<typeof checkpointSchema>): void {
    const batch = parse(checkpointSchema, input)
    this.deps.transaction(() => {
      const controls = this.deps.controls()
      if (!controls.learn) throw new MemoryError('learning_off')
      if (controls.generation !== batch.generation) throw new MemoryError('generation_changed')
      if (!this.deps.included(batch.projectId) || !this.deps.sessionIncluded(batch.engine, batch.sessionId)) throw new MemoryError('source_ineligible')
      const stream = this.deps.db.prepare('SELECT * FROM memory_streams WHERE id = ?').get(batch.streamId)
      if (stream && (stream.engine !== batch.engine || stream.session_id !== batch.sessionId || stream.project_id !== batch.projectId)) throw new MemoryError('stream_identity_conflict')
      const fingerprint = digest(batch)
      if (stream?.cursor === batch.to && stream.cursor_digest === fingerprint) return
      if ((stream?.cursor ?? null) !== batch.from || batch.from === batch.to) throw new MemoryError('cursor_conflict')
      this.deps.db.prepare(`INSERT INTO memory_streams(id, engine, session_id, project_id, cursor, cursor_digest, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor, cursor_digest=excluded.cursor_digest, updated_at=excluded.updated_at`)
        .run(batch.streamId, batch.engine, batch.sessionId, batch.projectId, batch.to, fingerprint, this.deps.now())
    })
  }

  /** Cheap local check before account lookup or any native CLI version probe. */
  pendingReview(): 'ready' | 'idle' | 'learning_off' {
    if (!this.deps.controls().learn) return 'learning_off'
    return this.nextJob() ? 'ready' : 'idle'
  }

  /** A deferred job is still waiting, not an empty queue. No native probes or source text. */
  waitingForModel(): { state: 'waiting_for_model'; reason?: InferenceWaitReason } | null {
    if (!this.deps.controls().learn) return null
    const row = this.deps.db.prepare(`SELECT j.last_error FROM memory_jobs j
      WHERE j.state='waiting_for_model' AND j.created_at>?
      AND (j.project_id IS NULL OR j.project_id IN (SELECT id FROM projects WHERE included=1))
      ORDER BY j.priority DESC,j.created_at,j.id LIMIT 1`).get(this.deps.now() - PENDING_RETENTION_MS)
    if (!row) return null
    const reason = inferenceWaitReason(row.last_error)
    return { state: 'waiting_for_model', ...(reason ? { reason } : {}) }
  }

  private nextJob(): Record<string, unknown> | undefined {
    return this.readyJobs(1)[0]
  }

  private readyJobs(limit: number, projectId?: string | null): Record<string, unknown>[] {
    const { db, now } = this.deps
    return db.prepare(`SELECT j.* FROM memory_jobs j WHERE
      ((j.state IN ${RETRYABLE} AND j.available_at<=? AND j.failures<3) OR (j.state='reviewing' AND j.lease_until<=?))
      AND j.created_at>?
      AND (j.project_id IS NULL OR j.project_id IN (SELECT id FROM projects WHERE included=1))
      AND NOT EXISTS (SELECT 1 FROM memory_jobs active WHERE active.id!=j.id AND active.project_id IS j.project_id
        AND active.state='reviewing' AND active.lease_until>?)
      ${projectId === undefined ? '' : 'AND j.project_id IS ?'}
      ORDER BY j.priority DESC,j.created_at,j.id LIMIT ?`).all(now(), now(), now() - PENDING_RETENTION_MS, now(),
        ...(projectId === undefined ? [] : [projectId]), limit)
  }

  /** Reserving a call and acquiring the project lease share one transaction. */
  claim(target: InferenceTarget): ClaimResult {
    const { db, now } = this.deps
    return this.deps.transaction(() => {
      const controls = this.deps.controls()
      if (!controls.learn) return { state: 'learning_off' as const }
      this.expire()
      if (target.foregroundBusy) return { state: 'foreground_busy' as const }
      const job = this.nextJob()
      if (!job) return { state: 'idle' as const }
      const jobId = String(job.id)
      if (target.state !== 'ready' || !target.key) {
        const reason = inferenceWaitReason(target.reason)
        this.release(jobId, 'waiting_for_model', reason ?? (target.state === 'unsupported' ? 'model_unsupported' : 'model_unavailable'), now() + 60_000)
        return { state: 'waiting_for_model' as const, ...(reason ? { reason } : {}) }
      }
      const usage = memoryCallAllowance(db, now())
      if (usage.retryAt !== null) {
        const retryAt = usage.retryAt
        this.release(jobId, 'budget_deferred', 'hourly_budget', retryAt)
        return { state: 'budget_deferred' as const, retryAt }
      }
      const firstSources = this.sources(jobId)
      if (!firstSources.length) {
        this.release(jobId, 'source_incomplete', 'sources_unavailable', 0)
        return { state: 'source_incomplete' as const }
      }
      const group = [{ job, sources: firstSources }]
      const scope = commonScope(firstSources)
      let sources = firstSources
      // Failed batches retry individually. Scan a bounded window, never a whole transcript archive.
      if (Number(job.failures) === 0) for (const candidate of this.readyJobs(16, job.project_id as string | null)) {
        if (group.length >= MAX_EPISODES_PER_CALL) break
        if (candidate.id === job.id || Number(candidate.failures) !== 0) continue
        const candidateSources = this.sources(String(candidate.id))
        if (!candidateSources.length) {
          this.release(String(candidate.id), 'source_incomplete', 'sources_unavailable', 0)
          continue
        }
        if (digest(commonScope(candidateSources)) !== digest(scope)) continue
        const combined = uniqueSources([...sources, ...candidateSources])
        if (combined.length > MAX_REVIEW_SOURCES || Buffer.byteLength(JSON.stringify(combined)) > MAX_REVIEW_SOURCE_BYTES) continue
        group.push({ job: candidate, sources: candidateSources })
        sources = combined
      }
      const contextKey = digest(target.key)
      const token = reserveMemoryCall(db, now(), contextKey, 'extraction')
      const until = now() + LEASE_MS
      const access: MemoryAccess = { profileId: this.deps.profileId,
        projectIds: job.project_id === null ? [] : [String(job.project_id)], includeProfile: true,
        ...scope,
      }
      group.forEach((member, ordinal) => {
        db.prepare(`UPDATE memory_jobs SET state='reviewing', lease_token=?, lease_until=?, generation=?, context_key=?, source_digest=?,
          attempts=attempts+1, updated_at=?, last_error=NULL WHERE id=?`)
          .run(token, until, controls.generation, contextKey, digest(member.sources), now(), member.job.id)
        db.prepare('INSERT INTO memory_inference_jobs(call_id, job_id, ordinal) VALUES(?, ?, ?)').run(token, member.job.id, ordinal)
      })
      const episodes = group.map(member => ({ jobId: String(member.job.id), sourceIds: member.sources.map(source => source.id),
        context: this.context(String(member.job.id)) }))
      return { state: 'claimed' as const, lease: { jobId, token, until, generation: controls.generation, contextKey, sources, access, episodes } }
    })
  }

  finish(lease: LearningLease, proposals: MemoryDraft[], target: InferenceTarget): FinishResult {
    const { now } = this.deps
    return this.deps.transaction(() => {
      this.expire()
      const jobs = this.members(lease)
      const controls = this.deps.controls()
      if (!jobs.length || jobs.some(job => job.state !== 'reviewing' || job.lease_token !== lease.token)) {
        this.releaseLease(lease, 'queued', 'lease_changed', now())
        return { state: 'stale' as const, reason: 'lease_changed' }
      }
      const group = jobs.map(job => ({ job, sources: this.sources(String(job.id)) }))
      if (!controls.learn || target.state !== 'ready' || !target.key || group.some(({ job, sources }) =>
        !this.deps.included(job.project_id as string | null) || controls.generation !== job.generation
        || Number(job.lease_until) <= now() || digest(target.key!) !== job.context_key || !sources.length || digest(sources) !== job.source_digest)) {
        this.releaseLease(lease, 'queued', 'context_changed', now())
        return { state: 'stale' as const, reason: 'context_changed' }
      }
      try {
        const records = this.deps.transaction(() => {
          if (!Array.isArray(proposals) || proposals.length > 8) throw new MemoryError('invalid_proposals')
          const sources = uniqueSources(group.flatMap(member => member.sources))
          const sourceIds = new Set(sources.map(source => source.id))
          const boundedIds = new Set(group.filter(member => this.context(String(member.job.id)) === 'bounded')
            .flatMap(member => member.sources.map(source => source.id)))
          const userIds = new Set(sources.filter(source => source.role === 'user').map(source => source.id))
          const access: MemoryAccess = { profileId: this.deps.profileId,
            projectIds: jobs[0].project_id === null ? [] : [String(jobs[0].project_id)], includeProfile: true,
            ...commonScope(sources),
          }
          const records = proposals.map(proposal => {
            if (!Array.isArray(proposal?.evidence) || proposal.evidence.some(evidence => !sourceIds.has(evidence.sourceEventId))) throw new MemoryError('episode_evidence')
            // Intact statements can survive a long turn or a gap in tool output. They do not
            // establish execution outcomes or acceptance inferred from omitted conversation.
            // Read durable context here; a caller cannot upgrade a segment by editing the lease.
            if (proposal.evidence.some(evidence => boundedIds.has(evidence.sourceEventId))
              && (proposal.evidenceClass !== 'user_stated'
                || !['working_preference', 'project_decision'].includes(proposal.kind)
                || !['stated_preference', 'project_constraint', 'accepted_decision', 'learning_goal'].includes(proposal.assertionType)
                || proposal.evidence.some(evidence => !userIds.has(evidence.sourceEventId)))) throw new MemoryError('bounded_context_evidence')
            return this.deps.propose(proposal, access, controls.generation).record
          })
          const used = new Set(proposals.flatMap(proposal => proposal.evidence.map(evidence => evidence.sourceEventId)))
          for (const member of group) this.release(String(member.job.id),
            member.sources.some(source => used.has(source.id)) ? 'learned' : 'no_useful_memory', null, 0)
          this.deps.compact([...sourceIds])
          return records
        })
        const state = records.length ? 'learned' as const : 'no_useful_memory' as const
        return { state, records }
      } catch (error) {
        const reason = error instanceof MemoryError ? error.code : 'store_unavailable'
        this.releaseLease(lease, 'failed', reason, now() + 300_000)
        return { state: 'failed' as const, reason }
      }
    })
  }

  defer(lease: LearningLease, reason: 'queued' | 'waiting_for_model' | 'budget_deferred' | 'failed' | 'source_incomplete', waitReason?: InferenceWaitReason): void {
    this.deps.transaction(() => {
      const detail = reason === 'waiting_for_model' ? inferenceWaitReason(waitReason) ?? reason : reason
      this.releaseLease(lease, reason, detail, this.deps.now() + (reason === 'queued' ? 0 : reason === 'budget_deferred' ? HOUR : 60_000))
    })
  }

  cursor(streamId: string): string | null {
    return this.deps.db.prepare('SELECT cursor FROM memory_streams WHERE id = ?').get(streamId)?.cursor as string | undefined ?? null
  }

  /** An open transcript cursor may outlive its episode after correction, forgetting, or privacy. */
  episodeOpen(streamId: string, episodeId: string): boolean {
    const job = this.deps.db.prepare('SELECT stream_id,state FROM memory_jobs WHERE id=?').get(episodeId)
    return job?.stream_id === streamId && ['open', 'source_incomplete'].includes(String(job.state))
  }

  status(): { jobs: Partial<Record<JobState, number>>; oldestPendingAt: number | null; callsLastHour: number; capturedStreams: number;
    retention: { expiredEpisodes: number; lastExpiredAt: number | null; maxPendingEpisodes: number; pendingRetentionMs: number } } {
    const { db, now } = this.deps
    const counts = db.prepare('SELECT state, COUNT(*) AS count FROM memory_jobs GROUP BY state').all()
    return { jobs: Object.fromEntries(counts.map(row => [row.state, Number(row.count)])),
      oldestPendingAt: db.prepare(`SELECT MIN(created_at) AS at FROM memory_jobs WHERE state NOT IN ${TERMINAL_JOB_STATES}`).get()!.at as number | null,
      callsLastHour: Number(db.prepare('SELECT COUNT(*) AS count FROM memory_inference_calls WHERE started_at > ?').get(now() - HOUR)!.count),
      capturedStreams: Number(db.prepare('SELECT COUNT(*) AS count FROM memory_streams').get()!.count),
      retention: { expiredEpisodes: Number(db.prepare("SELECT value FROM memory_queue_totals WHERE key='expired'").get()?.value ?? 0),
        lastExpiredAt: db.prepare("SELECT value FROM memory_queue_totals WHERE key='last_expired'").get()?.value as number | undefined ?? null,
        maxPendingEpisodes: MAX_PENDING_EPISODES, pendingRetentionMs: PENDING_RETENTION_MS },
    }
  }

  /** Called by the host's maintenance pass. Expiry is a visible gap, never successful learning. */
  expire(): number {
    const cutoff = this.deps.now() - PENDING_RETENTION_MS
    const count = Number(this.deps.db.prepare(`SELECT COUNT(*) AS count FROM memory_jobs
      WHERE state NOT IN ${TERMINAL_JOB_STATES} AND created_at<=?`).get(cutoff)!.count)
    this.deps.db.prepare(`UPDATE memory_jobs SET state='expired',lease_token=NULL,lease_until=0,source_digest=NULL,
      last_error='source_retention_expired',updated_at=? WHERE state NOT IN ${TERMINAL_JOB_STATES} AND created_at<=?`)
      .run(this.deps.now(), cutoff)
    if (count) {
      this.deps.db.prepare("INSERT INTO memory_queue_totals(key,value) VALUES('expired',?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value").run(count)
      this.deps.db.prepare("INSERT INTO memory_queue_totals(key,value) VALUES('last_expired',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(this.deps.now())
    }
    return count
  }

  pruneMetadata(): void {
    this.deps.db.prepare(`DELETE FROM memory_jobs WHERE state IN ${TERMINAL_JOB_STATES} AND updated_at<?`)
      .run(this.deps.now() - 30 * 24 * HOUR)
    this.deps.db.prepare('DELETE FROM memory_inference_calls WHERE started_at<=?').run(this.deps.now() - HOUR)
  }

  /** Called inside correction/forget transactions, before any deleted input could be reused. */
  invalidateSources(sourceIds: Iterable<string>): void {
    for (const sourceId of sourceIds) this.deps.db.prepare(`UPDATE memory_jobs SET state='cancelled', lease_token=NULL, lease_until=0,
      source_digest=NULL, last_error='source_changed', updated_at=? WHERE id IN (SELECT job_id FROM memory_job_sources WHERE source_id=?)`)
      .run(this.deps.now(), sourceId)
  }

  private sources(jobId: string): SourceEvent[] {
    const sources = this.deps.db.prepare('SELECT source_id FROM memory_job_sources WHERE job_id = ? ORDER BY ordinal').all(jobId)
      .map(row => this.deps.source(String(row.source_id)))
    // Never quietly turn a partly private or missing episode into a different conversation.
    return sources.every((source): source is SourceEvent => source !== null) ? sources : []
  }

  private context(jobId: string): 'complete' | 'bounded' {
    return this.deps.db.prepare('SELECT context FROM memory_job_context WHERE job_id=?').get(jobId) ? 'bounded' : 'complete'
  }

  private members(lease: LearningLease): Record<string, unknown>[] {
    const jobs = this.deps.db.prepare(`SELECT j.* FROM memory_inference_jobs m JOIN memory_jobs j ON j.id=m.job_id
      WHERE m.call_id=? ORDER BY m.ordinal`).all(lease.token)
    return jobs[0]?.id === lease.jobId ? jobs : []
  }

  private releaseLease(lease: LearningLease, state: JobState, error: string | null, availableAt: number): void {
    for (const job of this.members(lease)) {
      if (job.state === 'reviewing' && job.lease_token === lease.token) this.release(String(job.id), state, error, availableAt)
    }
  }

  private release(id: string, state: JobState, error: string | null, availableAt: number): void {
    this.deps.db.prepare(`UPDATE memory_jobs SET state=?, last_error=?, available_at=?, lease_token=NULL, lease_until=0,
      source_digest=NULL, failures=CASE WHEN ?='failed' THEN failures+1 ELSE 0 END, updated_at=? WHERE id=?`)
      .run(state, error, availableAt, state, this.deps.now(), id)
  }
}

function uniqueSources(sources: SourceEvent[]): SourceEvent[] {
  return [...new Map(sources.map(source => [source.id, source])).values()]
}

function commonScope(sources: SourceEvent[]): { taskId?: string; branchId?: string } {
  const result: { taskId?: string; branchId?: string } = {}
  for (const key of ['taskId', 'branchId'] as const) {
    const values = new Set(sources.map(source => source[key]).filter(Boolean))
    if (values.size > 1) throw new MemoryError('episode_scope')
    if (values.size === 1) result[key] = [...values][0]
  }
  return result
}
