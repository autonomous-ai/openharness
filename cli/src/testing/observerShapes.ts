/** Former-code composition for moving optional search and usage observations out of core. */
import { AgentTokenUsageCache } from '../lib/agentTokenUsage.js'
import { ExternalSessions, OpenSessions, type ExternalSessionsOptions, type OpenSessionsOptions } from '../lib/sessionSearch/external.js'
import { createAdoption, type AdoptDeps } from '../core/agents/adopt.js'

export function externalShapes(sessionsOptions: ExternalSessionsOptions, openOptions: OpenSessionsOptions,
  own: Pick<AdoptDeps, 'bySession' | 'byAgent' | 'stoppedAgents' | 'search'>) {
  const sessions = new ExternalSessions(sessionsOptions)
  const open = new OpenSessions(openOptions)
  const adoption = createAdoption({ ...own, externalSessions: sessions, openSessions: open })
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
  return new AgentTokenUsageCache(...args)
}
