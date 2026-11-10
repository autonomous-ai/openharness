import type { PrismaClient } from '@prisma/client'
import type { Assignment, WorkStatus } from '../src/superTabs/model.js'
import { storedAssignment, storedStatus } from '../src/superTabs/storedWork.test-support.js'
import { rewriteParts } from './storedParts.test-support.js'

/** [agentId] working on task [conversationId] of [tab], as work.assign stored it before Swarm v4, with the run record that keeps
 *  the agent on one task at a time. v4 assigns no work (work.assign answers as retired, 2026-11-10). */
export function storeAssignment(db: PrismaClient, tab: string, conversationId: string, agentId: string, now = Date.now()): Promise<Assignment> {
  return rewriteParts(db, tab, state => storedAssignment(state, conversationId, agentId, now), (tx, assignment) =>
    tx.superTabRun.create({ data: { id: assignment.agentId, tabId: tab, assignmentId: assignment.id, machineId: assignment.execution.machineId,
      harnessId: assignment.execution.harnessId } }))
}

/** Task [conversationId]'s stored assignment at [status], as its agent's last work.status left it before Swarm v4. Work that
 *  ended there let its agent go: its run record goes too, as the store's endRuns released it. */
export function storeStatus(db: PrismaClient, tab: string, conversationId: string, status: WorkStatus, result: string | null = null): Promise<Assignment> {
  return rewriteParts(db, tab, state => storedStatus(state, conversationId, status, result), (tx, assignment) =>
    ENDED.has(status) ? tx.superTabRun.deleteMany({ where: { tabId: tab, assignmentId: assignment.id } }) : Promise.resolve())
}
const ENDED: ReadonlySet<WorkStatus> = new Set(['done', 'stopped', 'cancelled', 'lost'])

