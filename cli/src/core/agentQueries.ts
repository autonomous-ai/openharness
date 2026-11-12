import { usageTargetKey, usageTarget, validUsageTarget } from '../lib/agentUsageWire.js'
/**
 * What a service in its own process may ask the core of the agents (`service_query`, core/serviceLinks.ts)
 * when it has no link module of its own to answer it (the viewers and workspaces do):
 * - `agents`: every agent, live then stopped, with the name the apps show for it (search indexes them);
 * - `live`: the live agents, as `CoreApi.agents.live` answers in the core's process (the project readers);
 * - `advertised`: the live agents the apps are shown (the monitor samples them);
 * - `agentUsage`: an agent's cached usage reading;
 * - `count`: one of Hachi's daemon counters, none other (`HACHI_DAEMON_METRICS`), as the agent browser's process hands
 *   on its own (core/agentBrowserLink.ts): Hachi's services in the edge host have no other way to the recorder;
 * - `hachi_goal_done`: a goal Hachi closed, for every window of the account (`clients.hachiGoalDone`), which decides
 *   whether it is the live Hachi's.
 * Each is read as it is asked, so the service works from the registry as it is at that moment.
 */
import { HACHI_DAEMON_METRICS, type HachiDaemonMetric } from '../lib/hachiMetrics.js'
import type { CoreApi, HachiGoalDone } from './api.js'

const COUNTED: ReadonlySet<unknown> = new Set(HACHI_DAEMON_METRICS)

export function answerAgentQuery(core: Pick<CoreApi, 'agents' | 'usage' | 'count' | 'clients'>, query: string, payload: Record<string, unknown> = {}): Record<string, unknown> | Promise<Record<string, unknown>> {
  if (query === 'hachi_goal_done') {
    const { agentId, goalId, title } = payload
    core.clients.hachiGoalDone?.({ agentId, goalId, title } as HachiGoalDone)
    return { ok: true }
  }
  if (query === 'count') {
    if (!COUNTED.has(payload.metric)) return { error: 'INVALID_REQUEST' }
    core.count?.(payload.metric as HachiDaemonMetric)
    return { ok: true }
  }
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
