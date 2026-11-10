import type { PrismaClient } from '@prisma/client'
import type { Actor, Assignment, WorkStatus } from '../src/superTabs/model.js'
import { storedCreate, type StoredCreate } from '../src/superTabs/steps.test-support.js'
import { storedAssignment, storedStatus } from '../src/superTabs/storedWork.test-support.js'
import { rewriteParts } from './storedParts.test-support.js'

/** A task or step of [tab] that [user], or with [agentId] that agent, opened with conversation.create before Swarm v4 removed it,
 *  stored as that command stored it (storedCreate), with that command's answer. */
export async function storeCreate(db: PrismaClient, tab: string, command: StoredCreate, user: { sub: string; email: string }, agentId?: string) {
  const actor: Actor = agentId ? { kind: 'agent', agentId, machineOwnerId: user.sub } : { kind: 'person', userId: user.sub, email: user.email }
  const { result } = await rewriteParts(db, tab, state => storedCreate(state, command, actor))
  return { result }
}

/** [agentId] working on task [conversationId] of [tab], as work.assign stored it before Swarm v4, with the run record that keeps
 *  the agent on one task at a time. v4 assigns no work (2026-11-10). */
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

