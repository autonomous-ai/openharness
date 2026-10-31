/** What a failed start's reason says to a group member who is neither its Lead nor its machine's owner. A host's raw reason
 *  can name the machine, a folder on it or a token problem (a privacy check's gitconfig path, the GitHub App token on
 *  2026-10-27), and every member reads the group and its starts (review of #1847). */
import { actorKey, type Actor, type AgentStart, type Conversation, type SuperTabState } from './model.js'
import { projectsOf } from './projects.js'
import { isBuddyChat } from './buddies.js'
import { DEFAULT_COORDINATOR_NAME } from './instructions.js'

export const MACHINE_FAILED = 'Its machine could not prepare or launch it.'
export const TIMED_OUT = 'Its machine did not start it within 3 minutes.'
/** liveness.ts writes `<machine name> did not start it within 3 minutes`. */
export const TIMED_OUT_SUFFIX = ' did not start it within 3 minutes'
/** liveness.ts writes these after a machine named the start as preparing: past its limit, or with its reports stopped. */
export const STILL_PREPARING_SUFFIX = ' was still preparing it after 15 minutes'
export const STOPPED_REPORTING_SUFFIX = ' stopped reporting while preparing it'
/** liveness.ts writes this after a machine named a coordinator's start that it never took (leadStart.ts), with the name its
 *  project calls it. */
export const leadPickupSuffix = (name: string) => ` did not start this ${name}. Harness there may need an update.`
const LEAD_NOT_PICKED = 'Its machine did not start it. Harness there may need an update.'
/** That suffix, and the one written before project instructions, after any name. */
const LEAD_PICKUP = / did not start this .+\. (Harness there may need an update|Update Harness on it, then start it again)\.$/
/** Each suffix the server writes after a machine name, with what a group member reads instead. */
const TIMEOUTS: Array<[string, string]> = [[TIMED_OUT_SUFFIX, TIMED_OUT],
  [STILL_PREPARING_SUFFIX, 'Its machine was still preparing it after 15 minutes.'],
  [STOPPED_REPORTING_SUFFIX, 'Its machine stopped reporting while preparing it.']]
/** Reasons the server writes itself, which name nothing (commands.ts removeMachine and machine.contribute). */
export const MACHINE_REMOVED = 'Its machine was removed from the Swarm.'
export const ABANDONED = 'Abandoned before it started.'
/** A Team account's host refusing a Codex Product Manager it cannot sign in (cli superTabs/start.ts): it names nothing of the
 *  machine but its lack of the owner's relay, which its project reads (security re-check 3 of #2089). */
export const NO_PM_RELAY = 'The owner\'s subscription relay is not available on this machine, so a Codex Product Manager cannot sign in here.'

/** A host's refusal for memory (cli superTabs/capacity.ts memoryShort): its numbers alone, which members already see in the
 *  Machines view. Read only at the start of the reason, so nothing else a host wrote is ever told (Ken's MacBook Pro,
 *  2026-10-28, where "could not prepare or launch it" sent people looking for a fault). */
const MEMORY_SHORT = /^Not enough free memory: (\d+(?:\.\d)? GiB) free, (\d+(?:\.\d)? GiB) needed\./

export function publicReason(error: string): string {
  if (error === MACHINE_REMOVED || error === ABANDONED || error === NO_PM_RELAY) return error
  const memory = MEMORY_SHORT.exec(error)
  if (memory) return `Its machine has only ${memory[1]} of memory free, and it needs ${memory[2]}.`
  if (LEAD_PICKUP.test(error)) return LEAD_NOT_PICKED
  return TIMEOUTS.find(([suffix]) => error.endsWith(suffix))?.[1] ?? MACHINE_FAILED
}

/** The group's notice of a failed start, with the model it asked for (project instructions, phase 4, decision 18): what
 *  happened, never what to do next. Whoever made it, its coordinator ([coordinator], as its project calls it) and its machine's
 *  owner read the raw reason on the start (readsRawReason). */
export function failureNotice(name: string, error: string, model?: string, coordinator = DEFAULT_COORDINATOR_NAME): string {
  const reason = publicReason(error)
  return `Could not start ${name}${model ? ` on ${model}` : ''}: ${reason[0]!.toLowerCase()}${reason.slice(1)}`
    + (reason === MACHINE_FAILED ? ` Whoever started it, the ${coordinator} and the machine owner can read why.` : '')
}

/** The model a start asked for: its grid model, else its model; none when it runs its engine's own. */
export const askedModel = (start: AgentStart): string | undefined => start.request.gridModel ?? start.request.model

/** Who a failed start's notice reaches: its task's coordinator, and the agent that made the start when it is in the task
 *  (project instructions, phase 4, decision 18). */
export function failureRecipients(start: AgentStart, group: Conversation): string[] {
  const coordinator = group.leadId && group.agentIds.includes(group.leadId) ? [group.leadId] : []
  const maker = start.actorKey?.startsWith('agent:') ? start.actorKey.slice('agent:'.length) : null
  return [...new Set([...coordinator, ...maker && group.agentIds.includes(maker) ? [maker] : []])]
}

/** Where a failed start's notice reaches its project's coordinator when the notice in the task does not ([recipients]): a task
 *  with no lead, or one its lead left. Its own chat, to it alone; null when the task's notice reaches it or it has none, so a
 *  failed start is never told to nobody (final review). Never a Buddy's: its owner reads it in their chat, and its name and
 *  model are theirs, not the coordinator's or its terminal's watchers' (security review L1; liveness.ts buddyNotice). */
export function coordinatorCopy(state: SuperTabState, group: Conversation, recipients: readonly string[]): { conversationId: string; coordinator: string } | null {
  if (isBuddyChat(group)) return null
  const chat = state.conversations.find(c => c.id === projectsOf(state).find(p => p.id === (group.projectId ?? 'lead'))?.leadConversationId)
  const coordinator = chat?.leadId && chat.agentIds.includes(chat.leadId) ? chat.leadId : null
  return chat && coordinator && chat.id !== group.id && !recipients.includes(coordinator) ? { conversationId: chat.id, coordinator } : null
}

/** Who reads a start's raw reason: whoever made it, its group's coordinator, and its machine's owner. */
export function readsRawReason(actor: Actor, start: AgentStart, group: Conversation | undefined): boolean {
  if (start.actorKey === actorKey(actor)) return true
  return actor.kind === 'agent' ? !!group?.leadId && group.leadId === actor.agentId : actor.userId === start.machineOwnerId
}
