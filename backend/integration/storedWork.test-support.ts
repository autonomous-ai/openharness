import type { PrismaClient } from '@prisma/client'
import { swarmTransaction } from '../src/superTabs/cache.js'
import type { Assignment, SuperTabState, WorkStatus } from '../src/superTabs/model.js'
import * as parts from '../src/superTabs/parts/index.js'
import { storedAssignment, storedStatus } from '../src/superTabs/storedWork.test-support.js'

/** Rewrites [tab]'s parts after [change], as an older release would have left them. Versions keep rising. */
async function rewrite<T>(db: PrismaClient, tab: string, change: (state: SuperTabState) => T, after?: (tx: Parameters<Parameters<typeof swarmTransaction>[1]>[0], value: T) => Promise<unknown>): Promise<T> {
  return swarmTransaction(db, async tx => {
    const current = await parts.loadAll(tx, tab)
    const state = parts.reassemble(current)
    const value = change(state)
    const version = Math.max(current.head.version, ...[...current.members, ...current.agents, ...current.groups, ...current.machines,
      ...current.starts, ...current.progress].map(p => p.version)) + 1
    for (const model of [tx.swarmHead, tx.swarmMember, tx.swarmAgent, tx.swarmGroup, tx.swarmMachine, tx.swarmStart, tx.swarmProgress] as unknown as
      Array<{ deleteMany(args: unknown): Promise<unknown> }>) await model.deleteMany({ where: { tabId: tab } })
    await parts.insertParts(tx, { ...parts.split(state, { tabId: tab, version, now: Date.now(), visibilityEpoch: current.visibilityEpoch }),
      sequenceBase: current.sequenceBase })
    if (after) await after(tx, value)
    return value
  })
}

/** [agentId] working on task [conversationId] of [tab], as work.assign stored it before Swarm v4, with the run record that keeps
 *  the agent on one task at a time. v4 assigns no work (work.assign answers as retired, 2026-11-10). */
export function storeAssignment(db: PrismaClient, tab: string, conversationId: string, agentId: string, now = Date.now()): Promise<Assignment> {
  return rewrite(db, tab, state => storedAssignment(state, conversationId, agentId, now), (tx, assignment) =>
    tx.superTabRun.create({ data: { id: assignment.agentId, tabId: tab, assignmentId: assignment.id, machineId: assignment.execution.machineId,
      harnessId: assignment.execution.harnessId } }))
}

/** Task [conversationId]'s stored assignment at [status], as its agent's last work.status left it before Swarm v4. Work that
 *  ended there let its agent go: its run record goes too, as the store's endRuns released it. */
export function storeStatus(db: PrismaClient, tab: string, conversationId: string, status: WorkStatus, result: string | null = null): Promise<Assignment> {
  return rewrite(db, tab, state => storedStatus(state, conversationId, status, result), (tx, assignment) =>
    ENDED.has(status) ? tx.superTabRun.deleteMany({ where: { tabId: tab, assignmentId: assignment.id } }) : Promise.resolve())
}
const ENDED: ReadonlySet<WorkStatus> = new Set(['done', 'stopped', 'cancelled', 'lost'])

/** [projectId] of [tab] with Board settings as its owner set them before Swarm v4 retired the commands (2026-11-10). */
export function storeBoardSettings(db: PrismaClient, tab: string, projectId: string, settings: { boardMode?: true | undefined; canChat?: string[]; decider?: string }): Promise<void> {
  return rewrite(db, tab, state => { Object.assign(state.projects!.find(p => p.id === projectId)!, settings) })
}
