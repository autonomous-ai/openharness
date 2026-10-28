/** Persistence for route decisions. Called inside SuperTabStore's transactions. */
import type { Prisma, SuperTabRouteDecision } from '@prisma/client'
import { finalMatches, type RouteDecision, type RouteDecisionEffect, type RouteFinal, type RouteOverride, type RouteRecord } from './routeRecord.js'

type Tx = Prisma.TransactionClient
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
/** Mongo omits unset fields, so `outcome: null` alone would miss every open decision. */
const open: Prisma.SuperTabRouteDecisionWhereInput = { OR: [{ outcome: null }, { outcome: { isSet: false } }] }
export const RETENTION_MS = 90 * 24 * 60 * 60_000

export const decisionOf = (row: SuperTabRouteDecision): RouteDecision => ({
  id: row.id, conversationId: row.conversationId, record: row.record as unknown as RouteRecord,
  final: (row.final ?? null) as unknown as RouteFinal | null, override: (row.override ?? null) as unknown as RouteOverride | null,
  assignmentId: row.assignmentId, outcome: row.outcome,
})

/** The decision with the times the log shows: when it was recorded and when its outcome was. */
export const timedDecisionOf = (row: SuperTabRouteDecision) => ({ ...decisionOf(row), createdAt: row.createdAt, outcomeAt: row.outcomeAt })

export async function readDecision(tx: Tx, tabId: string, id: string): Promise<RouteDecision | undefined> {
  const row = await tx.superTabRouteDecision.findFirst({ where: { id, tabId } })
  return row ? decisionOf(row) : undefined
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
