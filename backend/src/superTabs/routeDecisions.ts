/** Persistence for route decisions. Called inside SuperTabStore's transactions. */
import type { Prisma, SuperTabRouteDecision } from '@prisma/client'
import { ms } from './parts/light.js'
import { readBy } from './parts/indexed.js'
import type { SuperTabState } from './model.js'
import { attemptChanges, endRun, startRun, type RouteRun } from './costs/attempts.js'
import type { TokensByModel } from './costs/tokens.js'
import { finalMatches, type RouteDecision, type RouteDecisionEffect, type RouteFinal, type RouteOverride, type RouteRecord } from './routeRecord.js'

type Tx = Prisma.TransactionClient
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
/** Mongo omits unset fields, so `outcome: null` alone would miss every open decision. */
const open: Prisma.SuperTabRouteDecisionWhereInput = { OR: [{ outcome: null }, { outcome: { isSet: false } }] }
export const RETENTION_MS = 90 * 24 * 60 * 60_000

export const decisionOf = (row: SuperTabRouteDecision): RouteDecision => ({
  id: row.id, conversationId: row.conversationId, record: row.record as unknown as RouteRecord,
  final: (row.final ?? null) as unknown as RouteFinal | null, override: (row.override ?? null) as unknown as RouteOverride | null,
  assignmentId: row.assignmentId, outcome: row.outcome, run: (row.run ?? null) as unknown as RouteRun | null,
})

/** The decision as its readers get it, with the times the log shows: when it was recorded and when its outcome was. Its run
 *  stays internal: the session totals in it are a member's raw counts, which readers get only summed (costs/read.ts; review
 *  of #2106). */
export const timedDecisionOf = (row: SuperTabRouteDecision) => {
  const { run: _run, ...decision } = decisionOf(row)
  return { ...decision, createdAt: row.createdAt, outcomeAt: row.outcomeAt }
}

export async function readDecision(tx: Tx, tabId: string, id: string): Promise<RouteDecision | undefined> {
  const row = await tx.superTabRouteDecision.findFirst({ where: { id, tabId } })
  return row ? decisionOf(row) : undefined
}

/** What the list shows of a Swarm: its newest decisions. */
export const LIST_SIZE = 100

const rowOf = (row: Record<string, unknown>): SuperTabRouteDecision => ({ id: row._id as string, tabId: row.tabId as string, conversationId: row.conversationId as string,
  record: row.record as Prisma.JsonValue, final: (row.final ?? null) as Prisma.JsonValue, override: (row.override ?? null) as Prisma.JsonValue,
  assignmentId: (row.assignmentId ?? null) as string | null, outcome: (row.outcome ?? null) as string | null, run: (row.run ?? null) as Prisma.JsonValue,
  evidence: (row.evidence ?? null) as Prisma.JsonValue, outcomeAt: row.outcomeAt == null ? null : new Date(ms(row.outcomeAt)), createdAt: new Date(ms(row.createdAt)) })

/** The newest 100 decisions in the conversations a reader may see, newest first, as Prisma reads them. Plain `aggregateRaw`
 *  matches: Prisma's `conversationId: { in }` is an $expr $or that Mongo plans branch by branch, 25 ms a read over a Lead's
 *  ~360 conversations (integration/superTabIndexes.test.ts). */
export async function recentDecisions(tx: Tx, tabId: string, conversationIds: string[]): Promise<SuperTabRouteDecision[]> {
  const rows = await tx.superTabRouteDecision.aggregateRaw({ pipeline: [{ $match: { tabId, conversationId: { $in: conversationIds } } },
    { $sort: { createdAt: -1 } }, { $limit: LIST_SIZE }] }) as unknown as Array<Record<string, unknown>>
  return rows.map(rowOf)
}

/** The newest `limit` decisions of the Swarm in any conversation: one scan of the (tabId, createdAt) index of `limit` documents.
 *  The reader's access is applied after, to the conversations these name only. */
export async function newestDecisions(tx: Tx, tabId: string, limit: number): Promise<SuperTabRouteDecision[]> {
  return (await readBy(tx, 'SuperTabRouteDecision', 'recent', [{ $match: { tabId } }, { $sort: { createdAt: -1 } }, { $limit: limit }])).map(rowOf)
}

/** The conversation of each of the Swarm's newest `limit` decisions, newest first: the same scan, a wider window, with none of
 *  a decision's text in the reply. */
export async function newestConversations(tx: Tx, tabId: string, limit: number): Promise<string[]> {
  return (await readBy(tx, 'SuperTabRouteDecision', 'recent', [{ $match: { tabId } }, { $sort: { createdAt: -1 } }, { $limit: limit },
    { $project: { conversationId: 1 } }])).map(row => row.conversationId as string)
}

