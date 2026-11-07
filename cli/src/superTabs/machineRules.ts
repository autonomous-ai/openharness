/**
 * The project's machine rules as the route reads them (task #3964): the record's `machines` list (backend superTabs/policy.ts),
 * applied as the backend applies them (backend superTabs/machineRules.ts), which refuses the same starts and assignments.
 * The route only leaves out early what the server would refuse, and ranks a lane's first machine first.
 */
type Json = Record<string, unknown>

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}

/** Whether [rule]'s machine is away at [now]: on one of its weekdays, inside one of its windows, in its own time zone. */
function away(rule: Json, now: number): boolean {
  const when = object(rule.away)
  if (typeof when.timeZone !== 'string' || !Array.isArray(when.days) || !Array.isArray(when.windows)) return false
  let parts: Record<string, string>
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: when.timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23' }).formatToParts(new Date(now)).map(p => [p.type, p.value]))
  } catch { return false }
  const time = `${parts.hour}:${parts.minute}`
  return when.days.includes(WEEKDAYS.indexOf(parts.weekday ?? '')) && when.windows.some(w => {
    const [from, to] = strings(w)
    return !!from && !!to && time >= from && time < to
  })
}

/** Why [work] may not run on its machine at [now] by [rules], or null. */
export function machineRuleRefusal(rules: readonly Json[], work: { machineId: string; engine: string; review: boolean }, now: number): string | null {
  for (const rule of rules) {
    if (!strings(rule.machineIds).includes(work.machineId) || typeof rule.why !== 'string') continue
    if (strings(rule.noEngines).includes(work.engine) || (rule.noReviews === true && work.review) || away(rule, now)) return rule.why
  }
  return null
}

/** The machines [lane]'s work goes to first by [rules], and the first such rule's why; null for none. */
export function firstMachines(rules: readonly Json[], lane: string | null): { machines: Set<string>; why: string } | null {
  if (!lane) return null
  const named = rules.filter(rule => typeof rule.why === 'string' && strings(object(rule.first).lanes).some(l => l.toLowerCase() === lane.toLowerCase()))
  return named.length ? { machines: new Set(named.flatMap(rule => strings(rule.machineIds))), why: String(named[0]!.why) } : null
}
