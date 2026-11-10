import { isLeads, type Conversation, type SuperTabState } from './model.js'
import { groupProject, type SwarmProject } from './projects.js'
import type { ProgressData } from './parts/types.js'

// The coordinator is no longer woken to rewrite the status card (task #3593), so nothing marks a work group for a report. What
// stays is the watermark an older host's project.report still moves, and the check that a group owes its project nothing
// before it sleeps.

/** The conversations whose posts count toward a project's reports: not its Lead conversation, not the Leads
 *  conversation, not a private conversation (its posts never reach the Lead's summary to everyone). */
export function reportGroups(state: SuperTabState, project: SwarmProject): Conversation[] {
  return state.conversations.filter(c => !isLeads(c) && !c.audience && c.id !== project.leadConversationId && groupProject(state, c).id === project.id)
}

/** How a report names [group]: its number (its title when it has none); a step also names its task (task steps design), and
 *  keeps its own number, which is the conversation whose messages the report asks the coordinator to read. */
export function reportedAs(state: SuperTabState, group: Conversation): string {
  const name = (g: Conversation) => g.number !== undefined ? `#${g.number}` : JSON.stringify(g.title)
  const task = group.reviewOf ? state.conversations.find(c => c.id === group.reviewOf) : undefined
  return task ? `${name(group)} (step ${group.step ?? group.title} of ${name(task)})` : name(group)
}

/** A Lead's report: each conversation it names is summarized through what it read, never past its last report. A legacy
 *  scalar from a wake-up written before the split covers every conversation up to that tab revision. */
export function summarize(state: SuperTabState, project: SwarmProject, through: Record<string, number>): void {
  const progress = project.progress
  if (!progress) return
  for (const group of reportGroups(state, project)) {
    if (!(group.id in through)) continue
    progress.summarized[group.id] = Math.max(progress.summarized[group.id] ?? progress.summarizedFloor, Math.min(through[group.id]!, group.reportSeq ?? 0))
  }
}

/** Whether a report answers the latest wake-up: with it, everything a wake-up asked for is summarized. A wake-up from
 *  before the store by parts asked through a tab revision, which only a legacy scalar can reach. */
export function answersRequest(progress: ProgressData, legacy: number | undefined): boolean {
  // Nothing asked since the split: a pre-split wake-up's tab revision is reached only by a legacy scalar; a map answers any other.
  if (!Object.keys(progress.requested).length) return legacy === undefined || legacy >= progress.requestedFloor
  return Object.entries(progress.requested).every(([id, seq]) => (progress.summarized[id] ?? progress.summarizedFloor) >= seq)
}
