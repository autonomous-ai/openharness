/**
 * Stuck work is flagged at once to the PM and the people on the task (task #3915, Tony 11-06: #3821 sat with red checks and a
 * lost Test step, and nobody told him; the same day Mac 3's terminal stopped and Engineers and Testers were down for an hour
 * with only scattered "could not start" notices). A task is stuck when its agent went down and nobody took it for
 * STUCK_DOWN_MS. The time checks (store.ts runTimeChecks, every Swarm at least every 5
 * minutes) tell each change once, in one line in the task, written as its PM to its PM and tagging its people, so it is in
 * their Needs you; when it is fixed one line says so and the tags resolve. The record on the task is the deduplication.
 */
import { agentDisplayName } from './agentNames.js'
import { MAX_MENTIONS } from './mentions.js'
import type { Conversation, SuperTabState } from './model.js'

/** How long a task whose agent went down waits for a taker before its people hear it. */
export const STUCK_DOWN_MS = 10 * 60_000
/** The people a task keeps as its writers (Conversation.writers): with its requester, at most MAX_MENTIONS. */
const WRITERS_KEPT = MAX_MENTIONS - 1

/** [personId] posted in [group]: its writers, newest last, at most WRITERS_KEPT. */
export function noteWriter(group: Conversation, personId: string): void {
  const writers = group.writers ?? []
  if (writers.at(-1) === personId) return
  group.writers = [...writers.filter(id => id !== personId), personId].slice(-WRITERS_KEPT)
}

/** Why a task is stuck now: the key that names this reason (a new key is a new line), what its line says and what its fix says. */
interface Stuck { key: string; text: string; fixed: string }

const minutes = (ms: number) => { const n = Math.max(0, Math.floor(ms / 60_000)); return `${n} minute${n === 1 ? '' : 's'}` }

/** Why [task] is stuck at [now], or null: its own agent down. */
export function stuckOf(state: SuperTabState, task: Conversation, now: number): Stuck | null {
  const assignment = task.assignment
  if (!assignment) return null
  if (assignment.status === 'lost') {
    const since = assignment.lost?.at ?? now
    if (now - since < STUCK_DOWN_MS) return null
    const who = agentDisplayName(state.agents, assignment.agentId) ?? 'Its agent'
    return { key: `down:${assignment.id}`, text: `Stuck: ${who} went down ${minutes(now - since)} ago and nobody has taken this task.`,
      fixed: 'this task has an agent again' }
  }
  return null
}



