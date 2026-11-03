import type { Prisma } from '@prisma/client'
import { SuperTabError, type Agent, type SuperTabState } from './model.js'
import { RETRYABLE_SWARM_CODES } from './retry.js'
import { loadActive, reassemble } from './parts/index.js'
import { confidentialSession, sessionKey, type OtherRegistrations } from './projects.js'
import { bindSession, sessionRecordId } from './sessionScope.js'

type Transaction = Prisma.TransactionClient

/**
 * The native sessions (an agent id is one machine's harness, the same in every Swarm) among `agentIds` that are confidential
 * in any Swarm (Lead ruling, final review Critical 1), or in any but `exceptTabId`: marked once a Lead or a private
 * conversation's member (projects.ts markConfidential), or, in a part written before that mark, a Lead or private member now.
 * A confidential session is watched by nobody but its machine's person, whichever Swarm or share asks, except by its own
 * Swarm's readers while it is that Swarm's current Lead (projects.ts watchClosed), which is why a Swarm asks about the others.
 */
/** `stateOf` gives a Swarm's active parts with these agents' groups, as loadActive in `tx` does; a read outside a transaction may
 *  give the read cache's (cachedReads.ts readParts gives the same parts), uncopied, as nothing here changes it. With `busyClosed`,
 *  a Swarm too busy to read (retry.ts) closes the sessions asked of it, as unknown, and is named to it; without, its answer throws. */
export async function confidentialSessions(tx: Transaction, agentIds: string[], exceptTabId?: string,
  stateOf: (tabId: string, agentIds: string[]) => Promise<SuperTabState> = async (tabId, ids) => reassemble(await loadActive(tx, tabId, { agentIds: ids })),
  busyClosed?: (tabId: string) => void): Promise<Set<string>> {
  const found = new Set<string>()
  if (!agentIds.length) return found
  // One $in scan of the key index, and only the mark: Prisma's `in` is planned as one index scan per id, and `data` is the whole agent.
  // `exceptTabId` is left out after the read: in the filter the planner took the (tabId, key) index and walked every other Swarm.
  const rows = (await tx.swarmAgent.aggregateRaw({ pipeline: [{ $match: { key: { $in: [...new Set(agentIds)] }, deleted: false } },
    { $project: { _id: 0, tabId: 1, key: 1, confidential: '$data.confidential' } }] }) as unknown as Array<{ tabId: string; key: string; confidential?: Agent['confidential'] }>)
    .filter(row => row.tabId !== exceptTabId)
  const unmarked = new Map<string, string[]>()
  for (const row of rows) {
    if (row.confidential) found.add(row.key)
    else unmarked.set(row.tabId, [...unmarked.get(row.tabId) ?? [], row.key])
  }
  for (const [tabId, keys] of unmarked) {
    const pending = keys.filter(key => !found.has(key))
    if (!pending.length) continue
    let state: SuperTabState
    try {
      state = await stateOf(tabId, pending)
    } catch (error) {
      if (!busyClosed || !(error instanceof SuperTabError) || !RETRYABLE_SWARM_CODES.has(error.code)) throw error
      for (const key of pending) found.add(key)
      busyClosed(tabId)
      continue
    }
    for (const target of state.agents) if (pending.includes(target.id) && confidentialSession(state, target)) found.add(target.id)
  }
  return found
}

/** The other Swarms' registrations a command that registers a session or makes one confidential is checked against
 *  (projects.ts requireSingleRegistration): every session of these machines registered elsewhere, and which of `check`
 *  are confidential there (marked, or a Lead or private member now in a part written before the mark). */
export async function otherRegistrations(tx: Transaction, state: SuperTabState, check: Array<{ machineId: string; harnessId: string }>): Promise<OtherRegistrations> {
  const machineIds = [...new Set([...state.agents.map(a => a.machineId), ...check.map(c => c.machineId)])]
  const rows = await tx.swarmAgent.findMany({ where: { machineId: { in: machineIds }, deleted: false, tabId: { not: state.id } }, select: { tabId: true, key: true, data: true } })
  const registered = new Set<string>(), confidential = new Set<string>(), wanted = new Set(check.map(c => sessionKey(c.machineId, c.harnessId)))
  const unmarked = new Map<string, Agent[]>()
  for (const row of rows) {
    const target = row.data as unknown as Agent, key = sessionKey(target.machineId, target.harnessId)
    registered.add(key)
    if (!wanted.has(key)) continue
    if (target.confidential) confidential.add(key)
    else unmarked.set(row.tabId, [...unmarked.get(row.tabId) ?? [], target])
  }
  for (const [tabId, targets] of unmarked) {
    const there = reassemble(await loadActive(tx, tabId, { agentIds: targets.map(t => t.id) }))
    for (const target of there.agents) if (targets.some(t => t.id === target.id) && confidentialSession(there, target)) confidential.add(sessionKey(target.machineId, target.harnessId))
  }
  return { registered, confidential }
}

/** Records on the native session's shared record (the one each registration writes) that it became confidential. A
 *  registration of the same session committing in another Swarm meanwhile then conflicts with this write, so one of the
 *  two retries and is refused (projects.ts requireSingleRegistration). */
export async function recordConfidential(tx: Transaction, state: SuperTabState, target: Agent, now: number): Promise<void> {
  await bindSession(tx, state, target, now)
  await tx.superTabSessionScope.update({ where: { id: sessionRecordId(state, target) }, data: { confidential: true } })
}
