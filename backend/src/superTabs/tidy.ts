import { isBuddy, isSwarmBuddy } from './buddies.js'
import { buddyEngineChat } from './buddyEngine.js'
import { expiredModelRequests, unservedBuddyModels } from './buddyModel.js'
import { agentDisplayName } from './agentNames.js'
import { stableId, type Actor, type Agent, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { canReadGroup, ledProject } from './projects.js'

// Dee, 2026-11-06: the server handles routine idle decisions. After 15 minutes it requests a host-confirmed stop for an
// idle non-crew Engineer and keeps Reviewers/Testers; standing crew use their existing sleep/wake keeper. Tidying governs
// auto-archive only. The PM's notice is information, not work it has to carry out.


/** How long a PM's switch request waits for its machine to claim it (agent.switchClaim) before it is dropped. */
export const SWITCH_UNCLAIMED_MS = 2 * 60_000

const time = (value: string | undefined) => value === undefined ? undefined : Date.parse(value)

/** The loaded groups an agent belongs to or worked in. */
export const groupsOf = (state: SuperTabState, target: Agent): Conversation[] =>
  state.conversations.filter(c => c.agentIds.includes(target.id) || c.assignment?.agentId === target.id)

/** When the agent last had anything to do: its start, its coordinator's keep, its own progress, or a message in one of its
 *  groups. An agent the Swarm started that never had an assignment (no task of its own, never lost one) only sits in its
 *  groups, whose messages are about others' work: it is idle from its start or keep (Swarm autonomous-harness, 2026-10-29:
 *  one sat idle 18+ minutes, its time renewed by every message in a busy chat). One a person added by hand has no start of
 *  record, so its groups' messages count, from the one it joined in. A person talking with it counts either way: an agent
 *  a person is chatting with is never idle (hieule, 11-06, task #3816). Undefined when nothing tells when. */
export function idleSince(target: Agent, groups: Conversation[]): number | undefined {
  const worked = !!target.lostTask || groups.some(g => g.assignment?.agentId === target.id) || !target.startedSession
  const seen = [time(target.startedSession?.createdAt), target.keptAt, ...groups.flatMap(g => [g.talkedAt?.[target.id]?.person, g.talkedAt?.[target.id]?.answer]),
    ...(worked ? groups : []).flatMap(g => [time(g.lastActivityAt),
    ...g.assignment?.agentId === target.id ? [g.assignment.progressAt, g.assignment.lost?.at] : []])]
    .filter((t): t is number => t !== undefined && Number.isFinite(t))
  return seen.length ? Math.max(...seen) : undefined
}



/** Whether a switch request ran out: nobody claimed it in 2 minutes, or its claim's lease lapsed. */
export const switchExpired = (request: NonNullable<Agent['switchRequest']>, now: number): boolean =>
  now >= (request.claimedUntil === undefined ? Date.parse(request.at) + SWITCH_UNCLAIMED_MS : Date.parse(request.claimedUntil))

/** A switch request that ran out is dropped (the PM keeps its engine), and its project chat says so once: the host that never
 *  answered cannot. Run by the liveness sweep, which any machine's report drives, as the PM's own host may be the one down. */
export function staleSwitches(state: SuperTabState, now: number): MessageDraft[] {
  const rows: MessageDraft[] = []
  for (const pm of state.agents) {
    const request = pm.switchRequest, project = request && ledProject(state, pm.id)
    const chat = isSwarmBuddy(pm) && !pm.buddySession ? buddyEngineChat(state, pm) : project?.leadConversationId
    if (!request || !chat) continue
    if (!switchExpired(request, now)) continue
    delete pm.switchRequest
    rows.push({ id: stableId('switch-stale', pm.id, request.id), conversationId: chat, replyTo: null, recipients: [],
      author: { kind: 'agent', id: pm.id, name: pm.name, displayName: agentDisplayName(state.agents, pm.id), membershipGeneration: pm.membershipGeneration },
      text: `Couldn't switch ${isBuddy(pm) ? 'your Buddy' : 'the PM'}: its machine did not answer.`, source: { kind: 'switch', agentId: pm.id } })
  }
  return rows
}

export { BUDDY_MODEL_GONE_MS, BUDDY_MODEL_LEASE_MS } from './buddyModel.js'

/** A Buddy's model switch its machine never reported is dropped (the Buddy stays where it was), and its owner's Buddy chat
 *  says so once. Run by the liveness sweep, as staleSwitches is: the Buddy's own machine may be the one down. */
export function staleModelRequests(state: SuperTabState, now: number): MessageDraft[] {
  const drafts = expiredModelRequests(state, now).map(({ buddy, requestId, conversationId, text, machines }): MessageDraft => ({
    id: stableId('buddy-model-stale', buddy.id, requestId), conversationId, replyTo: null, recipients: [], text,
    source: { kind: 'system', ...(machines.length ? { machines } : {}) },
    author: { kind: 'agent', id: buddy.id, name: buddy.name, displayName: agentDisplayName(state.agents, buddy.id), membershipGeneration: buddy.membershipGeneration } }))
  // After the expiry, so a Buddy whose machine never answered one request home is asked again on the next sweep.
  unservedBuddyModels(state, now, buddy => stableId('buddy-model-gone', buddy.id, String(now)))
  return drafts
}

/** Work that ended without finishing: only a cancel with a reason closes it, never an archive alone (#558). */
export const unfinishedWork = (group: Conversation): boolean => ['lost', 'stopped'].includes(group.assignment?.status ?? '')

/** Who hears that a group archives without shipping: the person who asked for its cancelled task, unless they archive it
 *  themselves or can no longer read it (#558). */
export function cancelledTags(state: SuperTabState, group: Conversation, actor?: Actor): string[] {
  if (group.assignment?.status !== 'cancelled' || !group.requesterId) return []
  if (actor?.kind === 'person' && actor.userId === group.requesterId) return []
  const requester = state.people.find(p => p.id === group.requesterId)
  return requester && canReadGroup(state, { kind: 'person', userId: requester.id, email: requester.email }, group) ? [requester.id] : []
}

/** Why a cancelled task ended, as its cancel recorded it, without the final full stop. */
export const cancelReason = (group: Conversation): string => (group.assignment?.result ?? '').replace(/[.\s]+$/, '')
