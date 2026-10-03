/** Portable coding knowledge. Native events and user-action authority are supplied by trusted adapters. */
import { z } from 'zod'

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/)
const text = z.string().trim().min(1).max(2_000)
const timestamp = z.number().int().nonnegative().safe()
const conditions = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  z.union([z.string().max(200), z.number().finite(), z.boolean(), z.array(z.string().max(200)).min(1).max(16)]))
  .refine(value => Object.keys(value).length <= 24)
export const conditionsSchema = conditions

export const scopeSchema = z.object({
  profileId: id, projectId: id.optional(), taskId: id.optional(), branchId: id.optional(),
}).strict().refine(value => (!value.taskId && !value.branchId) || !!value.projectId, 'task and branch scope need a project')

export const verificationSchema = z.object({
  method: z.enum(['test', 'benchmark', 'static_analysis', 'proof_review', 'visual_review', 'manual_check', 'operational_observation']),
  result: text, artifact: text, revision: text.optional(), environment: text.optional(),
  coverage: text, limitations: z.array(text).max(16),
  deploymentId: text.optional(), observedFrom: timestamp.optional(), observedTo: timestamp.optional(),
}).strict()

export const sourceSchema = z.object({
  id, profileId: id, projectId: id.nullable(), engine: id, sessionId: id, nativeEventId: id,
  taskId: id.optional(), branchId: id.optional(),
  role: z.enum(['user', 'assistant', 'tool', 'reference', 'derived']),
  eligibility: z.enum(['coding', 'private', 'excluded', 'non_coding']),
  observedAt: timestamp, rootIds: z.array(id).min(1).max(32),
  derivedFrom: z.array(z.object({ memoryId: id, revision: z.number().int().positive() }).strict()).min(1).max(32).optional(),
  text: z.string().min(1).max(32_000), verification: verificationSchema.optional(),
  retention: z.literal('evidence_only').optional(),
}).strict().refine(value => value.role === 'derived' ? !!value.derivedFrom : !value.derivedFrom, 'derived source needs memory lineage')
  .refine(value => (!value.taskId && !value.branchId) || value.projectId !== null, 'task and branch source need a project')

export const evidenceSchema = z.object({
  sourceEventId: id, quote: z.string().min(1).max(4_000),
  paths: z.array(z.string().min(2).max(200)).min(1).max(32),
  verification: verificationSchema.optional(),
}).strict()

const experimentRun = z.object({
  id, codeRevision: text, status: z.enum(['completed', 'crashed', 'timed_out', 'invalid']),
  score: z.number().finite().nullable(), disposition: z.enum(['kept', 'discarded', 'pending']),
  artifact: text, failure: text.optional(),
}).strict().refine(run => run.status !== 'completed' || run.score !== null, 'completed measurement requires a score')
  .refine(run => run.status === 'completed' || run.disposition !== 'kept', 'failed run cannot be a retained winner')
  .transform(run => ({ ...run, score: run.status === 'completed' ? run.score : null }))
const detailObject = z.record(z.string().max(100), z.json())
const experiment = z.object({
  hypothesis: text.optional(), hypothesisStatus: z.enum(['unresolved', 'supported', 'refuted']).optional(),
  intervention: z.array(text).max(16).optional(), result: text, limitations: z.array(text).max(16),
  objective: z.object({ metric: text, direction: z.enum(['lower', 'higher']) }).strict().optional(),
  evaluator: z.object({ revision: text }).strict().optional(), dataset: z.object({ revision: text }).strict().optional(),
  environment: conditions.optional(),
  budget: z.object({ value: z.number().finite().positive(), unit: text, includes: text, excludes: z.array(text).max(8) }).strict().optional(),
  runs: z.array(experimentRun).min(1).max(32).optional(),
}).strict().refine(value => !value.runs || (value.objective && value.evaluator && value.dataset && value.environment && value.budget), 'measured runs require comparison conditions')

export const draftSchema = z.object({
  kind: z.enum(['working_preference', 'project_decision', 'verified_pitfall', 'reference', 'working_continuity']),
  facet: id,
  assertionType: z.enum(['stated_preference', 'observed_usage', 'project_constraint', 'accepted_decision', 'verified_finding', 'learning_goal', 'temporary_state']),
  scope: scopeSchema, claim: text, rationale: text.nullable(), futureAction: text,
  applicability: conditions,
  exceptions: z.array(z.object({ when: conditions.refine(value => Object.keys(value).length > 0), reason: text }).strict()).max(12),
  retrievalCues: z.array(z.string().min(1).max(100)).max(20),
  details: z.object({ style: detailObject.optional(), decision: detailObject.optional(),
    reference: detailObject.optional(), experiment: experiment.optional() }).strict().optional(),
  evidenceClass: z.enum(['user_stated', 'observed_verified', 'inferred', 'imported']),
  evidence: z.array(evidenceSchema).min(1).max(16), conflictKey: id,
  validity: z.object({ validFrom: timestamp.nullable(), validUntil: timestamp.nullable(), recheckWhen: z.array(text).max(12) }).strict(),
}).strict().refine(value => JSON.stringify(value).length <= 32_000, 'record too large')
  .refine(value => value.validity.validFrom === null || value.validity.validUntil === null || value.validity.validFrom <= value.validity.validUntil, 'invalid validity window')

