/**
 * The project's machine rules (project instructions, Routing › Machines; task #3964), as its rules record holds them
 * (policy.ts): why a machine refuses a piece of work now, and which machines a lane's work goes to first. Pure, so the
 * start, the assignment, the dispatch and the crew keeper all read a rule alike.
 */
import type { Conversation } from './model.js'
import type { MachineRule } from './policy.js'
import { stepName } from './steps.js'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Whether [rule]'s machine is away at [now]: on one of its weekdays, inside one of its windows, in its own time zone. */
function away(rule: MachineRule, now: number): boolean {
  if (!rule.away) return false
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: rule.away.timeZone, weekday: 'short', hour: '2-digit',
    minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).map(p => [p.type, p.value]))
  const time = `${parts.hour}:${parts.minute}`
  return rule.away.days.includes(WEEKDAYS.indexOf(parts.weekday ?? '')) && rule.away.windows.some(([from, to]) => time >= from && time < to)
}

/** Why [work] (an agent of [engine] on [machineId], reviewing or not) may not run there at [now] by [rules], or null. */
export function machineRuleRefusal(rules: readonly MachineRule[], work: { machineId: string; engine: string; review: boolean }, now: number): string | null {
  for (const rule of rules) {
    if (!rule.machineIds.includes(work.machineId)) continue
    if (rule.noEngines?.includes(work.engine as 'claude' | 'codex') || (rule.noReviews && work.review) || away(rule, now)) return rule.why
  }
  return null
}

/** Whether [group] is a review, which a no-Reviewer rule refuses: a step that is not a test (as dispatch.ts sorts steps). */
export const isReview = (group: Conversation): boolean => !!group.reviewOf && !/test/i.test(stepName(group))
