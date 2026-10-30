/**
 * The assignment a Swarm command names, filled in for the agent when it says `current`, and named in the refusal when it
 * names a stale one.
 *
 * A Codex Builder on gpt-6-luna (Mac Auto, task #13, 2026-10-29) did its task, then could not record it done: it sent its
 * start id and then a made-up id as `assignmentId`, the backend refused both ("STALE_ASSIGNMENT: This is no longer the
 * active assignment.") without saying which one is, and the task stayed open until the Lead cancelled it. An agent may now
 * write `current` (or leave it out), and a stale id is answered with the one to use.
 */
import { ENDED_WORK } from './wire.js'

type Json = Record<string, unknown>
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}

/** The commands that name an assignment, and those an agent sends only for its own task. */
export const ASSIGNMENT_COMMANDS: ReadonlySet<string> = new Set(['work.status', 'work.check', 'work.cancel', 'work.resume'])
const OWN_TASK: ReadonlySet<string> = new Set(['work.status', 'work.check'])
const CURRENT = 'current'

/** The group's active assignment in a Swarm's state (its old shape, as the daemon reassembles it), or null. */
export function currentAssignment(state: unknown, conversationId: unknown): { id: string; agentId: string } | null {
  const conversations = object(state).conversations
  const group = (Array.isArray(conversations) ? conversations.map(object) : []).find(c => c.id === conversationId)
  const assignment = object(group?.assignment)
  return typeof assignment.id === 'string' && typeof assignment.agentId === 'string' ? { id: assignment.id, agentId: assignment.agentId } : null
}

/** The one group whose active assignment [agentId] holds, or null when it holds none or several.
 *
 *  A Codex Builder on Mac Auto (Swarm group #17, 2026-10-30) sent its first work.check with "current" but no
 *  conversationId; the backend refused it, the check stayed pending, and its done came back CHECKS_PENDING. */
export function ownGroup(state: unknown, agentId: string): string | null {
  const conversations = object(state).conversations
  const held = (Array.isArray(conversations) ? conversations.map(object) : []).filter(c => {
    const assignment = object(c.assignment)
    return typeof c.id === 'string' && assignment.agentId === agentId && !ENDED_WORK.includes(String(assignment.status))
  })
  return held.length === 1 ? held[0].id as string : null
}

/** Whether [command] asks for its group's current assignment: `current`, or no id at all. */
export const wantsCurrent = (command: Json) => ASSIGNMENT_COMMANDS.has(String(command.type))
  && (command.assignmentId === undefined || command.assignmentId === null || command.assignmentId === '' || command.assignmentId === CURRENT)

/** [command] with `current` replaced by the group's assignment: for a status or check, only the one this agent holds.
 *  Unchanged when there is none, so the backend refuses it as it would have. */
export function withCurrentAssignment(command: Json, state: unknown, agentId: string): Json {
  if (!wantsCurrent(command)) return command
  // A status or check with no group names the agent's own task's group, when it holds exactly one.
  const group = OWN_TASK.has(String(command.type)) && !command.conversationId ? ownGroup(state, agentId) : null
  if (group) command = { ...command, conversationId: group }
  const current = currentAssignment(state, command.conversationId)
  if (!current || (OWN_TASK.has(String(command.type)) && current.agentId !== agentId)) return command
  return { ...command, assignmentId: current.id }
}

/** What a stale-assignment refusal adds, so the agent can send it again right: the id to use, or why there is none. */
export function staleAssignmentHint(command: Json, state: unknown, agentId: string): string {
  const current = currentAssignment(state, command.conversationId)
  if (!current) return 'This group has no active assignment now.'
  if (OWN_TASK.has(String(command.type)) && current.agentId !== agentId) return 'This group\'s active assignment is another agent\'s, not yours.'
  return `This group's active assignment is ${current.id}: send it again with "assignmentId": "${current.id}" (or "current").`
}
