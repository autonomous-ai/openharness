/**
 * The state a Swarm is split from (design 6.1.2 step 2): what the next read or command of the old store would have
 * applied, persisted, so behavior after the migration is identical. Link lists are restored from history beforehand
 * (store.ts restorePullRequestUrls); removals that expire and the released-harness cap are left to the first write.
 */
import { activeWork, awaitingWorkers, isLeads, numberConversations, parkLaterConversations, syncLeads, type SuperTabState } from '../model.js'
import { assignAgentDisplayNames } from '../agentNames.js'
import { agentProjectId, placeRules, projectsOf } from '../projects.js'
import { DORMANT_AFTER_MS } from '../parts/index.js'

export function normalize(original: SuperTabState, { now, lastActivity }: { now: number; lastActivity: ReadonlyMap<string, number> }): SuperTabState {
  const state = structuredClone(original)
  parkLaterConversations(state)
  syncLeads(state)
  numberConversations(state)
  placeRules(state)
  assignAgentDisplayNames(state.agents)
  if (state.projects) for (const agent of state.agents) agent.projectId ??= agentProjectId(state, agent)
  for (const project of projectsOf(state)) for (const worker of awaitingWorkers(state, project.id)) worker.workDecision = 'awaiting'
  const leadGroups = new Set(projectsOf(state).map(p => p.leadConversationId))
  for (const group of state.conversations) {
    const finished = !!group.assignment && !activeWork(group) && group.assignment.status !== 'stopped'
    // A group with no message counts as active now; the archive sweep takes it a day later if it stays quiet.
    const quiet = now - (lastActivity.get(group.id) ?? now) > DORMANT_AFTER_MS
    if (group.archived || (finished && quiet && !isLeads(group) && !leadGroups.has(group.id))) group.dormant = true
  }
  return state
}
