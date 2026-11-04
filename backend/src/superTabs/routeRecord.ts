/** What `harness super-tab route` records (docs/superpowers/specs/2026-10-19-super-tab-routing-v1-design.md). */
import { z } from 'zod'
import type { RouteRun } from './costs/attempts.js'
import { JOB_KINDS } from './evidence/jobKind.js'

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
    size: z.enum(['small', 'medium', 'large']).optional(),
    /** The job's kind the Lead gave (`ui`, `docs`; `review` for a review), what attempts are compared by (costs/read.ts). */
    kind: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).optional(),
    /** A person asked for a local model, or named one (cli superTabs/route.ts Assessment), kept with the decision. */
    local: z.literal(true).optional(), model: z.string().trim().min(1).max(200).optional() }).strict(),
  /** Every engine on every machine, a new agent and an idle member each (cli superTabs/route.ts RECORD_MAX, Ken 2026-11-03); 12
   *  before, when the route showed one row a machine. */
  candidates: z.array(routeCandidateSchema).min(1).max(64),
  excluded: z.array(z.object({ title: z.string().trim().min(1).max(160), reason: z.string().trim().min(1).max(500) }).strict()).max(200),
  floor: z.number().int().min(1).max(3),
  notes: z.boolean(),
  /** The candidate an older CLI ranked first. The route names none since task #2901 (Ken, 2026-11-04): the project's Routing
   *  instructions choose, and the start or assignment records which candidate it was (RouteFinal.candidateId). */
  pick: candidateId.optional(),
  /** `instructions`: no pick, the coordinator chooses by the Routing instructions (task #2901). `only` comes with or without one. */
  via: z.enum(['jev', 'order', 'only', 'instructions']),
  /** Why the policy order decided, when it did: Jev answered without enough confidence, or could not be asked. */
  fallback: z.enum(['unsure', 'unavailable']).optional(),
  p: z.number().min(0).max(1).nullable(),
  belowFloor: z.boolean(),
  /** The verdict's own explanation, kept for analysis; the row quotes the Lead's assessment instead. */
  why: z.string().trim().min(1).max(300),
  /** How much context Jev was given and which sources could not be read, so pick quality can later be compared with completeness. */
  context: z.object({ chars: z.number().int().min(0).max(30_000), missing: z.array(z.string().min(1).max(40)).max(10) }).strict().optional(),
  /** The step up this attempt was: its task's step up (model.ts Conversation.stepUp), stamped by the server when the route is
   *  recorded, never taken from the route. */
  stepUp: z.object({ attempt: z.number().int().min(2).max(3), reason: z.string().min(1).max(200) }).strict().optional(),
  /** Why a review ran on its Builder's own engine, on records from before 2026-10-30, when another engine had to review when it could. Never written since, never taken from the route. */
  sameEngine: z.string().min(1).max(300).optional(),
  /** The job's kind from the fixed list (evidence/jobKind.ts), written by the server from its group, never taken from the route. */
  jobKind: z.enum(JOB_KINDS).optional(),
  /** The project instructions' revision the route relied on (`project.instructionsRevision ?? 0` when it was recorded), written
   *  by the server, never taken from the route. Absent from records before project instructions. */
  instructionsRevision: z.number().int().nonnegative().optional(),
}).strict().refine(d => d.pick === undefined || d.candidates.some(c => c.id === d.pick), 'The pick must be one of the candidates.')
  .refine(d => new Set(d.candidates.map(c => c.id)).size === d.candidates.length, 'Candidate ids must be unique.')

/** The part of a quota fit every candidate of a record without a pick keeps: what the route history reads of the one that ran. */
export type KeptFit = Pick<z.infer<typeof fit>, 'account' | 'spend'>
/** A candidate as a decision keeps it: the pick whole; any other only who and where it is and its title, and with no pick its
 *  account and spend too (storedRecord). */
export type KeptCandidate = Omit<RouteCandidate, 'quality' | 'cost' | 'label' | 'fit'> & Partial<Pick<RouteCandidate, 'quality' | 'cost' | 'label'>>
  & { fit?: RouteCandidate['fit'] | KeptFit }
/** A record as its readers get it back (readRecord): its candidates as kept. */
export type ReadRouteRecord = Omit<RouteRecord, 'candidates'> & { candidates: KeptCandidate[] }

/** A record as stored (routeDecisions.ts): the pick whole, the other candidates as KeptCandidate, and the exclusions kept once
 *  per reason. On production (2026-11-03) labels were 5.4 KB of a 20.9 KB row and exclusions 8.9 KB, 47 of them sharing ~5
 *  reasons (task #2488); the 42 candidates of an 11-04 route were still ~18.9 KB, ~8.5 KB of it quota fits (task #2769). Rows
 *  written before keep `excluded` and no `unavailable`, and every candidate whole. */
