/** Content-free transport evidence. Printing a hook packet is not proof that a model received it. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { digest } from './admission.js'
import type { Database } from './database.js'
import { visibleEvidenceSql } from './visibility.js'
import { MemoryError, parse, type Conditions, type MemoryAccess, type MemoryRecord, type RecallPacket, type RecallRequest } from './types.js'

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/)
const bindingSchema = z.object({ engine: z.enum(['claude', 'codex', 'opencode']), sessionId: id, projectId: id.nullable(),
  route: z.enum(['prompt_hook', 'mcp', 'manual']) }).strict()
/** Always constructed from the authenticated host session, never copied from agent arguments. */
export type MemoryDeliveryBinding = z.infer<typeof bindingSchema>
export interface RecallReceipt {
  id: string
  route: MemoryDeliveryBinding['route']
  preparedAt: number
  emittedAt: number | null
  delivery: 'unverified'
  queryDigest: string
  contextDigest: string
  packetDigest: string
  bytes: number
  estimatedTokens: number
  items: Array<{ id: string; revision: number; current: boolean }>
}
export interface PreparedRecall { packet: RecallPacket; receipt: RecallReceipt | null }
export type RecallFeedbackValue = 'helpful' | 'unhelpful' | null
export interface RecallFeedback { value: RecallFeedbackValue; version: number; updatedAt: number | null }
/** Owner-only context. It must never be included in an agent recall packet or receipt. */
export interface MemoryRecallUse {
  receiptId: string; revision: number; engine: MemoryDeliveryBinding['engine']; projectId: string | null
  route: MemoryDeliveryBinding['route']; preparedAt: number; emittedAt: number | null; delivery: 'unverified'
  feedback: RecallFeedback
  canGuideRecall: boolean
}
/** Ephemeral host identities are supplied by the runtime, never persisted in activity rows. */
export const activityReceiversSchema = z.array(z.object({ agentId: id,
  engine: z.enum(['claude', 'codex', 'opencode']), sessionId: id }).strict()).max(128)