export async function writeRouteEffects(tx: Tx, tabId: string, effects: RouteDecisionEffect[], now: number): Promise<void> {
  for (const effect of effects) {
    if (effect.op === 'create') {
      // A newer route supersedes unused proposals; queued starts and assignments keep their quota until work ends.
      // This Prisma/Mongo client cannot filter `isSet` on a Json field; reading it maps both unset and null to null.
      const prior = await tx.superTabRouteDecision.findMany({ where: { tabId, conversationId: effect.conversationId, ...open },
        select: { id: true, final: true, assignmentId: true } })
      const unusedIds = prior.filter(row => row.final === null && row.assignmentId === null).map(row => row.id)
      if (unusedIds.length) await tx.superTabRouteDecision.updateMany({ where: { tabId, conversationId: effect.conversationId,
        id: { in: unusedIds }, ...open }, data: { outcome: 'superseded', outcomeAt: new Date(now) } })
      await tx.superTabRouteDecision.create({ data: { id: effect.id, tabId, conversationId: effect.conversationId,
        record: json(effect.record), createdAt: new Date(now) } })
      await tx.superTabRouteDecision.deleteMany({ where: { tabId, createdAt: { lt: new Date(now - RETENTION_MS) } } })
    } else if (effect.op === 'override') {
      await tx.superTabRouteDecision.update({ where: { id: effect.id }, data: { override: json(effect.override) } })
    } else {
      await tx.superTabRouteDecision.update({ where: { id: effect.id }, data: {
        final: json(effect.final), ...(effect.override ? { override: json(effect.override) } : {}),
        ...(effect.assignmentId ? { assignmentId: effect.assignmentId } : {}),
      } })
    }
  }
}

export async function closeAssignment(tx: Tx, tabId: string, assignmentId: string, outcome: 'done' | 'stopped' | 'cancelled', now: number): Promise<void> {
  // The Lead must stop an assignment before handing the task to the candidate a person chose. That stop is
  // the handover, not the end of the decision: keep it open so the next start or assignment links to it.
  if (outcome === 'stopped') {
    const rows = await tx.superTabRouteDecision.findMany({ where: { tabId, assignmentId, ...open } })
    for (const row of rows) {
      const decision = decisionOf(row)
      const chosen = decision.override?.by === 'person' ? decision.record.candidates.find(c => c.id === decision.override!.candidateId) : undefined
      if (chosen && !finalMatches(chosen, decision.final)) {
        await tx.superTabRouteDecision.update({ where: { id: row.id }, data: { assignmentId: null, final: null } })
        return
      }
    }
  }
  await tx.superTabRouteDecision.updateMany({ where: { tabId, assignmentId, ...open }, data: { outcome, outcomeAt: new Date(now) } })
}

/** A failed start or removed agent releases its hold only while the start has no linked assignment. */
export async function closeUnassignedStart(tx: Tx, tabId: string, decisionId: string, startId: string, outcome: 'failed' | 'stopped', now: number): Promise<void> {
  const row = await tx.superTabRouteDecision.findFirst({ where: { id: decisionId, tabId, ...open }, select: { final: true, assignmentId: true } })
  const final = row?.final as { kind?: unknown; startId?: unknown } | null | undefined
  if (row?.assignmentId != null || final?.kind !== 'new' || final.startId !== startId) return
  await tx.superTabRouteDecision.updateMany({ where: { id: decisionId, tabId,
    AND: [open, { OR: [{ assignmentId: null }, { assignmentId: { isSet: false } }] }] },
    data: { outcome, outcomeAt: new Date(now) } })
}

/**
 * Keeps each attempt's run on its route decision (costs/attempts.ts) as a write starts, ends or resumes it: how it began when
 * it is assigned, its end and the totals then when it ends however it ends (a command, a machine's report, the Lead's poll),
 * and outcome `lost` or `superseded` when that is how it ended. A lost attempt its own session takes back (work.resume) opens
 * again: it is the same attempt going on. Only decisions with that assignment are touched, by the tabId+assignmentId index.
 * Runs inside the store's write, after the route effects, so an assignment made in the same write is linked already.
 */
/** `finished`: the attempt its own agent finished in this write (Done or Stopped), with the totals it sent, or null when it
 *  sent none (costs/attempts.ts endRun). */
export async function recordAttempts(tx: Tx, tabId: string, before: SuperTabState, after: SuperTabState, now: number,
  finished?: { assignmentId: string; tokens: TokensByModel | null }): Promise<void> {
  const { started, ended, resumed } = attemptChanges(before.conversations, after)
  for (const assignment of started) {
    await tx.superTabRouteDecision.updateMany({ where: { tabId, assignmentId: assignment.id }, data: { run: json(startRun(after, assignment, now)) } })
  }
  for (const assignment of resumed) {
    await tx.superTabRouteDecision.updateMany({ where: { tabId, assignmentId: assignment.id, outcome: 'lost' }, data: { outcome: null, outcomeAt: null } })
  }
  for (const { assignment, outcome } of ended) {
    const rows = await tx.superTabRouteDecision.findMany({ where: { tabId, assignmentId: assignment.id }, select: { id: true, run: true, outcome: true, createdAt: true } })
    for (const row of rows) {
      // A decision routed before runs were kept: what it ran on is known now, its start tokens never were.
      const began = (row.run as unknown as RouteRun | null) ?? { ...startRun(after, assignment, now), startedAt: row.createdAt.getTime(), start: null }
      const close = outcome && row.outcome == null ? { outcome, outcomeAt: new Date(now) } : {}
      await tx.superTabRouteDecision.update({ where: { id: row.id }, data: { run: json(endRun(began, after, assignment, assignment.agentId, now, before,
        finished?.assignmentId === assignment.id ? finished.tokens : undefined)), ...close } })
    }
  }
}
