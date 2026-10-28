/** What a failed start's reason says to a group member who is neither its Lead nor its machine's owner. A host's raw reason
 *  can name the machine, a folder on it or a token problem (a privacy check's gitconfig path, the GitHub App token on
 *  2026-10-27), and every member reads the group and its starts (review of #1847). */
import { actorKey, type Actor, type AgentStart, type Conversation } from './model.js'

export const MACHINE_FAILED = 'Its machine could not prepare or launch it.'
export const TIMED_OUT = 'Its machine did not start it within 3 minutes.'
/** liveness.ts writes `<machine name> did not start it within 3 minutes`. */
export const TIMED_OUT_SUFFIX = ' did not start it within 3 minutes'
/** Reasons the server writes itself, which name nothing (commands.ts removeMachine and machine.contribute). */
export const MACHINE_REMOVED = 'Its machine was removed from the Swarm.'
export const ABANDONED = 'Abandoned before it started.'

export function publicReason(error: string): string {
  if (error === MACHINE_REMOVED || error === ABANDONED) return error
  return error.endsWith(TIMED_OUT_SUFFIX) ? TIMED_OUT : MACHINE_FAILED
}

/** The group's notice of a failed start; its Lead, woken by it, reads the raw reason on the start. */
export function failureNotice(name: string, error: string): string {
  const reason = publicReason(error)
  return `Could not start ${name}: ${reason[0]!.toLowerCase()}${reason.slice(1)}${reason === MACHINE_FAILED ? ' The Lead and the machine owner can read why.' : ''}`
}

/** Who reads a start's raw reason: whoever made it, its group's Lead, and its machine's owner. */
export function readsRawReason(actor: Actor, start: AgentStart, group: Conversation | undefined): boolean {
  if (start.actorKey === actorKey(actor)) return true
  return actor.kind === 'agent' ? !!group?.leadId && group.leadId === actor.agentId : actor.userId === start.machineOwnerId
}
