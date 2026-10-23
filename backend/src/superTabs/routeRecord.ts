/** What `harness super-tab route` records (docs/superpowers/specs/2026-10-19-super-tab-routing-v1-design.md). */
import { z } from 'zod'

const level = z.enum(['low', 'medium', 'high'])
const candidateId = z.string().regex(/^c\d{1,2}$/)
const machine = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
const amount = z.number().finite().nonnegative()
/** How the candidate's quota fits the task (phase 1 routing), kept so committed spend and pick quality can be read back. */
const fit = z.object({
  status: z.enum(['fits', 'unknown', 'short']),
  /** Usable over needed on the tightest window; negative when committed spend already exceeds what is left. */
  coverage: z.number().finite().nullable(),
  effectiveCost: amount,
  expiring: amount,
  spend: z.object({ '5-hour': amount.optional(), weekly: amount.optional() }).strict(),
  /** The hashed usage key, or `machineId:engine` when the machine reports none. */
  account: z.string().min(1).max(200).optional(),
}).strict()
export const routeCandidateSchema = z.object({
  id: candidateId,
  kind: z.enum(['member', 'new']),
  agentId: machine.optional(),
  machineId: machine,
  engine: z.enum(['claude', 'codex']),
  model: z.string().min(1).max(200),
  effort: z.string().min(1).max(80),
  quality: z.number().int().min(1).max(3),
  cost: z.number().int().min(1).max(100),
  /** Short, for the conversation row: "Multiply · Claude opus high · remote-1". */
  title: z.string().trim().min(1).max(160),
  /** The criterion line Jev was shown. */
  label: z.string().trim().min(1).max(640),
  fit: fit.optional(),
  /** A new agent on a model served on the Swarm's grid: its model and effort are `default`. */
  gridModel: z.string().min(1).max(200).optional(),
  gridName: z.string().min(1).max(160).optional(),
}).strict().refine(c => (c.kind === 'member') === !!c.agentId, 'Members name their agent; new agents do not.')
export const routeRecordSchema = z.object({
  assessment: z.object({ difficulty: level, risk: level, why: z.string().trim().min(1).max(300),
    size: z.enum(['small', 'medium', 'large']).optional() }).strict(),
  candidates: z.array(routeCandidateSchema).min(1).max(12),
  excluded: z.array(z.object({ title: z.string().trim().min(1).max(160), reason: z.string().trim().min(1).max(500) }).strict()).max(200),
  floor: z.number().int().min(1).max(3),
  notes: z.boolean(),
  pick: candidateId,
  via: z.enum(['jev', 'order', 'only']),
  /** Why the policy order decided, when it did: Jev answered without enough confidence, or could not be asked. */
  fallback: z.enum(['unsure', 'unavailable']).optional(),
  p: z.number().min(0).max(1).nullable(),
  belowFloor: z.boolean(),
  /** The verdict's own explanation, kept for analysis; the row quotes the Lead's assessment instead. */
  why: z.string().trim().min(1).max(300),
  /** How much context Jev was given and which sources could not be read, so pick quality can later be compared with completeness. */
  context: z.object({ chars: z.number().int().min(0).max(30_000), missing: z.array(z.string().min(1).max(40)).max(10) }).strict().optional(),
}).strict().refine(d => d.candidates.some(c => c.id === d.pick), 'The pick must be one of the candidates.')
  .refine(d => new Set(d.candidates.map(c => c.id)).size === d.candidates.length, 'Candidate ids must be unique.')

/**
 * Whether a started agent is the candidate's: the same machine, engine, and the model and effort that were
 * requested. After a failed switch `final` holds what ran, so the request is the one that names the candidate.
 */
export const startedAs = (candidate: RouteCandidate, final: Extract<RouteFinal, { kind: 'new' }>): boolean =>
  final.machineId === candidate.machineId && final.engine === candidate.engine &&
  (final.requested?.model ?? final.model) === candidate.model && (final.requested?.effort ?? final.effort) === candidate.effort &&
  (final.gridModel ?? null) === (candidate.gridModel ?? null) && (final.gridName ?? null) === (candidate.gridName ?? null)

/** Whether a decision's final names this candidate: the same agent, or the same start. */
export const finalMatches = (candidate: RouteCandidate, final: RouteFinal | null): boolean => !!final && (candidate.kind === 'member'
  ? final.kind === 'member' && final.agentId === candidate.agentId
  : final.kind === 'new' && startedAs(candidate, final))

export type RouteCandidate = z.infer<typeof routeCandidateSchema>
export type RouteRecord = z.infer<typeof routeRecordSchema>
export type RouteFinal =
  | { kind: 'member'; agentId: string; machineId: string }
  /** After a failed model switch, `model` and `effort` are what ran and `requested` is what routing asked for. */
  | { kind: 'new'; startId: string; machineId: string; engine: string; model: string; effort: string; requested?: { model: string; effort: string };
      gridModel?: string; gridName?: string }
export interface RouteOverride { by: 'lead' | 'person'; actorKey: string; candidateId?: string; reason: string }
export interface RouteDecision {
  id: string; conversationId: string; record: RouteRecord
  final: RouteFinal | null; override: RouteOverride | null; assignmentId: string | null; outcome: string | null
}
export type RouteDecisionEffect =
  | { op: 'create'; id: string; conversationId: string; record: RouteRecord }
  | { op: 'override'; id: string; override: RouteOverride }
  | { op: 'final'; id: string; final: RouteFinal; override?: RouteOverride; assignmentId?: string }
export const routeTitle = (decision: RouteDecision, candidateId: string): string =>
  decision.record.candidates.find(c => c.id === candidateId)?.title ?? 'another candidate'
