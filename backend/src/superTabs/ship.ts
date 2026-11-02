import { isLeads, stableId, type Author, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { agentDisplayName } from './agentNames.js'
import { groupProject } from './projects.js'
import { pullRequestCard } from './cards.js'

/** The source of the celebration row Desktop draws with confetti. */
export const SHIP_KIND = 'ship'
/** How a check's `passedBy` names an agent (model.ts actorKey). */
const AGENT_KEY = 'agent:'

/** When the group first shipped, as the leaderboard records it (leaderboard/record.ts `recordStatus`: once, on the first Done). */
export const shippedAt = (group: Conversation): number | undefined => group.ledger?.shippedAt

/** Every pull request the group links has a recorded merge (cards.ts recordCardMerged). A person reads "Shipped" as merged. */
export const allMerged = (group: Conversation): boolean =>
  !!group.pullRequestUrls?.length && group.pullRequestUrls.every(url => pullRequestCard(group, url)?.mergedAt !== undefined)

/** Whether [before], the group as it was before the command, may still be celebrated: not yet, and not already shipped by an
 *  earlier Done (the old line was posted at Done, before any merge). A group is one request: later attempts celebrate nothing. */
export const celebrable = (before: Conversation): boolean =>
  before.ledger?.shipPostedAt == null && (before.ledger?.shippedAt == null || before.ledger.mergedAt != null)

/** Work is Done and every pull request it links has merged. The project chat gets one line naming who asked, who built it and
 *  who reviewed it. Done with a pull request still open posts nothing: the caller marks the group waiting, and the last
 *  recorded merge posts it. A private conversation is never celebrated: its title, words and link are its own. No agent is
 *  woken by it. */
export function shipNotice(state: SuperTabState, group: Conversation, author: Author, operationId: string): MessageDraft | null {
  const pullRequests = group.pullRequestUrls ?? []
  if (!allMerged(group) || group.audience || group.reviewOf || isLeads(group) || !group.assignment) return null
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
