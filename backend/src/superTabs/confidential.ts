import type { Prisma } from '@prisma/client'
import type { Agent } from './model.js'
import { loadActive, reassemble } from './parts/index.js'
import { confidentialSession } from './projects.js'

type Transaction = Prisma.TransactionClient

/**
 * The native sessions (an agent id is one machine's harness, the same in every Swarm) among `agentIds` that are confidential
 * in any Swarm (Lead ruling, final review Critical 1): marked once a Lead or a private conversation's member (projects.ts
 * markConfidential), or, in a part written before that mark, a Lead or private member now. A confidential session is
 * watched by nobody but its machine's person, whichever Swarm or share asks.
 */
export async function confidentialSessions(tx: Transaction, agentIds: string[]): Promise<Set<string>> {
  const found = new Set<string>()
  if (!agentIds.length) return found
  const rows = await tx.swarmAgent.findMany({ where: { key: { in: [...new Set(agentIds)] }, deleted: false }, select: { tabId: true, key: true, data: true } })
  const unmarked = new Map<string, string[]>()
  for (const row of rows) {
    if ((row.data as unknown as Agent).confidential) found.add(row.key)
    else unmarked.set(row.tabId, [...unmarked.get(row.tabId) ?? [], row.key])
  }
  for (const [tabId, keys] of unmarked) {
    const pending = keys.filter(key => !found.has(key))
    if (!pending.length) continue
    const state = reassemble(await loadActive(tx, tabId, { agentIds: pending }))
    for (const target of state.agents) if (pending.includes(target.id) && confidentialSession(state, target)) found.add(target.id)
  }
  return found
}
