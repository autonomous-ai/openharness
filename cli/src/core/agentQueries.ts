import { usageTargetKey, usageTarget, validUsageTarget } from '../lib/agentUsageWire.js'
/**
 * What a service in its own process may ask the core of the agents (`service_query`, core/serviceLinks.ts)
 * when it has no link module of its own to answer it (the viewers and workspaces do):
 * - `agents`: every agent, live then stopped, with the name the apps show for it (search indexes them; the agent browser
 *   keeps no browser for an agent in neither);
 * - `live`: the live agents, as `CoreApi.agents.live` answers in the core's process (the project readers);
 * - `advertised`: the live agents the apps are shown (the monitor samples them);
 * - `agentUsage`: an agent's cached usage reading;
 * - `agent_of_pane`: the live agent of a pane and whether it is a guest's, held to the parents of the command that names
 *   it (`CoreApi.agents.ofPane`): `harness browser` names its pane so;
 * - `count`: one of the counters a service may hand on, none other (lib/serviceMetrics.ts `SERVICE_METRICS`): a service
 *   in its own process has no other way to the recorder;
 * - `hachi_goal_done`: a goal Hachi closed, for every window of the account (`clients.hachiGoalDone`), which decides
 *   whether it is the live Hachi's.
 * Each is read as it is asked, so the service works from the registry as it is at that moment.
 */
import type { ProductUsageMetric } from '../lib/productUsageContract.js'
import { SERVICE_METRICS } from '../lib/serviceMetrics.js'
import type { CoreApi, HachiGoalDone } from './api.js'

const INVALID = { error: 'INVALID_REQUEST' }

/** A command's parents' pids, as `harness browser` sends them; null for anything else. */
function pidsOf(value: unknown): number[] | null {
  return Array.isArray(value) && value.every(pid => Number.isSafeInteger(pid) && pid > 0) ? value as number[] : null
}

export function answerAgentQuery(core: Pick<CoreApi, 'agents' | 'usage' | 'count' | 'clients'>, query: string, payload: Record<string, unknown> = {}): Record<string, unknown> | Promise<Record<string, unknown>> {
  if (query === 'hachi_goal_done') {
    const { agentId, goalId, title } = payload
    core.clients.hachiGoalDone?.({ agentId, goalId, title } as HachiGoalDone)
    return { ok: true }
  }
  if (query === 'count') {
    if (typeof payload.metric !== 'string' || !SERVICE_METRICS.has(payload.metric)) return INVALID
    core.count?.(payload.metric as ProductUsageMetric)
    return { ok: true }
  }
  if (query === 'agentUsage') {
    const target = payload.target
    if (!validUsageTarget(target) || !core.agents.all().some(row => usageTargetKey(row) === usageTargetKey(target))) return { error: 'STALE_USAGE_TARGET' }
    return Promise.resolve(core.usage?.(target) ?? null).then(value => ({ target: usageTarget(target), value }))
  }
  if (query === 'agent_of_pane') {
    // No parents: an older relay's `agent_browser_state` (core/api.ts `ofPane`).
    const ancestors = payload.ancestors === undefined ? undefined : pidsOf(payload.ancestors)
    if (typeof payload.pane !== 'string' || ancestors === null) return INVALID
    return Promise.resolve(core.agents.ofPane?.(payload.pane, ancestors) ?? null).then(agent => (agent ? { ...agent } : { agentId: null }))
  }
  if (query === 'agents') return { agents: core.agents.all().map((session) => ({ ...session, displayName: core.agents.displayName(session) })) }
  if (query === 'live') return { agents: core.agents.live() }
  if (query === 'advertised') return { agents: core.agents.advertised() }
  return { error: 'UNKNOWN_QUERY' }
}