export type SourceEvent = z.infer<typeof sourceSchema>
export type MemoryDraft = z.infer<typeof draftSchema>
export type MemoryScope = z.infer<typeof scopeSchema>
export type Conditions = z.infer<typeof conditions>
export type MemoryState = 'active' | 'tentative' | 'needs_verification' | 'superseded' | 'archived'
export interface MemoryRecord extends MemoryDraft {
  schemaVersion: 1; id: string; revision: number; state: MemoryState; createdAt: number; updatedAt: number
}

/** Evidence counts are inspectable provenance, not probability or proof of causal usefulness. */
export interface MemorySupport {
  independentUserStatements: number
  verifiedObservations: number
  distinctSessions: number
  lastObservedAt: number | null
}

/** Constructed by the authenticated host, never copied from a model's request body. */
export interface MemoryAccess {
  profileId: string
  projectIds: readonly string[]
  includeProfile: boolean
  taskId?: string
  branchId?: string
}

export const topicSchema = z.object({
  id, scope: scopeSchema, title: text,
  statements: z.array(z.object({ text, supports: z.array(z.object({
    memoryId: id, revision: z.number().int().positive(), paths: z.array(z.string().min(2).max(200)).min(1).max(16),
  }).strict()).min(1).max(16) }).strict()).min(1).max(24),
}).strict().refine(value => JSON.stringify(value).length <= 32_000, 'topic too large')
export type TopicDraft = z.infer<typeof topicSchema>
export interface TopicPage extends Omit<TopicDraft, 'statements'> {
  revision: number; updatedAt: number
  statements: Array<TopicDraft['statements'][number] & { constraints: Array<{
    memoryId: string; applicability: Conditions; exceptions: MemoryDraft['exceptions']; validity: MemoryDraft['validity']
  }> }>
}

export interface RecallRequest {
  /** Existing callers keep summary context; native prompt delivery can request exact supporting excerpts. */
  format?: 'summary' | 'source_excerpts'
  query: string
  conditions?: Conditions
  maxBytes?: number
  maxItems?: number
  excludeIds?: string[]
}
export interface RecallItem {
  id: string; revision: number; kind: MemoryDraft['kind']; assertionType: MemoryDraft['assertionType']
  scope: MemoryScope; claim: string; rationale: string | null; futureAction: string
  conditions: Conditions; exceptions: MemoryDraft['exceptions']; evidenceClass: MemoryDraft['evidenceClass']; cautions: string[]
  verification: z.infer<typeof verificationSchema>[]
  sources: Array<{ id: string; engine: string; role: SourceEvent['role']; observedAt: number }>
}
export interface RecallPacket {
  status: 'ok' | 'off' | 'denied' | 'timeout' | 'unavailable'
  items: RecallItem[]
  /** Inert serialized context. Byte cap is exact; token count is explicitly an estimate. */
  text: string
  estimatedTokens: number
}

export class MemoryError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'MemoryError' }
}

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new MemoryError('invalid_input')
  return result.data
}

export function canAccess(scope: MemoryScope, access: MemoryAccess): boolean {
  return scope.profileId === access.profileId
    && (scope.projectId ? access.projectIds.includes(scope.projectId) : access.includeProfile)
    && (!scope.taskId || scope.taskId === access.taskId)
    && (!scope.branchId || scope.branchId === access.branchId)
}

export function hasPointer(value: unknown, path: string): boolean {
  if (!path.startsWith('/') || /~[^01]/.test(path)) return false
  for (const token of path.slice(1).split('/')) {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return false
    value = (value as Record<string, unknown>)[key]
  }
  return true
}

export function matches(required: Conditions, actual: Conditions): boolean {
  return Object.entries(required).every(([key, expected]) => {
    const observed = actual[key]
    if (observed === undefined) return false
    const expectedValues = Array.isArray(expected) ? expected : [expected]
    const observedValues = Array.isArray(observed) ? observed : [observed]
    return expectedValues.some(value => observedValues.some(observedValue => value === observedValue))
  })
}

/** Absence of a shared condition is not evidence that two claims cannot conflict. */
export function conditionsOverlap(a: Conditions, b: Conditions): boolean {
  return !Object.keys(a).some(key => key in b && !matches({ [key]: a[key] }, { [key]: b[key] }))
}
