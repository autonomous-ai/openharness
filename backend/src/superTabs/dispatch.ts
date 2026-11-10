/**
 * Each stored task's lane and the two progress clocks on its work, from the state alone. The Swarm no longer hands out tasks
 * itself (Swarm v4, 2026-11-10: the crew dispatch and work.assign went); these read what a Swarm from before still stores.
 */
import { SEED_RULES, type MachineRule, type ProjectRules } from './policy.js'
import { type Agent, type Assignment, type Conversation } from './model.js'

const HOUR_MS = 3_600_000

/** A lane of work and the repository paths it owns: the project rules record's `lanes` entry (#3393), the same shape. */
export interface Lane { name: string; owns: readonly string[] }

/** The validated dispatch policy of one project; the default is only for legacy pure callers. */
export interface DispatchRules extends Readonly<ProjectRules['dispatch']> { readonly lanes: readonly Lane[]; readonly machines: readonly MachineRule[] }
const dispatchRules = (rules: ProjectRules): DispatchRules => ({ ...rules.dispatch, lanes: rules.lanes, machines: rules.machines ?? [] })
export const DISPATCH_RULES: DispatchRules = Object.freeze(dispatchRules(SEED_RULES))

/** The lane [name] means, matched in any case, as the table writes it; undefined when the table has none by that name. */
export function laneNamed(lanes: readonly Lane[], name: string): string | undefined {
  return lanes.find(lane => lane.name.toLowerCase() === name.trim().toLowerCase())?.name
}

/** Stores [group]'s hand-out lane, when it is a task (not a chat, a step or a private chat), after its paths or lane changed:
 *  readers copy it (read/views.ts groupView), no read computes it. */
export function stampLane(group: Conversation, lanes: readonly Lane[] = DISPATCH_RULES.lanes): void {
  if (group.task && !group.reviewOf && !group.kind && !group.audience) group.handOutLane = laneOf(group, lanes)
  else delete group.handOutLane
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
  if (group.lane) return laneNamed(lanes, group.lane) ?? null
  let best: string | null = null, most = 0
  for (const lane of lanes) {
    const count = (group.task?.owns ?? []).filter(path => lane.owns.some(area => under(path.replace(/^\.?\//, ''), area))).length
    if (count > most) { best = lane.name; most = count }
  }
  return best
}

/** Configured time in a progress notice, without rounding a project's threshold. */
const duration = (ms: number): string => {
  const [value, unit] = ms % HOUR_MS === 0 ? [ms / HOUR_MS, 'hour'] : ms % 60_000 === 0 ? [ms / 60_000, 'minute'] : [ms / 1000, 'second']
  return `${value} ${unit}${value === 1 ? '' : 's'}`
}
export const returnReason = (lane: string | null, rules: DispatchRules = DISPATCH_RULES): string =>
  `no progress for ${duration(rules.returnAfterMs)}: back in the ${lane ?? 'project'} lane`

/** The progress clocks on [assignment] of [group], held by any project worker (liveness.ts): from its own last progress
 *  (its assignment, status, check or post: `progressAt`), only while working. `nudge` after `nudgeAfterMs`, once
 *  per spell of quiet; `return` after `returnAfterMs`. Waiting on a person, blocked or handed: no clock. */
export function crewClock(_group: Conversation, _worker: Agent, assignment: Assignment, now: number, rules: DispatchRules): 'nudge' | 'return' | null {
  const since = assignment.progressAt
  if (assignment.status !== 'working' || since === undefined) return null
  if (now - since >= rules.returnAfterMs) return 'return'
  return now - since >= rules.nudgeAfterMs && !(assignment.nudgedAt !== undefined && assignment.nudgedAt >= since) ? 'nudge' : null
}

