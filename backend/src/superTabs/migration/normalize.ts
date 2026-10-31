/**
 * The state a Swarm is split from (design 6.1.2 step 2): what the next read or command of the old store would have
 * applied, persisted, so behavior after the migration is identical. Link lists are restored from history beforehand
 * (store.ts restorePullRequestUrls); removals that expire and the released-harness cap are left to the first write.
 */
import { activeWork, awaitingWorkers, isLeads, numberConversations, parkLaterConversations, type Conversation, type SuperTabState } from '../model.js'
import { assignAgentDisplayNames } from '../agentNames.js'
import { agentProjectId, placeRules, projectsOf } from '../projects.js'
import { DORMANT_AFTER_MS, type ProgressData } from '../parts/index.js'

/** Report progress as a row from before parts keeps it, in tab revisions. */
interface LegacyProgress { dirtyRevision: number; summarizedRevision: number }

/** Whether the group's last report is past what its Lead summarized: such a group stays awake until it is read, as the
 *  store's sweep keeps it (sweeps.ts, group 2's review round 1). A private conversation never feeds reports. */
function owesReports(state: SuperTabState, group: Conversation): boolean {
  if (group.audience) return false
  const progress = state.projects?.find(p => p.id === (group.projectId ?? 'lead'))?.progress as LegacyProgress | ProgressData | undefined
  if (!progress) return false
  // The split gives a group of a project with old progress the report sequence min(last message, dirty revision).
  if ('dirtyRevision' in progress) return Math.min(group.lastMessageSequence, progress.dirtyRevision) > progress.summarizedRevision
  return (group.reportSeq ?? 0) > (progress.summarized[group.id] ?? progress.summarizedFloor)
}

export function normalize(original: SuperTabState, { now, lastActivity }: { now: number; lastActivity: ReadonlyMap<string, number> }): SuperTabState {
  const state = structuredClone(original)
  parkLaterConversations(state)
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
    if (isLeads(group) || leadGroups.has(group.id) || owesReports(state, group)) continue
    if (group.archived || (finished && quiet)) group.dormant = true
  }
  return state
}
