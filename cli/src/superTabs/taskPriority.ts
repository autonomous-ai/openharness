/**
 * A task's priority (task #3117): P0 hotfix, P1 needed by users soon, P2 planned goal, P3 tools, docs or process. The
 * backend stores it on the task's group; a task from before it carries none, and the PM marked urgency in its title
 * instead, which is read the way Desktop reads it (backlog.dart superTabTitlePriority), so every client agrees.
 */

export type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3'
const PRIORITIES: readonly TaskPriority[] = ['P0', 'P1', 'P2', 'P3']

const LEADING = /^\s*URGENT\b\s*:?\s*/i
const TRAILING = /\s*\((?:[^()]*,\s*)?(urgent|high)(?:\s+priority)?\)\s*$/i

/** The title's marker: a leading URGENT, or a closing "(urgent)", "(Name, high)" or "(high priority)"; a marker with no
 *  title left beside it marks nothing. */
function titlePriority(title: string): TaskPriority | null {
  const leading = LEADING.exec(title)
  if (leading && title.length > leading[0].length) return 'P0'
  const trailing = TRAILING.exec(title)
  if (trailing && trailing.index > 0) return trailing[1]!.toLowerCase() === 'urgent' ? 'P0' : 'P1'
  return null
}

/** [group]'s priority: its field, else its title's marker, else P2. */
export function effectivePriority(group: { priority?: unknown; title?: unknown }): TaskPriority {
  if (PRIORITIES.includes(group.priority as TaskPriority)) return group.priority as TaskPriority
  return (typeof group.title === 'string' ? titlePriority(group.title) : null) ?? 'P2'
}

/** Where [priority] sorts: P0 first. */
export const priorityRank = (priority: TaskPriority): number => PRIORITIES.indexOf(priority)
