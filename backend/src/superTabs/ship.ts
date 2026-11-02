import { isLeads, stableId, type Author, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { agentDisplayName } from './agentNames.js'
import { groupProject } from './projects.js'

/** The source of the celebration row Desktop draws with confetti. */
export const SHIP_KIND = 'ship'
/** How a check's `passedBy` names an agent (model.ts actorKey). */
const AGENT_KEY = 'agent:'

/** When the group first shipped, as the leaderboard records it (leaderboard/record.ts `recordStatus`: once, on the first Done). */
export const shippedAt = (group: Conversation): number | undefined => group.ledger?.shippedAt

/** The pull requests whose merge was recorded on [group]: by link, or on a card (cards.ts) for merges recorded before links. */
export const mergedPullRequests = (group: Conversation): string[] =>
  [...new Set([...group.ledger?.mergedUrls ?? [], ...group.cards?.pullRequests?.flatMap(card => card.mergedAt === undefined ? [] : [card.url]) ?? []])]

/** The pull requests a Done delivers: those it names (its result's, else its checks'), plus every merge recorded on the group.
 *  A link merely mentioned in the chat or the brief, or a pull request closed unmerged, is no part of it. */
export function deliveredPullRequests(group: Conversation, named: string[]): string[] {
  return [...new Set([...mergedPullRequests(group), ...named])]
}

/** Whether [before], the group as it was before the command, may still be celebrated: its line has not been posted. A group
 *  from before Shipped waited for the merge keeps the old guard: it was announced at its first ship, so it is only if it
 *  is waiting (Done since) or nothing shipped it yet. */
export const celebrable = (before: Conversation): boolean => {
  const ledger = before.ledger
  return ledger?.shipPostedAt == null && (!!ledger?.shipsAfterMerge || ledger?.shipWaiting !== undefined || ledger?.shippedAt == null)
}

/** Work is Done and every pull request it delivered has merged (and at least one). The project chat gets one line naming who
 *  asked, who built it and who reviewed it. A Done with one still open posts nothing: the caller keeps the group waiting
 *  with the pull requests it named, and the merge that completes them posts it. A private conversation is never celebrated:
 *  its title, words and link are its own. No agent is woken by it. */
export function shipNotice(state: SuperTabState, group: Conversation, author: Author, operationId: string, named: string[]): MessageDraft | null {
  const merged = new Set(mergedPullRequests(group))
  const pullRequests = deliveredPullRequests(group, named)
  if (!pullRequests.length || !pullRequests.every(url => merged.has(url)) || group.audience || group.reviewOf || isLeads(group) || !group.assignment) return null
  const project = groupProject(state, group)
  const agentName = (id: string) => agentDisplayName(state.agents, id) ?? state.agents.find(a => a.id === id)?.name
  const builderIds = [group.assignment.agentId].filter(id => agentName(id))
  // Reviewed by whoever passed a check on it or on a task linked to it, whatever its role, but never by its own assignee
  // (project instructions, phase 4).
  const passers = [group, ...state.conversations.filter(c => c.reviewOf === group.id)].flatMap(c => c.checks)
    .flatMap(c => c.passedBy?.startsWith(AGENT_KEY) ? [c.passedBy.slice(AGENT_KEY.length)] : [])
  const reviewerIds = [...new Set(passers)].filter(id => id !== group.assignment!.agentId && agentName(id))
  const requester = state.people.find(p => p.id === group.requesterId)
  const names = (ids: string[]) => ids.map(agentName).join(' and ')
  const credits = [requester && `requested by ${requester.email.split('@')[0]}`, builderIds.length && `built by ${names(builderIds)}`,
    reviewerIds.length && `reviewed by ${names(reviewerIds)}`].filter(Boolean)
  return { id: stableId(operationId, SHIP_KIND), conversationId: project.leadConversationId, author, replyTo: null, recipients: [],
    text: `🎉 Shipped: ${group.title}${credits.length ? `, ${credits.join(', ')}` : ''}. ${pullRequests.join(' ')}`,
    source: { kind: SHIP_KIND, conversationId: group.id, title: group.title, pullRequests, ...(requester ? { requesterId: requester.id } : {}),
      builderIds, reviewerIds } }
}
