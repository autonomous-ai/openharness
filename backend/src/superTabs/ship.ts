import { agentRole, isLeads, stableId, type Author, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { agentDisplayName } from './agentNames.js'
import { groupProject } from './projects.js'

/** The source of the celebration row Desktop draws with confetti. */
export const SHIP_KIND = 'ship'

/** When the group first shipped, as the leaderboard records it (leaderboard/record.ts `recordStatus`: once, on the first Done). */
export const shippedAt = (group: Conversation): number | undefined => group.ledger?.shippedAt

/** Work just became Done. When it links a pull request, the project chat gets one line naming who asked, who built it and
 *  who reviewed it ("Done with a linked PR" is shipped: Leads mark Done after the merge). A private conversation is never
 *  celebrated: its title, words and link are its own. No agent is woken by it. A group is one request: only its first ship is
 *  celebrated, not a later attempt's Done (the caller checks `shippedAt` from before the command). */
export function shipNotice(state: SuperTabState, group: Conversation, author: Author, operationId: string): MessageDraft | null {
  const pullRequests = group.pullRequestUrls ?? []
  if (!pullRequests.length || group.audience || group.reviewOf || isLeads(group) || !group.assignment) return null
  const project = groupProject(state, group)
  const agentName = (id: string) => agentDisplayName(state.agents, id) ?? state.agents.find(a => a.id === id)?.name
  const builderIds = [group.assignment.agentId].filter(id => agentName(id))
  const reviewGroups = state.conversations.filter(c => c.reviewOf === group.id)
  const reviewerIds = [...new Set([group, ...reviewGroups].flatMap(c => c.agentIds))]
    .filter(id => !builderIds.includes(id) && state.agents.some(a => a.id === id && agentRole(a) === 'reviewer'))
  const requester = state.people.find(p => p.id === group.requesterId)
  const names = (ids: string[]) => ids.map(agentName).join(' and ')
  const credits = [requester && `requested by ${requester.email.split('@')[0]}`, builderIds.length && `built by ${names(builderIds)}`,
    reviewerIds.length && `reviewed by ${names(reviewerIds)}`].filter(Boolean)
  return { id: stableId(operationId, SHIP_KIND), conversationId: project.leadConversationId, author, replyTo: null, recipients: [],
    text: `🎉 Shipped: ${group.title}${credits.length ? `, ${credits.join(', ')}` : ''}. ${pullRequests.join(' ')}`,
    source: { kind: SHIP_KIND, conversationId: group.id, title: group.title, pullRequests, ...(requester ? { requesterId: requester.id } : {}),
      builderIds, reviewerIds } }
}
