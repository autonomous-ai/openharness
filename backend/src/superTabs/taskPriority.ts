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

/** The line a change writes into its task: who changed it, to what and from what. */
export function priorityLine(actorName: string, next: TaskPriority, previous: TaskPriority): string {
  const meaning = PRIORITY_MEANING[next]
  return `${actorName} changed the priority to ${next}, ${meaning[0]!.toLowerCase()}${meaning.slice(1)} (was ${previous}).`
}
