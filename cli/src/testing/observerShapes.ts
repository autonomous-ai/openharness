import { createAgentUsage } from '../services/agentUsage.js'
import { createUsageLink } from '../core/usageLink.js'
import type { AgentUsageTarget } from '../lib/agentUsageWire.js'
/** Former-code composition for moving optional search and usage observations out of core. */
import type { AgentTokenUsageCache } from '../lib/agentTokenUsage.js'
import { ExternalSessions, OpenSessions, type ExternalSessionsOptions, type OpenSessionsOptions } from '../lib/sessionSearch/external.js'
import { createExternalSessions } from '../services/externalSessions.js'
import { externalSessionAnswer } from '../lib/externalSessionWire.js'
import type { RegisteredSession } from '../lib/registry.js'
import { createAdoption } from '../core/agents/adopt.js'

export function externalShapes(sessionsOptions: ExternalSessionsOptions, openOptions: OpenSessionsOptions,
  own: { bySession(id: string): RegisteredSession | undefined; byAgent(id: string): RegisteredSession | undefined;
    stoppedAgents: { list(): Pick<RegisteredSession, 'sessionId'>[] }; search: { session(id: string): { title?: string } | undefined } }) {
  const readers = createExternalSessions({ ...sessionsOptions, open: openOptions,
    generation: () => 'ps:1', title: id => own.search.session(id)?.title })
  const { sessions, open } = readers
  const adoption = createAdoption({ inspect: async request => externalSessionAnswer(JSON.parse(JSON.stringify(await readers.inspect(request))), request),
    held: id => !!own.bySession(id) || own.stoppedAgents.list().some(row => row.sessionId === id) })
  return {
    scan: () => sessions.scan(),
    lookup: async (id: string) => sessions.get(id) ?? (await sessions.scan(), sessions.get(id)),
    owner: (id: string) => open.owner(id),
    busy: (owner: Parameters<OpenSessions['busy']>[0]) => open.busy(owner),
    known: () => Object.fromEntries(open.known()),
    fresh: async () => Object.fromEntries(await open.fresh()),
    working: (id: string) => open.working(id),
    adoption,
  }
}

export function usageShapes(...args: ConstructorParameters<typeof AgentTokenUsageCache>) {
  let onChanged: ((target: AgentUsageTarget) => void) | undefined
  const reader = createAgentUsage(...args)
  const link = createUsageLink({ call: payload => reader.read(JSON.parse(JSON.stringify(payload))), now: args[1]?.now,
    changed: target => onChanged?.(target) })
  return { ...link.port, settled: link.settled, dispose: () => { link.port.stop(); reader.stop() },
    get onChanged() { return onChanged }, set onChanged(value) { onChanged = value } }
}
