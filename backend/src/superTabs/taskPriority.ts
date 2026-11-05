/**
 * A task's priority (task #3117): one scale, P0 to P3, for the PM, people and Buddies' proposals, so a hotfix for a broken
 * release no longer waits behind ordinary work until someone says "urgent". A task created without one is P2.
 */
export const TASK_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const
export type TaskPriority = typeof TASK_PRIORITIES[number]

/** What each priority means, as people read it. */
export const PRIORITY_MEANING: Record<TaskPriority, string> = {
  P0: 'Hotfix: something shipped is broken',
  P1: 'Needed by users soon',
  P2: 'Planned goal',
  P3: 'Tools, docs or process',
}

export const DEFAULT_PRIORITY: TaskPriority = 'P2'
export const PRIORITY_DEFAULTED = 'No priority given: this task is P2. Set P0-P3 with work.priority.'

/** A Buddy proposal's low, normal or high on the same scale. A proposal never reaches P0: only the PM or a person sets that. */
export function proposalPriority(value: unknown): TaskPriority {
  return value === 'high' ? 'P1' : value === 'low' ? 'P3' : 'P2'
}

const LEADING = /^\s*URGENT\b\s*:?\s*/i
const TRAILING = /\s*\((?:[^()]*,\s*)?(urgent|high)(?:\s+priority)?\)\s*$/i

/** A task from before priorities by its title, as every client reads it (Desktop backlog.dart superTabTitlePriority): a
 *  leading URGENT or a closing "(urgent)" is P0, a closing "(high)" or "(Name, high)" P1. A marker with no title beside it
 *  marks nothing. */
export function titlePriority(title: string): TaskPriority | null {
  const leading = LEADING.exec(title)
  if (leading && title.length > leading[0].length) return 'P0'
  const trailing = TRAILING.exec(title)
  if (trailing && trailing.index > 0) return trailing[1]!.toLowerCase() === 'urgent' ? 'P0' : 'P1'
  return null
}

/** The line a change writes into its task: who changed it, to what and from what. */
export function priorityLine(actorName: string, next: TaskPriority, previous: TaskPriority): string {
  const meaning = PRIORITY_MEANING[next]
  return `${actorName} changed the priority to ${next}, ${meaning[0]!.toLowerCase()}${meaning.slice(1)} (was ${previous}).`
}