export type ActivityReceiver = z.infer<typeof activityReceiversSchema>[number]
export interface RecallActivity {
  agentId: string; engine: MemoryDeliveryBinding['engine']; projectId: string | null
  preparedAt: number; status: RecallPacket['status']; selectedCount: number
  receiptId: string | null; emittedAt: number | null; delivery: 'unverified'
}
interface Deps {
  db: Database; profileId: string; now(): number
  transaction<T>(run: () => T): T
  recall(request: RecallRequest, access: MemoryAccess): RecallPacket
  read(id: string, access: MemoryAccess): MemoryRecord | null
  allowed(binding: MemoryDeliveryBinding, access: MemoryAccess): boolean
}
const RETENTION_MS = 30 * 86_400_000
const MAX_RECEIPTS = 5_000
export const RECEIPT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_receipts (
    id TEXT PRIMARY KEY, binding_key TEXT NOT NULL, prepared_at INTEGER NOT NULL, emitted_at INTEGER,
    route TEXT NOT NULL, query_digest TEXT NOT NULL, context_digest TEXT NOT NULL, packet_digest TEXT NOT NULL,
    bytes INTEGER NOT NULL, estimated_tokens INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memory_receipts_binding ON memory_receipts(binding_key, prepared_at);
  CREATE INDEX IF NOT EXISTS memory_receipts_age ON memory_receipts(prepared_at);
  CREATE TABLE IF NOT EXISTS memory_receipt_items (
    receipt_id TEXT NOT NULL REFERENCES memory_receipts(id) ON DELETE CASCADE,
    memory_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(receipt_id,memory_id)
  );
  CREATE INDEX IF NOT EXISTS memory_receipt_revisions ON memory_receipt_items(memory_id,revision);
  CREATE TABLE IF NOT EXISTS memory_receipt_context (
    receipt_id TEXT PRIMARY KEY REFERENCES memory_receipts(id) ON DELETE CASCADE,
    context_key TEXT NOT NULL, session_key TEXT NOT NULL, engine TEXT NOT NULL, project_id TEXT
  );
  CREATE INDEX IF NOT EXISTS memory_receipt_session ON memory_receipt_context(session_key);
  CREATE TABLE IF NOT EXISTS memory_receipt_relevance (
    receipt_id TEXT PRIMARY KEY REFERENCES memory_receipt_context(receipt_id) ON DELETE CASCADE,
    relevance_key TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memory_recall_feedback (
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
    context_key TEXT NOT NULL, receipt_id TEXT NOT NULL REFERENCES memory_receipt_context(receipt_id) ON DELETE CASCADE,
    value TEXT CHECK(value IN ('helpful','unhelpful')), version INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(memory_id,revision,context_key)
  );
  CREATE INDEX IF NOT EXISTS memory_feedback_receipt ON memory_recall_feedback(receipt_id);
  CREATE TABLE IF NOT EXISTS memory_recall_latest (
    session_key TEXT PRIMARY KEY, engine TEXT NOT NULL, project_id TEXT,
    prepared_at INTEGER NOT NULL, status TEXT NOT NULL, selected_count INTEGER NOT NULL,
    receipt_id TEXT REFERENCES memory_receipts(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS memory_recall_latest_age ON memory_recall_latest(prepared_at);
`

export class MemoryReceipts {
  constructor(private readonly deps: Deps) {}

  prepare(request: RecallRequest, input: MemoryDeliveryBinding, access: MemoryAccess): PreparedRecall {
    const binding = parse(bindingSchema, input)
    return this.deps.transaction(() => {
      if (!this.deps.allowed(binding, access)) return { packet: empty('denied'), receipt: null }
      const finish = (packet: RecallPacket, receipt: RecallReceipt | null): PreparedRecall => {
        // One content-free latest attempt per native session, including empty/off recalls.
        // Without this marker a later empty result would leave an earlier selection looking current.
        this.deps.db.prepare(`INSERT INTO memory_recall_latest VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(session_key) DO UPDATE SET engine=excluded.engine,project_id=excluded.project_id,
            prepared_at=excluded.prepared_at,status=excluded.status,selected_count=excluded.selected_count,
            receipt_id=excluded.receipt_id`).run(this.sessionKey(binding.engine, binding.sessionId), binding.engine,
            binding.projectId, this.deps.now(), packet.status, packet.items.length, receipt?.id ?? null)
        this.prune()
        return { packet, receipt }
      }
      // Reserve the receipt field inside the same byte budget as the actual context. Empty recalls
      // do not allocate audit rows, and neither raw prompts nor recalled claims are stored here.
      const budget = typeof request.maxBytes === 'number' && Number.isFinite(request.maxBytes)
        ? Math.min(16_000, Math.max(0, Math.trunc(request.maxBytes))) : 3_000
      const withdrawn = this.withdrawn(binding)
      const withdrawal = withdrawn.references.length ? { withdrawn,
        withdrawalNotice: 'These previously supplied memory revisions are no longer current. Do not rely on them. If more is true, use only newly supplied memory. Earlier native conversation content has not been erased.' } : {}
      const reserved = 64 + Buffer.byteLength(JSON.stringify(withdrawal))
      const packet = this.deps.recall({ ...request, maxBytes: Math.max(0, budget - reserved) }, access)
      if (packet.status !== 'ok' || (!packet.items.length && !withdrawn.references.length) || reserved > budget) return finish(packet, null)
      const receiptId = randomUUID()
      packet.text = JSON.stringify({ ...(packet.text ? JSON.parse(packet.text) : { type: 'coding_memory_context', items: [] }),
        ...withdrawal, receiptId })
      const bytes = Buffer.byteLength(packet.text)
      if (bytes > budget) return finish(empty('ok'), null)
      packet.estimatedTokens = Math.ceil(bytes / 3)
      const queryDigest = digest([this.deps.profileId, request.query])
      const contextDigest = digest([this.deps.profileId, binding, access, request.conditions ?? {}])
      const packetDigest = digest(packet.text)
      const preparedAt = this.deps.now()
      this.deps.db.prepare(`INSERT INTO memory_receipts
        (id,binding_key,prepared_at,emitted_at,route,query_digest,context_digest,packet_digest,bytes,estimated_tokens)
        VALUES(?,?,?,NULL,?,?,?,?,?,?)`).run(receiptId, this.key(binding), preparedAt, binding.route,
        queryDigest, contextDigest, packetDigest, bytes, packet.estimatedTokens)
      for (const item of packet.items) this.deps.db.prepare('INSERT INTO memory_receipt_items VALUES(?,?,?)')
        .run(receiptId, item.id, item.revision)
      // A one-way session key lets privacy changes remove owner-visible activity without storing
      // another copy of native session identity. Route-independent context prevents duplicate votes.
      this.deps.db.prepare('INSERT INTO memory_receipt_context VALUES(?,?,?,?,?)').run(receiptId,
        digest([this.deps.profileId, binding.engine, binding.sessionId, binding.projectId,
          access.taskId ?? null, access.branchId ?? null, request.conditions ?? {}]),
        this.sessionKey(binding.engine, binding.sessionId), binding.engine, binding.projectId)
      // Compatibility across frameworks must not guess scope or conditions from legacy hashes.
      // This key excludes engine/session/route but keeps the exact receiving project and context.
      const relevance = this.relevanceKey(access, request.conditions ?? {})
      if (relevance) this.deps.db.prepare('INSERT INTO memory_receipt_relevance VALUES(?,?)').run(receiptId, relevance)
      return finish(packet, { id: receiptId, route: binding.route, preparedAt, emittedAt: null, delivery: 'unverified',
        queryDigest, contextDigest, packetDigest, bytes, estimatedTokens: packet.estimatedTokens,
        items: packet.items.map(item => ({ id: item.id, revision: item.revision, current: true })) })
    })
  }

  /** Only the verified transport's stdout/write completion may call this; there is no model-use claim. */
  emitted(receiptId: string, input: MemoryDeliveryBinding, access: MemoryAccess): boolean {
    const binding = parse(bindingSchema, input)
    if (!this.deps.allowed(binding, access)) return false
    const row = this.deps.db.prepare('SELECT emitted_at FROM memory_receipts WHERE id=? AND binding_key=? AND prepared_at>?')
      .get(receiptId, this.key(binding), this.deps.now() - RETENTION_MS)
    if (!row) return false
    if (row.emitted_at === null) this.deps.db.prepare('UPDATE memory_receipts SET emitted_at=? WHERE id=? AND emitted_at IS NULL')
      .run(this.deps.now(), receiptId)
    return true
  }

  list(input: MemoryDeliveryBinding, access: MemoryAccess, limit = 20): RecallReceipt[] {
    const binding = parse(bindingSchema, input)
    if (!this.deps.allowed(binding, access)) return []
    const count = Number.isFinite(limit) ? Math.min(100, Math.max(0, Math.trunc(limit))) : 20
    return this.deps.db.prepare(`SELECT * FROM memory_receipts WHERE binding_key=? AND prepared_at>?
      ORDER BY prepared_at DESC,rowid DESC LIMIT ?`).all(this.key(binding), this.deps.now() - RETENTION_MS, count).map(row => ({
      id: String(row.id), route: row.route as RecallReceipt['route'], preparedAt: Number(row.prepared_at),
      emittedAt: row.emitted_at === null ? null : Number(row.emitted_at), delivery: 'unverified',
      queryDigest: String(row.query_digest), contextDigest: String(row.context_digest), packetDigest: String(row.packet_digest),
      bytes: Number(row.bytes), estimatedTokens: Number(row.estimated_tokens),
      items: this.deps.db.prepare('SELECT memory_id,revision FROM memory_receipt_items WHERE receipt_id=?').all(row.id).map(item => {
        const record = this.deps.read(String(item.memory_id), access)
        return { id: String(item.memory_id), revision: Number(item.revision), current: !!record
          && record.revision === item.revision && record.state === 'active'
          && (record.validity.validFrom === null || record.validity.validFrom <= this.deps.now())
          && (record.validity.validUntil === null || record.validity.validUntil > this.deps.now()) }
      }),
    }))
  }

  /** The caller has already verified the owner and current memory's source visibility. */
  forMemory(memoryId: string, revision: number, receiptId?: string): MemoryRecallUse[] {
    // Receiver privacy applies before deduplication and the limit. Old receipts with no recorded
    // receiver context stay unavailable; migration must not guess their authority from a hash.
    return this.deps.transaction(() => this.deps.db.prepare(`WITH recent AS (
      SELECT r.id,r.route,r.prepared_at,r.emitted_at,c.context_key,c.engine,c.project_id,
        ROW_NUMBER() OVER (PARTITION BY c.context_key ORDER BY r.prepared_at DESC,r.rowid DESC) AS position
      FROM memory_receipts r JOIN memory_receipt_context c ON c.receipt_id=r.id
      JOIN memory_receipt_items i ON i.receipt_id=r.id
      WHERE i.memory_id=? AND i.revision=? AND r.prepared_at>? ${receiptId ? 'AND r.id=?' : ''}
        AND c.session_key NOT IN (SELECT value FROM json_each(?))
        AND (c.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=c.project_id AND p.included=1)))
      SELECT r.*,f.value,f.version,f.updated_at,
        EXISTS (SELECT 1 FROM memory_receipt_relevance eligibility WHERE eligibility.receipt_id=
          CASE WHEN f.value IS NULL THEN r.id ELSE f.receipt_id END) AS can_guide_recall
      FROM recent r LEFT JOIN memory_recall_feedback f
        ON f.memory_id=? AND f.revision=? AND f.context_key=r.context_key
        AND EXISTS (SELECT 1 FROM memory_receipts rated WHERE rated.id=f.receipt_id AND rated.prepared_at>?)
      WHERE r.position=1 ORDER BY r.prepared_at DESC,r.id DESC LIMIT 10`)
      .all(memoryId, revision, this.deps.now() - RETENTION_MS, ...(receiptId ? [receiptId] : []), this.privateSessionKeys(),
        memoryId, revision, this.deps.now() - RETENTION_MS).map(row => ({
        receiptId: String(row.id), revision, engine: row.engine as MemoryDeliveryBinding['engine'],
        projectId: row.project_id === null ? null : String(row.project_id), route: row.route as MemoryDeliveryBinding['route'],
        preparedAt: Number(row.prepared_at), emittedAt: row.emitted_at === null ? null : Number(row.emitted_at),
        delivery: 'unverified', feedback: feedbackFrom(row), canGuideRecall: row.can_guide_recall === 1,
      })))
  }

  /** Called only by the owner preview/apply path. A rating is neither truth support nor delivery proof. */
  feedback(memoryId: string, revision: number, receiptId: string, value: RecallFeedbackValue, expected: number): RecallFeedback {
    const context = this.deps.db.prepare(`SELECT c.context_key FROM memory_receipt_context c
      JOIN memory_receipts r ON r.id=c.receipt_id JOIN memory_receipt_items i ON i.receipt_id=r.id
      WHERE r.id=? AND i.memory_id=? AND i.revision=? AND r.prepared_at>?
        AND c.session_key NOT IN (SELECT value FROM json_each(?))
        AND (c.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=c.project_id AND p.included=1))`)
      .get(receiptId, memoryId, revision, this.deps.now() - RETENTION_MS, this.privateSessionKeys())
    if (!context) throw new MemoryError('recall_unavailable')
    const previous = feedbackFrom(this.deps.db.prepare(`SELECT f.value,f.version,f.updated_at FROM memory_recall_feedback f
      JOIN memory_receipts r ON r.id=f.receipt_id
      WHERE f.memory_id=? AND f.revision=? AND f.context_key=? AND r.prepared_at>?`)
      .get(memoryId, revision, context.context_key, this.deps.now() - RETENTION_MS))
    if (previous.version !== expected) throw new MemoryError('feedback_changed')
    if (previous.value === value) return previous
    const next = { value, version: previous.version + 1, updatedAt: this.deps.now() }
    this.deps.db.prepare(`INSERT INTO memory_recall_feedback(memory_id,revision,context_key,receipt_id,value,version,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(memory_id,revision,context_key) DO UPDATE SET
        receipt_id=excluded.receipt_id,value=excluded.value,version=excluded.version,updated_at=excluded.updated_at`)
      .run(memoryId, revision, context.context_key, receiptId, value, next.version, next.updatedAt)
    return next
  }

  /** A bounded owner-reported utility adjustment, never evidence or an eligibility override.
   * Call only for already eligible lexical candidates. No rating is inferred from repeat recall.
   * One stored rating per receiving context survives; source revisions and receiver privacy remain
   * separate gates. Missing legacy context and ambiguous multi-project requests stay neutral.
   */
  usefulness(records: Array<Pick<MemoryRecord, 'id' | 'revision'>>, access: MemoryAccess, conditions: Conditions): Map<string, number> {
    const relevance = this.relevanceKey(access, conditions)
    if (!records.length || !relevance) return new Map()
    return this.deps.transaction(() => {
      const rows = this.deps.db.prepare(`SELECT f.memory_id,
        SUM(CASE WHEN f.value='helpful' THEN 1 ELSE -1 END) AS utility, COUNT(*) AS ratings
        FROM json_each(?) candidate CROSS JOIN memory_recall_feedback f
          ON f.memory_id=json_extract(candidate.value,'$.id') AND f.revision=json_extract(candidate.value,'$.revision')
        JOIN memory_receipt_context c ON c.receipt_id=f.receipt_id
        JOIN memory_receipt_relevance eligibility ON eligibility.receipt_id=f.receipt_id AND eligibility.relevance_key=?
        JOIN memory_receipts r ON r.id=f.receipt_id
        WHERE f.value IS NOT NULL AND r.prepared_at>? AND r.prepared_at<=?
          AND c.session_key NOT IN (SELECT value FROM json_each(?))
          AND (c.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=c.project_id AND p.included=1))
        GROUP BY f.memory_id`).all(JSON.stringify(records), relevance,
          this.deps.now() - RETENTION_MS, this.deps.now(), this.privateSessionKeys())
      // Shrink sparse ratings toward neutral and cap their influence below 12.5% of lexical score.
      // This is a provisional ranking policy to evaluate, not a learned probability of correctness.
      return new Map(rows.map(row => [String(row.memory_id), .125 * Number(row.utility) / (Number(row.ratings) + 4)]))
    })
  }

  /** Keep opaque withdrawal receipts, but remove receiver activity and its feedback permanently. */
  withholdSession(engine: string, sessionId: string): void {
    this.deps.db.prepare('DELETE FROM memory_receipt_context WHERE session_key=?').run(this.sessionKey(engine, sessionId))
    this.deps.db.prepare('DELETE FROM memory_recall_latest WHERE session_key=?').run(this.sessionKey(engine, sessionId))
  }

  withholdProject(projectId: string): void {
    this.deps.db.prepare('DELETE FROM memory_receipt_context WHERE project_id=?').run(projectId)
    this.deps.db.prepare('DELETE FROM memory_recall_latest WHERE project_id=?').run(projectId)
  }

  prune(): void {
    this.deps.db.prepare('DELETE FROM memory_receipts WHERE prepared_at<=?').run(this.deps.now() - RETENTION_MS)
    this.deps.db.prepare(`DELETE FROM memory_receipts WHERE id IN
      (SELECT id FROM memory_receipts ORDER BY prepared_at DESC,rowid DESC LIMIT -1 OFFSET ?)`).run(MAX_RECEIPTS)
    this.deps.db.prepare('DELETE FROM memory_recall_latest WHERE prepared_at<=?').run(this.deps.now() - RETENTION_MS)
    this.deps.db.prepare(`DELETE FROM memory_recall_latest WHERE session_key IN
      (SELECT session_key FROM memory_recall_latest ORDER BY prepared_at DESC,rowid DESC LIMIT -1 OFFSET ?)`).run(MAX_RECEIPTS)
  }

  /** Verified owner only. Latest attempts are never reconstructed from older positive receipts. */
  activity(input: ActivityReceiver[]): RecallActivity[] {
    const receivers = parse(activityReceiversSchema, input)
    if (new Set(receivers.map(r => r.agentId)).size !== receivers.length) throw new MemoryError('invalid_input')
    const live = receivers.map(r => ({ agentId: r.agentId, key: this.sessionKey(r.engine, r.sessionId) }))
    return this.deps.db.prepare(`SELECT l.*,json_extract(live.value,'$.agentId') AS agent_id,r.emitted_at
      FROM json_each(?) live JOIN memory_recall_latest l ON l.session_key=json_extract(live.value,'$.key')
      LEFT JOIN memory_receipts r ON r.id=l.receipt_id
      WHERE l.prepared_at>? AND l.prepared_at<=?
        AND l.session_key NOT IN (SELECT value FROM json_each(?))
        AND (l.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=l.project_id AND p.included=1))
      ORDER BY l.prepared_at DESC,l.session_key`).all(JSON.stringify(live), this.deps.now() - RETENTION_MS,
        this.deps.now(), this.privateSessionKeys()).map(row => ({ agentId: String(row.agent_id),
        engine: row.engine as MemoryDeliveryBinding['engine'], projectId: row.project_id === null ? null : String(row.project_id),
        preparedAt: Number(row.prepared_at), status: row.status as RecallPacket['status'], selectedCount: Number(row.selected_count),
        receiptId: row.receipt_id === null ? null : String(row.receipt_id),
        emittedAt: row.emitted_at == null ? null : Number(row.emitted_at), delivery: 'unverified' }))
  }

  /** Current visible revisions only; corrections and privacy never expose old packet contents. */
  activityItems(receiptId: string): Array<{ id: string; revision: number }> {
    return this.deps.db.prepare(`SELECT i.memory_id,i.revision FROM memory_receipt_items i
      JOIN memories m ON m.id=i.memory_id AND m.revision=i.revision
      WHERE i.receipt_id=? AND m.state='active' AND ${visibleEvidenceSql()}
        AND (m.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=m.project_id AND p.included=1))
        AND (json_extract(m.data,'$.validity.validFrom') IS NULL OR json_extract(m.data,'$.validity.validFrom')<=?)
        AND (json_extract(m.data,'$.validity.validUntil') IS NULL OR json_extract(m.data,'$.validity.validUntil')>?)
      ORDER BY i.rowid LIMIT 6`).all(receiptId, this.deps.now(), this.deps.now())
      .map(row => ({ id: String(row.memory_id), revision: Number(row.revision) }))
  }

  private withdrawn(binding: MemoryDeliveryBinding): { references: Array<{ id: string; revision: number }>; more: boolean } {
    // This is a notice about context already prepared for this exact native session, not fresh
    // disclosure of another session's knowledge. No claim or source text is retained or repeated.
    const rows = this.deps.db.prepare(`WITH previous AS MATERIALIZED (SELECT DISTINCT i.memory_id,i.revision FROM memory_receipts r
      JOIN memory_receipt_items i ON i.receipt_id=r.id WHERE r.binding_key=? AND r.prepared_at>?)
      SELECT i.memory_id,i.revision FROM previous i LEFT JOIN memories m ON m.id=i.memory_id
      WHERE m.id IS NULL OR m.revision!=i.revision OR m.state!='active'
        OR NOT (${visibleEvidenceSql()})
        OR json_extract(m.data,'$.validity.validFrom')>?
        OR json_extract(m.data,'$.validity.validUntil')<=? LIMIT 7`)
      .all(this.key(binding), this.deps.now() - RETENTION_MS, this.deps.now(), this.deps.now())
    return { references: rows.slice(0, 6).map(row => ({ id: String(row.memory_id), revision: Number(row.revision) })), more: rows.length > 6 }
  }

  private key(binding: MemoryDeliveryBinding): string { return digest([this.deps.profileId, binding]) }
  private relevanceKey(access: MemoryAccess, conditions: Conditions): string | null {
    if (access.profileId !== this.deps.profileId || access.projectIds.length > 1) return null
    return digest(['recall-usefulness-v1', this.deps.profileId, access.projectIds[0] ?? null,
      access.taskId ?? null, access.branchId ?? null, conditions])
  }
  private sessionKey(engine: string, sessionId: string): string { return digest([this.deps.profileId, engine, sessionId]) }
  private privateSessionKeys(): string {
    // Read the original policy, including changes made by an earlier daemon version that does
    // not know about receipt context. This check and the activity read share a SQLite snapshot.
    return JSON.stringify(this.deps.db.prepare('SELECT engine,session_id FROM memory_session_policy WHERE included=0').all()
      .map(row => this.sessionKey(String(row.engine), String(row.session_id))))
  }
}

function feedbackFrom(row?: Record<string, unknown>): RecallFeedback {
  return { value: (row?.value ?? null) as RecallFeedbackValue, version: Number(row?.version ?? 0),
    updatedAt: row?.updated_at == null ? null : Number(row.updated_at) }
}

function empty(status: RecallPacket['status']): RecallPacket { return { status, items: [], text: '', estimatedTokens: 0 } }