export interface StoredRouteRecord extends Omit<ReadRouteRecord, 'excluded'> {
  excluded?: RouteRecord['excluded']
  unavailable?: Array<{ reason: string; titles: string[] }>
}

/** What a decision keeps of [record]: the pick whole, and of every other candidate only what a reader takes back of one: who
 *  and where it is (a start or assignment matching it, startedAs; a person choosing it, route.override; its Team-work check) and
 *  its title (the chat lines, Desktop's Details). Its label, strength, cost and quota fit are read of the pick only: the route
 *  showed the others when it ran, and the route history takes the account and spend of the pick (cli service.ts routeHistory).
 *  A record with no pick (task #2901) keeps every candidate's account and spend instead, as any of them may be the one that
 *  runs and nobody knows which until the start. Each exclusion reason is kept once, with its titles in order. */
export function storedRecord(record: RouteRecord): StoredRouteRecord {
  const { excluded, ...rest } = record
  const candidates = record.candidates.map(({ label: _label, quality: _quality, cost: _cost, fit, ...c }, i): KeptCandidate =>
    record.pick === undefined ? { ...c, ...fit ? { fit: { ...fit.account ? { account: fit.account } : {}, spend: fit.spend } } : {} }
      : c.id === record.pick ? record.candidates[i]! : c)
  const byReason = new Map<string, string[]>()
  for (const { title, reason } of excluded) byReason.set(reason, [...byReason.get(reason) ?? [], title])
  return { ...rest, candidates, ...byReason.size ? { unavailable: [...byReason].map(([reason, titles]) => ({ reason, titles })) } : { excluded: [] } }
}

/** Either stored form back as readers get a record: `unavailable` expanded into `excluded`, reason by reason in the order each
 *  first appeared. A record written before this is returned as it is. */
export function readRecord(stored: StoredRouteRecord | RouteRecord): ReadRouteRecord {
  if (!('unavailable' in stored) || !stored.unavailable) return stored as ReadRouteRecord
  const { unavailable, ...rest } = stored
  return { ...rest, excluded: unavailable.flatMap(({ reason, titles }) => titles.map(title => ({ title, reason }))) } as ReadRouteRecord
}

/**
 * Whether a started agent is the candidate's: the same machine, engine, and the model and effort that were
 * requested. After a failed switch `final` holds what ran, so the request is the one that names the candidate.
 */
export const startedAs = (candidate: KeptCandidate, final: Extract<RouteFinal, { kind: 'new' }>): boolean =>
  final.machineId === candidate.machineId && final.engine === candidate.engine &&
  (final.requested?.model ?? final.model) === candidate.model && (final.requested?.effort ?? final.effort) === candidate.effort &&
  (final.gridModel ?? null) === (candidate.gridModel ?? null) && (final.gridName ?? null) === (candidate.gridName ?? null)

/** Whether a decision's final names this candidate: the same agent, or the same start. */
export const finalMatches = (candidate: KeptCandidate, final: RouteFinal | null): boolean => !!final && (candidate.kind === 'member'
  ? final.kind === 'member' && final.agentId === candidate.agentId
  : final.kind === 'new' && startedAs(candidate, final))

export type RouteCandidate = z.infer<typeof routeCandidateSchema>
export type RouteRecord = z.infer<typeof routeRecordSchema>
/** `candidateId` names the candidate the start or assignment matched when the record has no pick (task #2901): the
 *  coordinator's own choice by the Routing instructions, which the route history reads back. */
export type RouteFinal =
  | { kind: 'member'; agentId: string; machineId: string; candidateId?: string }
  /** After a failed model switch, `model` and `effort` are what ran and `requested` is what routing asked for. */
  | { kind: 'new'; startId: string; machineId: string; engine: string; model: string; effort: string; requested?: { model: string; effort: string };
      gridModel?: string; gridName?: string; candidateId?: string }
export interface RouteOverride { by: 'lead' | 'person'; actorKey: string; candidateId?: string; reason: string }
export interface RouteDecision {
  id: string; conversationId: string; record: ReadRouteRecord
  final: RouteFinal | null; override: RouteOverride | null; assignmentId: string | null; outcome: string | null
  /** Its attempt's run: what it ran on, how it was paid, its session's token totals at start and end (costs/attempts.ts). */
  run: RouteRun | null
}
export type RouteDecisionEffect =
  | { op: 'create'; id: string; conversationId: string; record: RouteRecord }
  | { op: 'override'; id: string; override: RouteOverride }
  | { op: 'final'; id: string; final: RouteFinal; override?: RouteOverride; assignmentId?: string }
export const routeTitle = (decision: RouteDecision, candidateId: string): string =>
  decision.record.candidates.find(c => c.id === candidateId)?.title ?? 'another candidate'
