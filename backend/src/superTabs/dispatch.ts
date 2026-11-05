/**
 * The Swarm hands the next task to a free crew member by itself (task #3400, anh Dee's Swarm redesign, 2026-11-05: the
 * server does the routine). What it decides is here, from the state alone: each task's lane, who of the crew is free, what
 * each free member gets, the two clocks and the capacity line. The store's pass (store.ts dispatchCrew) sends each pick
 * through work.assign, whose own write refuses a second assignment.
 */
import type { Conversation } from './model.js'

const HOUR_MS = 3_600_000

/** A lane of work and the repository paths it owns: the project rules record's `lanes` entry (#3393), the same shape. */
export interface Lane { name: string; owns: readonly string[] }

/** The numbers of the dispatch, in one place until the project rules record (#3393) holds them. */
export const DISPATCH_RULES = Object.freeze({
  /** How often the worker's pass runs; commits that free a member or open a task run it at once too. */
  everyMs: 30_000,
  /** A member with this many handed tasks (ready for review, still its own) takes no new one. */
  maxHanded: 3,
  /** Without progress this long, the member is told once. */
  nudgeAfterMs: 2 * HOUR_MS,
  /** Without progress this long, the task goes back to its lane. */
  returnAfterMs: 3 * HOUR_MS,
  lanes: Object.freeze([
    { name: 'backend', owns: ['backend/'] },
    { name: 'CLI', owns: ['cli/'] },
    { name: 'Desktop', owns: ['desktop/'] },
    { name: 'mobile', owns: ['mobile/'] },
    { name: 'docs', owns: ['docs/'] },
  ] as readonly Lane[]),
})
export type DispatchRules = typeof DISPATCH_RULES

/** The lane [name] means, matched in any case, as the table writes it; undefined when the table has none by that name. */
export function laneNamed(lanes: readonly Lane[], name: string): string | undefined {
  return lanes.find(lane => lane.name.toLowerCase() === name.trim().toLowerCase())?.name
}

/** "a, b or c": the lane names as a refusal lists them. */
export function spokenList(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
}

/** Whether [path] lies under [area]: an area ending in '/' is a folder, any other names one path and what is under it. */
const under = (path: string, area: string): boolean => {
  const folder = area.endsWith('/') ? area : `${area}/`
  return path === area || path.startsWith(folder)
}

/** The lane [group]'s task is handed out in: the one its PM or a person set (work.lane), else the lane owning most of its
 *  owned paths, a tie going to the table's first; null when no lane owns any of them. */
export function laneOf(group: Pick<Conversation, 'lane' | 'task'>, lanes: readonly Lane[]): string | null {
  if (group.lane) return laneNamed(lanes, group.lane) ?? group.lane
  let best: string | null = null, most = 0
  for (const lane of lanes) {
    const count = (group.task?.owns ?? []).filter(path => lane.owns.some(area => under(path.replace(/^\.?\//, ''), area))).length
    if (count > most) { best = lane.name; most = count }
  }
  return best
}
