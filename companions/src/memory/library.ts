/** Owner-facing library contracts. These are not model tools or scope capabilities. */
import { z } from 'zod'
import { conditionsSchema, draftSchema, type MemoryRecord, type MemoryScope, type MemorySupport, type SourceEvent } from './types.js'
import type { MemoryRecallUse, RecallFeedback, RecallActivity } from './receipts.js'
import type { NotebookState } from './notebook.js'
import type { TopicPage } from './types.js'

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/)
export const libraryQuerySchema = z.object({
  cursor: z.string().max(2_000).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  scope: z.enum(['all', 'personal', 'project']).optional(),
  projectId: id.optional(),
  topicId: id.optional(),
  state: z.enum(['active', 'tentative', 'needs_verification', 'superseded', 'archived']).optional(),
}).strict()
export type LibraryQuery = z.infer<typeof libraryQuerySchema>
export const libraryActivityQuerySchema = z.object({ agentId: id.optional() }).strict()
export type LibraryActivityQuery = z.infer<typeof libraryActivityQuerySchema>
export interface LibraryActivity {
  sessions: Array<Omit<RecallActivity, 'projectId'> & { project: LibraryProject | null }>
  selectedAgentId: string | null
  items: Array<{ record: MemorySummary & Pick<MemoryRecord, 'applicability' | 'rationale' | 'futureAction' | 'exceptions'>
    recall: LibraryDetail['recalls'][number] }>
  version: LibraryPage['version']
}
export const libraryProjectQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  before: z.number().int().positive().safe().optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).strict()
export type LibraryProjectQuery = z.infer<typeof libraryProjectQuerySchema>
export interface LibraryProject { id: string; name: string; location: string | null }
export interface LibraryProjects { items: LibraryProject[]; nextBefore: number | null }
export const notebookQuerySchema = z.object({
  projectId: id.optional(), cursor: z.string().max(2_000).optional(), limit: z.number().int().min(1).max(20).optional(),
}).strict()
export type NotebookQuery = z.infer<typeof notebookQuerySchema>
export interface NotebookSummary {
  id: string; title: string; scope: MemoryScope; project: LibraryProject
  state: NotebookState; updatedAt: number | null
  activeRecords: number; unresolvedRecords: number; supportingRecords: number
}
export interface NotebookIndex {
  items: NotebookSummary[]; nextCursor: string | null; version: LibraryPage['version']
}
export interface NotebookDetail {
  summary: NotebookSummary; explanation: TopicPage | null
  supporting: MemorySummary[]; memories: LibraryPage
}

export type MemorySummary = Pick<MemoryRecord,
  'id' | 'revision' | 'state' | 'scope' | 'kind' | 'facet' | 'assertionType' | 'claim' | 'evidenceClass' | 'createdAt' | 'updatedAt'>
export interface LibraryPage {
  items: MemorySummary[]
  nextCursor: string | null
  /** Privacy and corrections invalidate a page cursor rather than mixing two snapshots. */
  version: { generation: number; knowledge: number; preferences: string }
}
export interface LibraryDetail {
  record: MemoryRecord
  support: MemorySupport | null
  sources: Array<Pick<SourceEvent, 'id' | 'engine' | 'sessionId' | 'role' | 'observedAt'>>
  scopeChanges: ScopeChange[]
  project: LibraryProject | null
  recalls: Array<Omit<MemoryRecallUse, 'projectId'> & { project: LibraryProject | null; canFeedback: boolean }>
}
export interface ScopeChange { revision: number; from: MemoryScope; to: MemoryScope; changedAt: number; actor: 'owner' }

/** Scope, evidence, verification, identity and conflict keys cannot be rewritten by a form payload. */
export const correctionSchema = z.object({
  claim: z.string().trim().min(1).max(2_000),
  rationale: z.string().trim().min(1).max(2_000).nullable(),
  futureAction: z.string().trim().min(1).max(2_000),
  applicability: conditionsSchema,
  exceptions: draftSchema.shape.exceptions,
  retrievalCues: draftSchema.shape.retrievalCues,
  validity: draftSchema.shape.validity,
  details: draftSchema.shape.details,
}).strict()
export type MemoryCorrection = z.infer<typeof correctionSchema>

const revision = z.number().int().positive().safe()
const preferences = z.object({ learn: z.boolean(), recall: z.boolean() }).strict()
export const libraryCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('correct'), id, revision, fields: correctionSchema,
    supersede: z.array(z.object({ id, revision }).strict()).max(32).optional() }).strict(),
  z.object({ kind: z.literal('forget'), id, revision }).strict(),
  z.object({ kind: z.literal('narrow'), id, revision, projectId: id }).strict(),
  z.object({ kind: z.literal('feedback'), id, revision, receiptId: id,
    value: z.enum(['helpful', 'unhelpful']).nullable(), expected: z.number().int().nonnegative().safe() }).strict(),
  z.object({ kind: z.literal('configure'), preferences, expected: preferences }).strict(),
])
export type LibraryCommand = z.infer<typeof libraryCommandSchema>
export interface LibraryPreview {
  version: LibraryPage['version']
  command: LibraryCommand
  /** All effects are computed in a rolled-back transaction; nothing is learned or deleted. */
  effects: {
    record?: MemorySummary
    deletedIds?: string[]
    deletedTopicIds?: string[]
    alreadyDeliveredContent?: 'not_erased'
    preferences?: { learn: boolean; recall: boolean }
    scopeChange?: ScopeChange
    project?: LibraryProject
    conflicts?: MemorySummary[]
    feedback?: RecallFeedback
  }
}

export function summarize(record: MemoryRecord): MemorySummary {
  const { id, revision, state, scope, kind, facet, assertionType, claim, evidenceClass, createdAt, updatedAt } = record
  return { id, revision, state, scope, kind, facet, assertionType, claim, evidenceClass, createdAt, updatedAt }
}
