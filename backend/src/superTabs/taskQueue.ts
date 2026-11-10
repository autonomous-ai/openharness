/**
 * A project's Next up (Tasks view, #2569): one sparse rank per task, so a move rewrites only the task moved. An unranked
 * task sorts by its number, so tasks from before ranks keep their order and a new task joins the bottom.
 */
import type { Conversation, SuperTabState } from './model.js'
import { groupProject, type SwarmProject } from './projects.js'

type Queued = Pick<Conversation, 'id' | 'number' | 'queueRank'>
/** Closer than this, two ranks leave no room between them: the whole queue is numbered again. */
const MIN_GAP = 1e-6

export const queueKey = (task: Pick<Conversation, 'number' | 'queueRank'>): number => task.queueRank ?? task.number ?? 0

/** [tasks] in queue order; a tie goes by number. */
export const queueOrder = <T extends Queued>(tasks: readonly T[]): T[] =>
  [...tasks].sort((a, b) => queueKey(a) - queueKey(b) || (a.number ?? 0) - (b.number ?? 0))

/** The tasks a project's Next up orders: open, never its chat, a Buddy chat, a private chat or a step. */
export function queueSiblings(state: SuperTabState, project: SwarmProject): Conversation[] {
  return state.conversations.filter(c => !c.archived && !c.kind && !c.audience && !c.reviewOf && c.id !== project.leadConversationId
    && groupProject(state, c).id === project.id)
}

/** The ranks to write to put [taskId] right after [after] (null: the top): usually the task's alone, every task's 1..n once
 *  the gap it lands in runs out. */
export function placeAfter(siblings: readonly Queued[], taskId: string, after: string | null): Map<string, number> {
  const others = queueOrder(siblings.filter(s => s.id !== taskId))
  const moved = siblings.find(s => s.id === taskId)!
  if (after === null) return new Map([[taskId, others.length ? queueKey(others[0]!) - 1 : queueKey(moved)]])
  const at = others.findIndex(s => s.id === after), previous = others[at]!, next = others[at + 1]
  if (!next) return new Map([[taskId, queueKey(previous) + 1]])
  const low = queueKey(previous), high = queueKey(next)
  if (high - low >= MIN_GAP) return new Map([[taskId, (low + high) / 2]])
  const order = [...others.slice(0, at + 1), moved, ...others.slice(at + 1)]
  return new Map(order.map((s, i) => [s.id, i + 1]))
}
