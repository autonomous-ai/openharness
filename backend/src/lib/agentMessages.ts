import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { parseTabs } from './desk.js'

/**
 * Agent Messages, per tab (docs/design/2026-10-10-agent-messages.md): which desk tabs let their harnesses
 * message each other, and who is in each. The daemons read this to decide whether a message may go; the
 * windows read and set the flag. Off unless a person turned it on: a missing record is off.
 */

/** A tab's record address: the same for every pod and every write, so a concurrent first write converges. */
export const agentMessageTabId = (userId: string, tabId: string): string =>
  createHash('sha256').update(JSON.stringify(['agent-messages', userId, tabId])).digest('hex').slice(0, 24)

export interface AgentMessagesDirectory {
  /** The desk's revision this was read at. */
  revision: number
  /** The owner's machines by id, with the name a person gave each: what a message's header says it came from. */
  machines: { machineId: string; name: string | null }[]
  tabs: { id: string; name: string; enabled: boolean; panes: { machineId: string; agentId: string }[] }[]
}

/** Every tab on the desk, with its owned panes and whether Agent Messages is on in it. */
export async function readAgentMessages(userId: string): Promise<AgentMessagesDirectory> {
  const [desk, machines, records] = await Promise.all([
    prisma.desk.findUnique({ where: { userId } }),
    prisma.machine.findMany({ where: { userId }, select: { machineId: true, name: true } }),
    prisma.agentMessageTab.findMany({ where: { userId }, select: { userId: true, tabId: true, enabled: true } }),
  ])
  const owned = new Set(machines.map(m => m.machineId))
  const on = new Set(records.filter(r => r.userId === userId && r.enabled).map(r => r.tabId))
  return {
    revision: desk?.revision ?? 0,
    machines: machines.map(m => ({ machineId: m.machineId, name: m.name ?? null })),
    // A shared harness someone else owns is shown on the desk but never takes part: only the owner's machines.
    tabs: parseTabs(desk?.tabs).map(tab => ({
      id: tab.id, name: tab.name, enabled: on.has(tab.id),
      panes: tab.panes.filter(p => owned.has(p.machineId)).map(p => ({ machineId: p.machineId, agentId: p.agentId })),
    })),
  }
}

/** Turn Agent Messages on or off for one tab. */
export async function setAgentMessages(userId: string, tabId: string, enabled: boolean): Promise<{ tabId: string; enabled: boolean; revision: number }> {
  const id = agentMessageTabId(userId, tabId)
  const data = { enabled, revision: { increment: 1 } }
  let row
  try {
    row = await prisma.agentMessageTab.upsert({ where: { id }, create: { id, userId, tabId, enabled, revision: 1 }, update: data })
  } catch (error) {
    // Two first writes at once: the loser updates the record the winner made.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
    row = await prisma.agentMessageTab.update({ where: { id }, data })
  }
  if (row.userId !== userId || row.tabId !== tabId) throw new Error('Agent Messages record identity mismatch')
  return { tabId, enabled: row.enabled, revision: row.revision }
}
