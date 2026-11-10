/**
 * A task's priority (task #3117): one scale, P0 to P3, for the PM, people and Buddies' proposals, so a hotfix for a broken
 * release no longer waits behind ordinary work until someone says "urgent". A task created without one is P2.
 */
export const TASK_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const
export type TaskPriority = typeof TASK_PRIORITIES[number]

export const DEFAULT_PRIORITY: TaskPriority = 'P2'
export const PRIORITY_DEFAULTED = 'No priority given: this task is P2. Give P0-P3 when you create a task.'

/** A Buddy proposal's low, normal or high on the same scale. A proposal never reaches P0: only the PM or a person sets that. */
export function proposalPriority(value: unknown): TaskPriority {
  return value === 'high' ? 'P1' : value === 'low' ? 'P3' : 'P2'
}
