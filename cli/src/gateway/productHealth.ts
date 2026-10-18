import type { ProductUsageMetric } from '../lib/productUsageContract.js'

const DAY = 86400000
const key = (n: number) => new Date(n).toISOString().slice(0, 10)
const monday = (n: number) => key(n - ((new Date(n).getUTCDay() + 6) % 7) * DAY)
export interface HealthState {
  hasWorked: boolean
  firstWork: string | null
  workDays: string[]
  week: string | null
  cleanExit: boolean
  release: string | null
}
export function cleanHealthState(raw: unknown, now: number): HealthState {
  const s = (raw ?? {}) as Partial<HealthState>
  const valid = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
    && Number.isFinite(Date.parse(v)) && key(Date.parse(v)) === v && v <= key(now) && Date.parse(v) > now - 36 * DAY
  return { hasWorked: s.hasWorked === true || typeof s.firstWork === 'string', firstWork: valid(s.firstWork) ? s.firstWork : null,
    workDays: Array.isArray(s.workDays) ? [...new Set(s.workDays.filter(valid))].sort().slice(-35) : [],
    week: valid(s.week) ? s.week : null, cleanExit: s.cleanExit !== false,
    release: typeof s.release === 'string' && /^(\d{1,3}\.){2}\d{1,3}$/.test(s.release) ? s.release : null }
}

/** Local date flags and a bounded RAM intent map. No keystrokes, content, ids or event history on disk. */
export function createProductHealth(add: (metric: ProductUsageMetric, day?: string) => void, now: () => number,
  initial: HealthState) {
  let state = initial
  let started = false, sampledAt = 0
  const intents = new Map<string, { at: number; origin: 'interactive' | 'tool' | 'unclassified' }>()
  const count = (m: string, day?: string) => add(`health_cli_${m}` as ProductUsageMetric, day)
  return {
    snapshot: () => state = cleanHealthState(state, now()),
    reset() { state = cleanHealthState(null, now()); intents.clear(); started = false; sampledAt = 0 },
    clearObservations() { intents.clear() },
    start(release?: string) {
      if (started) return
      started = true
      if (!state.cleanExit) count('unclean_restart')
      count(state.release && release && state.release !== release ? 'install_upgrade' : 'install_unknown')
      state.cleanExit = false; state.release = release ?? null
    },
    stop() { state.cleanExit = true; intents.clear() },
    intent(id: string, origin: 'interactive' | 'tool') {
      for (const [key, intent] of intents) if (now() - intent.at > 120000) intents.delete(key)
      if (intents.size >= 1000) { count('observation_overflow'); return }
      const previous = intents.get(id)
      intents.set(id, { at: now(), origin: previous && previous.origin !== origin ? 'unclassified' : origin })
    },
    work(id: string) {
      const intent = intents.get(id); intents.delete(id)
      const origin = intent && now() - intent.at <= 120000 ? intent.origin : 'unclassified'
      count(`${origin}_turns_started`)
      if (origin !== 'interactive') return
      const day = key(now())
      if (state.workDays.includes(day)) return
      count('interactive_work_days')
      if (!state.hasWorked) { state.hasWorked = true; state.firstWork = day; count('first_interactive_work') }
      for (const lag of [1, 7, 28]) if (state.firstWork === key(now() - lag * DAY)) count(`first_work_d${lag}_return`, state.firstWork)
      state.workDays = [...state.workDays, day].slice(-35)
    },
    checkpoint() {
      const week = monday(now())
      if (state.week && state.week < week) {
        const days = state.workDays.filter(d => d >= state.week! && d < key(Date.parse(state.week!) + 7 * DAY)).length
        if (days) count(days === 1 ? 'week_worked_1day' : days <= 3 ? 'week_worked_2to3days' : days <= 5 ? 'week_worked_4to5days' : 'week_worked_6to7days', state.week)
      }
      state.week = week
    },
    sample(sample?: () => { rss: number; cpuPercent?: number }) {
      // Once a tick: the collector's ticks are 45 to 75 seconds apart (gateway/productUsage.ts), a minute on
      // average, so a 60-second floor would skip every other short tick and undercount the samples.
      if (!sample || now() - sampledAt < 45000) return
      sampledAt = now()
      try {
        const value = sample()
        if (Number.isFinite(value.rss) && value.rss >= 0) count(value.rss < 256 * 1024 ** 2 ? 'rss_under_256m' : value.rss < 1024 ** 3 ? 'rss_256m_to_1g' : 'rss_over_1g')
        if (value.cpuPercent !== undefined && Number.isFinite(value.cpuPercent) && value.cpuPercent >= 0) {
          count(value.cpuPercent < 10 ? 'cpu_under_10pct' : value.cpuPercent < 50 ? 'cpu_10pct_to_50pct' : 'cpu_over_50pct')
        }
      } catch { /* Resource observation cannot affect work. */ }
    },
  }
}

/** Called on the gateway's existing minute tick. No process enumeration or core timer. */
export function gatewayResourceSample() {
  let cpu = process.cpuUsage(), stamp = performance.now()
  return () => {
    const next = process.cpuUsage(), at = performance.now(), elapsed = at - stamp
    const cpuPercent = elapsed >= 1000 && elapsed <= 120000 ? (next.user + next.system - cpu.user - cpu.system) / (elapsed * 10) : undefined
    cpu = next; stamp = at
    return { rss: process.memoryUsage.rss(), cpuPercent }
  }
}
