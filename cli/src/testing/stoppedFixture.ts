/** In-memory archive answers for control-layer fixtures; storage tests exercise the actual filesystem. */
import type { RegisteredSession } from '../lib/registry.js'
import type { StoppedAgentStore } from '../lib/stoppedAgents.js'
import { externalReservations } from '../lib/externalResume.js'
import { relative, isAbsolute } from 'node:path'

export function stoppedFixture(rows: () => readonly RegisteredSession[] = () => []): Pick<StoppedAgentStore, 'get' | 'current' | 'query'> {
  return {
    get: async id => rows().find(row => row.agentId === id) ?? null,
    current: row => rows().includes(row),
    query: async query => {
      const before = JSON.stringify(rows())
      if (query.kind === 'folder') {
        const contains = (parent: string, child: string) => { const part = relative(parent, child); return !part || !isAbsolute(part) && part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') }
        return { witness: 'fixture', matches: [rows().some(row => row.agentId !== query.exceptAgentId && row.cwd
          && (contains(query.root, row.cwd) || contains(row.cwd, query.root)))], current: () => JSON.stringify(rows()) === before }
      }
      if (query.kind !== 'conversations') throw new Error('Unexpected archive query in handoff fixture')
      return { witness: 'fixture', matches: query.ids.map((id, index) => rows().some(row =>
        row.agentId !== query.exceptAgentId && row.agentId !== query.exceptAgentIds?.[index]
          && (query.reservations ? externalReservations(row).includes(id) : row.sessionId === id))),
      current: () => JSON.stringify(rows()) === before }
    },
  }
}
