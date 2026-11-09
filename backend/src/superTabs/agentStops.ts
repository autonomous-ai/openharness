/**
 * Swarm v4 (anh Dee 2026-11-09): only its person stops an agent. The v3 rules stopped agents on their own: an idle agent after
 * 15 minutes, and its PM releasing it after an idle notice. Once, the time checks withdraw every stop no host is closing yet,
 * so a person can talk to their agents again (store.ts runTimeChecks clears the stop's run and session records).
 */
import { isBuddy } from './buddies.js'
import type { SuperTabState } from './model.js'

/** A withdrawn stop: the agent, and the stop's release its run and session records name. */
export interface WithdrawnStop { agentId: string; releaseId: string; machineOwnerId: string }

/** Withdraws, once per Swarm, each agent's stop but those [closing] names (a host holds its close lease); returns what to clear. */
export function withdrawV3Stops(state: SuperTabState, closing: ReadonlySet<string> = new Set()): WithdrawnStop[] {
  if (state.v4StopsWithdrawn) return []
  state.v4StopsWithdrawn = true
  const withdrawn: WithdrawnStop[] = []
  for (const target of state.agents) {
    if (target.workDecision !== 'stop' || isBuddy(target) || !target.releaseId || closing.has(target.id)) continue
    withdrawn.push({ agentId: target.id, releaseId: target.releaseId, machineOwnerId: target.machineOwnerId })
    if (target.idleStop?.previous) target.workDecision = target.idleStop.previous
    else delete target.workDecision
    delete target.releaseId
    delete target.idleStop
  }
  return withdrawn
}

/** The agents [withdrawV3Stops] looks at: stopping, not a Buddy, once per Swarm. */
export const v3Stopping = (state: SuperTabState) =>
  state.v4StopsWithdrawn ? [] : state.agents.filter(a => a.workDecision === 'stop' && !isBuddy(a) && a.releaseId)
