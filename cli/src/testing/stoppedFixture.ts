/** In-memory archive answers for control-layer fixtures; storage tests exercise the actual filesystem. */
import type { RegisteredSession } from '../lib/registry.js'
import type { StoppedAgentStore } from '../lib/stoppedAgents.js'
import { externalReservations } from '../lib/externalResume.js'

export function stoppedFixture(rows: () => readonly RegisteredSession[] = () => []): Pick<StoppedAgentStore, 'get' | 'current' | 'query'> {
  return {
    get: async id => rows().find(row => row.agentId === id) ?? null,
    current: row => rows().includes(row),
    query: async query => {
      if (query.kind !== 'conversations') throw new Error('Unexpected archive query in handoff fixture')
      const before = JSON.stringify(rows())
      return { witness: 'fixture', matches: query.ids.map((id, index) => rows().some(row =>
        row.agentId !== query.exceptAgentId && row.agentId !== query.exceptAgentIds?.[index]
          && (query.reservations ? externalReservations(row).includes(id) : row.sessionId === id))),
      current: () => JSON.stringify(rows()) === before }
    },
  }
}
