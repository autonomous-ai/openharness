import { usageTargetKey, usageTarget, validUsageTarget } from '../lib/agentUsageWire.js'
/**
 * What a service in its own process may ask the core of the agents (`service_query`, core/serviceLinks.ts)
 * when it has no link module of its own to answer it (the viewers, workspaces and the teams do):
 * - `agents`: every agent, live then stopped, with the name the apps show for it (search indexes them);
 * - `live`: the live agents, as `CoreApi.agents.live` answers in the core's process (the project readers);
 * - `advertised`: the live agents the apps are shown (the monitor samples them).
 * Each is read as it is asked, so the service works from the registry as it is at that moment.
 */
import type { CoreApi } from './api.js'

export function answerAgentQuery(core: Pick<CoreApi, 'agents' | 'usage'>, query: string, payload: Record<string, unknown> = {}): Record<string, unknown> | Promise<Record<string, unknown>> {
  if (query === 'agentUsage') {
    const target = payload.target
    if (!validUsageTarget(target) || !core.agents.all().some(row => usageTargetKey(row) === usageTargetKey(target))) return { error: 'STALE_USAGE_TARGET' }
    return Promise.resolve(core.usage?.(target) ?? null).then(value => ({ target: usageTarget(target), value }))
  }
  if (query === 'agents') return { agents: core.agents.all().map((session) => ({ ...session, displayName: core.agents.displayName(session) })) }
  if (query === 'live') return { agents: core.agents.live() }
  if (query === 'advertised') return { agents: core.agents.advertised() }
  return { error: 'UNKNOWN_QUERY' }
}
