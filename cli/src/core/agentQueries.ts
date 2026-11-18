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
 * - `count`: a bounded observation forwarded with authenticated service provenance; the gateway owns admission;
 * - `hachi_goal_done`: a goal Hachi closed, for every window of the account (`clients.hachiGoalDone`), which decides
 *   whether it is the live Hachi's.
 * Each is read as it is asked, so the service works from the registry as it is at that moment.
 */
import { SERVICE_HOSTS } from '../harnessd/services.js'
import type { ServiceQueryAuthority } from './serviceLinks.js'
import type { CoreApi, HachiGoalDone, ReadReceiver, UsageEvent } from './api.js'

const INVALID = { error: 'INVALID_REQUEST' }

/** A command's parents' pids, as `harness browser` sends them; null for anything else. */
function pidsOf(value: unknown): number[] | null {
  return Array.isArray(value) && value.every(pid => Number.isSafeInteger(pid) && pid > 0) ? value as number[] : null
}

export function answerAgentQuery(core: Pick<CoreApi, 'agents' | 'usage' | 'clients'>, query: string, payload: Record<string, unknown> = {},
  observation?: { service: string; report(event: UsageEvent): void }): Record<string, unknown> | Promise<Record<string, unknown>> {
  if (query === 'hachi_goal_done') {
    const { agentId, goalId, title } = payload
    core.clients.hachiGoalDone?.({ agentId, goalId, title } as HachiGoalDone)
    return { ok: true }
  }
  if (query === 'count') {
    const metric = payload.metric
    if (typeof metric !== 'string' || metric.length > 128 || !/^[a-z0-9_]+$/.test(metric)) return INVALID
    observation?.report({ kind: 'service', service: observation.service, metric })
    return { ok: true }
  }
  if (query === 'agentUsage') {
    const target = payload.target
    if (!validUsageTarget(target)) return { error: 'STALE_USAGE_TARGET' }
    return core.agents.all().then(async rows => {
      if (!rows.some(row => usageTargetKey(row) === usageTargetKey(target))) return { error: 'STALE_USAGE_TARGET' }
      return { target: usageTarget(target), value: await core.usage?.(target) ?? null }
    })
  }
  if (query === 'agent_of_pane') {
    // No parents: an older relay's `agent_browser_state` (core/api.ts `ofPane`).
    const ancestors = payload.ancestors === undefined ? undefined : pidsOf(payload.ancestors)
    if (typeof payload.pane !== 'string' || ancestors === null) return INVALID
    return Promise.resolve(core.agents.ofPane?.(payload.pane, ancestors) ?? null).then(agent => (agent ? { ...agent } : { agentId: null }))
  }
  if (query === 'agents') return core.agents.all().then(rows => ({ agents: rows.map(session => ({ ...session, displayName: core.agents.displayName(session) })) }))
  if (query === 'live') return { agents: core.agents.live() }
  if (query === 'advertised') return { agents: core.agents.advertised() }
  return { error: 'UNKNOWN_QUERY' }
}

/** Only the declared authenticated readers may open this complete per-row read. */
export async function answerSessionRead(core: Pick<CoreApi, 'agents'>, service: string, query: string,
  receive: ReadReceiver<unknown, unknown>, signal: AbortSignal, authority: Pick<ServiceQueryAuthority, 'current'>): Promise<void> {
  const host = Object.values(SERVICE_HOSTS).find(host => host.services.includes(service))
  if (!host?.reads || !Object.hasOwn(host.reads, service) || !host.reads[service].includes(query)) throw new Error('READ_NOT_DECLARED')
  if (!authority.current?.()) throw new Error('SESSION_READ_UNAVAILABLE')
  await core.agents.readSessions((record, settled) => {
    if (!authority.current?.()) { settled(false); return false }
    return receive(record, settled)
  }, signal)
  if (!authority.current()) throw new Error('SESSION_READ_UNAVAILABLE')
}
