import { cleanUsageContext, type ProductUsageContext } from '../lib/productHealthContract.js'
import { cleanHealthState, createProductHealth, type HealthState } from './productHealth.js'
import { reportFailure } from './reportFailure.js'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { engineAccount } from '../lib/engineAccount.js'
import { loginShellEnvironment } from '../lib/loginShellEnv.js'
import { launchEngine, type ProductUsageLaunchSignal } from '../lib/productUsageSignals.js'
import { LAUNCH_ERROR_CODES, PRODUCT_USAGE_ACTIONS, PRODUCT_USAGE_AUTOMATIC_ACTIONS, PRODUCT_USAGE_DAYS,
  PRODUCT_USAGE_MAX_COUNT, PRODUCT_USAGE_METRICS, PRODUCT_USAGE_USER_OPENED_ACTIONS,
  type LaunchErrorCode, type ProductUsageChoice, type ProductUsageMetric, type ProductUsageReport } from '../lib/productUsageContract.js'

const DAY = 86_400_000
const MAX_QUEUE_BYTES = 256 * 1024
// A report stays below the server's 8 KiB body bound even with the complete vocabulary.
const MAX_REPORT_METRICS = 64
const metricSet = new Set<string>(PRODUCT_USAGE_METRICS)
const launchCodes = new Set<string>(LAUNCH_ERROR_CODES)
const listed = (code: unknown): LaunchErrorCode => typeof code === 'string' && launchCodes.has(code) ? code as LaunchErrorCode : 'unlisted'
// Every daemon of a release updates at the same second (:45), so with a report at start and then one a minute
// the fleet reported together: the backend's write conflicts and USAGE_BUSY refusals (41 and 48 on 2026-10-16,
// production counters). The first report waits a random 10 to 60 seconds and each later tick 45 to 75, so the
// fleet spreads out again; the mean interval stays a minute.
const FIRST_REPORT_MS: readonly [number, number] = [10_000, 60_000]
const TICK_MS: readonly [number, number] = [45_000, 75_000]
// A refusal that says the backend is busy or down (429, 5xx, a timeout) waits longer each time it repeats: full
// jitter under a doubling ceiling, at most half an hour, and never sooner than its Retry-After.
const BACKOFF_BASE_MS = 60_000
const BACKOFF_MAX_MS = 30 * 60_000
// A created launch's agent is watched this long for its start failing: the new-pane watcher gives an engine ten
// minutes (core/agents/newPane.ts).
const LATE_FAILURE_WATCH_MS = 15 * 60_000
/** Which collector of this process last opened each file: a stopped collector's write that lands late puts its
 *  final state back only while no newer one (the gateway started again) writes that file. */
const writers = new Map<string, object>()
// Feature reach is a person's use; the reads the apps make on their own count only their reliability,
// unless the app says a person opened that list (`<action>_user_requests`, its own first/repeat).
type Reach = typeof PRODUCT_USAGE_ACTIONS[number] | `${typeof PRODUCT_USAGE_USER_OPENED_ACTIONS[number]}_user`
const REACHES: readonly Reach[] = [...PRODUCT_USAGE_ACTIONS, ...PRODUCT_USAGE_USER_OPENED_ACTIONS.map(action => `${action}_user` as const)]
const requestActions = new Map<string, Reach>([
  ...PRODUCT_USAGE_ACTIONS.filter(action => !PRODUCT_USAGE_AUTOMATIC_ACTIONS.includes(action)).map(action => [`${action}_requests`, action] as const),
  ...PRODUCT_USAGE_USER_OPENED_ACTIONS.map(action => [`${action}_user_requests`, `${action}_user`] as const),
])
const isTuiMetric = (metric: string): boolean => metric.startsWith('ui_tui_') || metric.startsWith('health_tui_')
const key = (now: number) => new Date(now).toISOString().slice(0, 10)
const week = (now: number) => { const d = new Date(now); return key(now - ((d.getUTCDay() + 6) % 7) * DAY) }
type Counters = Partial<Record<ProductUsageMetric, number>>
interface State {
  dayContexts: Record<string, ProductUsageContext>
  health: HealthState
  healthDay: string | null
  revision: number
  activeDay: string | null
  workDay: string | null
  workWeek: string | null
  workMonth: string | null
  measurementDay: string | null
  featureDays: Partial<Record<Reach, string>>
  featuresUsed: Reach[]
  workedBefore: boolean
  respondedBefore: boolean
  launchedBefore: boolean
  firstLaunchAt: number | null
  launchWorked: boolean
  launchResponded: boolean
  workDays: string[]
  days: Record<string, Counters>
  pending: ProductUsageReport | null
}
const fresh = (revision: number): State => ({ dayContexts: {}, health: cleanHealthState(null, Date.now()), healthDay: null, revision, activeDay: null, workDay: null, workWeek: null,
  workMonth: null, measurementDay: null, featureDays: {}, featuresUsed: [],
  workedBefore: false, respondedBefore: false, launchedBefore: false, firstLaunchAt: null,
  launchWorked: false, launchResponded: false, workDays: [], days: {}, pending: null })
export interface ProductUsageDeps {
  file: string
  context?: ProductUsageContext
  sample?: () => { rss: number; cpuPercent?: number }
  /** `retryAfterMs`: the answer's Retry-After, when it had one (gateway/accountHttp.ts). */
  request(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown>; retryAfterMs?: number }>
  now?(): number
  uuid?(): string
  /** In [0, 1): when reports go. A seam for tests. */
  random?(): number
  /** Whether Claude Code or Codex has a credential here: true, false, or null when this computer cannot say. */
  engineSignedIn?(engine: 'claude' | 'codex'): Promise<boolean | null>
  /** Test seam for a slow or unavailable disk; never called from an event observer. */
  write?(file: string, value: string): Promise<void>
}

/** Presence only (lib/engineAccount.ts: a credential file stat'ed or parsed for a token, a Keychain item looked up
 *  without its secret), in this process's own environment: the gateway starts no login shell for it, so a key only
 *  a shell profile exports reads as signed out to a daemon launchd or systemd started. No folder is scanned. */
const engineSignedIn = async (engine: 'claude' | 'codex'): Promise<boolean | null> =>
  (await engineAccount(engine, { env: { ...loginShellEnvironment(), ...process.env }, lastUsed: false })).signedIn

/** A reporting component of the gateway service; the core never waits for it.
 * Counts lifecycle facts only. No transcript, prompt, response, tool or error object enters this API.
 * Agent identifiers live only in the bounded in-memory turn and launch maps and never reach disk or HTTP.
 */
export function createProductUsage(deps: ProductUsageDeps) {
  const now = deps.now ?? Date.now, uuid = deps.uuid ?? randomUUID, random = deps.random ?? Math.random
  const context = cleanUsageContext(deps.context)
  let state = fresh(-1), enabled = false, stopped = false, active = false
  let syncing: Promise<void> | null = null, persistTimer: ReturnType<typeof setTimeout> | undefined
  let writing: Promise<boolean> | null = null, writeAgain = false
  // What stop() wrote as the process went: nothing written after it may replace it.
  let final: string | null = null
  const writer = {}
  writers.set(deps.file, writer)
  // A report waits until `postAt` after a busy or failing backend; `backoffs` counts those refusals in a row.
  let postAt = 0, backoffs = 0
  // hn's counters: those it observed before the first choice read, held in RAM until that is known
  // (hn is often opened at the daemon's start), and the UTC day a backend from before `tui` refused
  // them. Neither is persisted; a restart tries again.
  let choiceKnown = false, tuiHeld: ProductUsageMetric[] = [], tuiRefusedDay: string | null = null
  const tuiRefused = (): boolean => tuiRefusedDay === key(now())
  const running = new Map<string, { started: number; response: boolean; error: boolean; waited: boolean }>()
  const launches = new Map<string, { started: number; done: boolean; waits: Set<string> }>()
  /** The agents of created launches still starting, by agent id (RAM only), with when each was created. */
  const starting = new Map<string, number>()
  const forget = (): void => { running.clear(); launches.clear(); starting.clear() }
  try {
    if (statSync(deps.file).size > MAX_QUEUE_BYTES) throw new Error('Usage queue exceeds its bound')
    // Reconstruct every field; even a corrupted local file cannot introduce a new upload property.
    const saved = JSON.parse(readFileSync(deps.file, 'utf8')) as State
    if (Number.isSafeInteger(saved.revision) && saved.revision >= 0) {
      state = fresh(saved.revision)
      state.health = cleanHealthState(saved.health, now())
      state.healthDay = typeof saved.healthDay === 'string' && validDay(saved.healthDay) ? saved.healthDay : null
      for (const field of ['activeDay', 'workDay', 'workWeek', 'measurementDay'] as const) {
        if (typeof saved[field] === 'string' && validDay(saved[field]!)) state[field] = saved[field]
      }
      if (typeof saved.workMonth === 'string' && /^\d{4}-\d{2}$/.test(saved.workMonth)) state.workMonth = saved.workMonth
      for (const action of REACHES) {
        if (validDay(saved.featureDays?.[action] ?? '')) state.featureDays[action] = saved.featureDays![action]
        if (saved.featuresUsed?.includes(action)) state.featuresUsed.push(action)
      }
      state.workedBefore = saved.workedBefore === true
      state.respondedBefore = saved.respondedBefore === true
      state.launchedBefore = saved.launchedBefore === true
      state.firstLaunchAt = Number.isSafeInteger(saved.firstLaunchAt) && saved.firstLaunchAt! <= now()
        && validDay(key(saved.firstLaunchAt!)) ? saved.firstLaunchAt : null
      state.launchWorked = saved.launchWorked === true
      state.launchResponded = saved.launchResponded === true
      state.workDays = Array.isArray(saved.workDays) ? [...new Set(saved.workDays.filter(d => typeof d === 'string' && validDay(d)))].slice(-35) : []
      for (const [day, counters] of Object.entries(saved.days ?? {})) if (validDay(day)) {
        state.days[day] = clean(counters)
        const c = cleanUsageContext(saved.dayContexts?.[day])
        if (c) state.dayContexts[day] = c
        else if (context) state.dayContexts[day] = { ...context, release: 'unknown', platform: 'other' }
      }
      const pending = saved.pending
      if (pending && pending.schemaVersion === 1 && pending.revision === state.revision && validDay(pending.day)
          && typeof pending.id === 'string' && /^[a-f0-9-]{36}$/.test(pending.id)) {
        const restored = { schemaVersion: 1 as const, revision: state.revision, id: pending.id, day: pending.day, counters: clean(pending.counters), ...(cleanUsageContext(pending.context) ? { context: cleanUsageContext(pending.context) } : {}) }
        if (Buffer.byteLength(JSON.stringify(restored)) <= 8192) state.pending = restored
      }
    }
  } catch { /* Missing or unreadable telemetry must not affect a session. */ }

  const health = createProductHealth(add, now, state.health)

  function validDay(day: string): boolean {
    const stamp = Date.parse(day + 'T00:00:00.000Z'), today = Math.floor(now() / DAY) * DAY
    return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(stamp) && key(stamp) === day
      && stamp <= today && stamp > today - PRODUCT_USAGE_DAYS * DAY
  }
  function clean(input: Counters): Counters {
    const result: Counters = {}
    for (const metric of PRODUCT_USAGE_METRICS) {
      const value = input?.[metric]
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= PRODUCT_USAGE_MAX_COUNT) result[metric] = value
    }
    return result
  }
  function snapshot(): string {
    state.health = health.snapshot()
    clearTimeout(persistTimer); persistTimer = undefined
    for (const field of ['activeDay', 'workDay', 'workWeek', 'measurementDay'] as const) if (state[field] && !validDay(state[field]!)) state[field] = null
    for (const day of Object.keys(state.days)) if (!validDay(day)) delete state.days[day]
    for (const day of Object.keys(state.dayContexts)) if (!state.days[day]) delete state.dayContexts[day]
    for (const action of REACHES) if (!validDay(state.featureDays[action] ?? '')) delete state.featureDays[action]
    state.workDays = state.workDays.filter(validDay)
    if (state.firstLaunchAt !== null && !validDay(key(state.firstLaunchAt))) state.firstLaunchAt = null
    if (state.pending && !validDay(state.pending.day)) state.pending = null
    // Size each day once, keeping the most recent ones. Repeatedly serializing a full
    // offline backlog to remove its oldest day would stall the gateway on a reconnect.
    let bytes = Buffer.byteLength(JSON.stringify({ ...state, days: {} })) + 1024
    const kept: State['days'] = {}
    let pruned = false
    for (const day of Object.keys(state.days).sort().reverse()) {
      const size = Buffer.byteLength(JSON.stringify(state.days[day])) + 16
      if (bytes + size > MAX_QUEUE_BYTES) { pruned = true; continue }
      kept[day] = state.days[day]; bytes += size
    }
    state.days = kept
    if (pruned) (state.days[key(now())] ??= {}).measurement_queue_pruned = 1
    return JSON.stringify(state)
  }
  /** The final state, on disk before stop() returns. `harness stop`, an update, a sign-in's restart, a service
   *  install and an OS logout end the process right after it, and the asynchronous write went with it: every
   *  planned stop read as an unclean restart (health_cli_unclean_restart, 69 to 170 on 2026-10-16, production
   *  counters). Its own temporary file, so it never interleaves with a write still on its way; at most 256 KiB. */
  function writeFinal(value: string): boolean {
    try {
      mkdirSync(dirname(deps.file), { recursive: true, mode: 0o700 })
      writeFileSync(deps.file + '.final.tmp', value, { mode: 0o600 })
      renameSync(deps.file + '.final.tmp', deps.file)
      return true
    } catch { return false }
  }
  function persist(): Promise<boolean> {
    if (final !== null) return writing ?? Promise.resolve(true)
    writeAgain = true
    // Coalesce concurrent saves to one in-flight write and the latest bounded state.
    // A slow disk must not create a promise/file queue or block the relay's event loop.
    return writing ??= (async () => {
      try {
        do {
          writeAgain = false
          const value = snapshot()
          if (deps.write) await deps.write(deps.file, value)
          else {
            await mkdir(dirname(deps.file), { recursive: true, mode: 0o700 })
            await writeFile(deps.file + '.tmp', value, { mode: 0o600 })
            // Stopped meanwhile: the final state is on disk, and this older snapshot must not go over it.
            if (final !== null) break
            await rename(deps.file + '.tmp', deps.file)
          }
        } while (writeAgain && final === null)
        return true
      } catch { enabled = false; return false }
      finally {
        // A write already on its way when stop() wrote can land after it: the final state goes back, unless a
        // newer collector in this process (the gateway started again) writes this file now.
        if (final !== null && writers.get(deps.file) === writer) writeFinal(final)
      }
    })().finally(() => { writing = null })
  }
  function dirty(): void {
    if (!persistTimer) { persistTimer = setTimeout(() => { void persist() }, 1000); persistTimer.unref() }
  }
  function add(metric: ProductUsageMetric, day = key(now())): void {
    if (state.measurementDay !== key(now())) {
      state.measurementDay = key(now())
      ;(state.days[state.measurementDay] ??= {}).measurement_v2_installation_days = 1
    }
    const counters = state.days[day] ??= {}
    if (context) {
      const prior = state.dayContexts[day]
      state.dayContexts[day] = !prior ? context : { ...context,
        release: prior.release === context.release ? context.release : 'unknown',
        platform: prior.platform === context.platform ? context.platform : 'other',
        channel: prior.channel === 'production' && context.channel === 'production' ? 'production' : 'development' }
      if ((counters[metric] ?? 0) >= PRODUCT_USAGE_MAX_COUNT) counters.health_cli_queue_capped = 1
    }
    counters[metric] = Math.min(PRODUCT_USAGE_MAX_COUNT, (counters[metric] ?? 0) + 1)
    dirty()
  }
  function markActive(): void {
    if (!enabled || stopped) return
    if (state.activeDay !== key(now())) { state.activeDay = key(now()); add('active_installation_days') }
  }
  function launchValue(response: boolean): void {
    if (state.firstLaunchAt === null || now() < state.firstLaunchAt || now() - state.firstLaunchAt > DAY) return
    const field = response ? 'launchResponded' : 'launchWorked'
    if (!state[field]) {
      state[field] = true
      add(response ? 'first_launch_response_24h_installations' : 'first_launch_work_24h_installations', key(state.firstLaunchAt))
    }
  }
  async function choice(value: ProductUsageChoice): Promise<void> {
    if (state.revision !== value.revision || (!value.enabled && (enabled || state.pending || Object.keys(state.days).length))) {
      state = fresh(value.revision); forget(); health.reset()
      enabled = false
      if (!await persist()) return
    }
    enabled = value.enabled && !stopped
  }
  /** After a refusal that says the backend is busy or failing: full jitter under a ceiling that doubles with each
   *  one in a row, up to half an hour, and not before the answer's Retry-After (also held to that half hour). */
  function backOff(retryAfterMs?: number): void {
    backoffs = Math.min(backoffs + 1, 16)
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** backoffs)
    const asked = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0
    postAt = now() + Math.min(BACKOFF_MAX_MS, Math.max(asked, Math.floor(unit() * ceiling)))
  }
  /** A random number in [0, 1); anything else the source gives reads as the middle. */
  function unit(): number { const r = random(); return Number.isFinite(r) && r >= 0 && r < 1 ? r : 0.5 }
  /** A delay in [low, high) milliseconds, at random: the fleet's reports spread out across it. */
  const between = ([low, high]: readonly [number, number]): number => low + Math.floor(unit() * (high - low))
  /** [post]: send a report now. The gateway's first read of the choice does not, so collection starts at once
   *  and the report waits for the first tick; every tick reads the choice and posts unless backing off. */
  async function syncOnce(post: boolean): Promise<void> {
    let posting = false
    try {
      const response = await deps.request('GET', '/api/product-usage/settings')
      if (stopped) return
      const body = response.body.data as ProductUsageChoice | undefined
      if (response.status !== 200 || typeof body?.enabled !== 'boolean'
          || !Number.isSafeInteger(body.revision) || body.revision < 0) { enabled = false; forget(); health.clearObservations(); return }
      await choice(body)
      if (!choiceKnown) {
        // Counted only now that sharing is known to be on; discarded when it is off.
        choiceKnown = true
        const held = tuiHeld
        tuiHeld = []
        if (enabled && !tuiRefused()) for (const metric of held) add(metric)
      }
      if (!enabled) return
      if (context) {
        health.start(context.release); health.checkpoint(); health.sample(deps.sample)
        if (state.healthDay !== key(now())) { state.healthDay = key(now()); add('health_cli_collector_days') }
      }
      for (const turn of running.values()) if (!turn.response && !turn.waited && now() - turn.started >= 60_000) {
        turn.waited = true; add('turns_waiting_over_1m')
      }
      for (const [id, launch] of launches) {
        if (!launch.done && now() - launch.started >= 15 * 60_000) { launch.done = true; add('launch_unobserved') }
        if (now() - launch.started >= 35 * 60_000) launches.delete(id)
      }
      for (const [agent, at] of starting) if (now() - at >= LATE_FAILURE_WATCH_MS) starting.delete(agent)
      if (active) markActive()
      // Refused today: hn's counts go, rather than waiting to become a past day's report.
      if (tuiRefused()) for (const day of Object.keys(state.days)) {
        for (const metric of Object.keys(state.days[day])) if (isTuiMetric(metric)) delete state.days[day][metric as ProductUsageMetric]
        if (!Object.keys(state.days[day]).length) { delete state.days[day]; delete state.dayContexts[day] }
      }
      if (!post) return
      if (!state.pending) {
        const day = Object.keys(state.days).sort().find(d => validDay(d) && Object.keys(state.days[d]).length)
        if (!day) return
        // hn's counters travel alone: a backend from before `tui` refuses its whole report (400), and
        // that refusal drops the report, so it must never carry the daemon's or the Desktop's counts.
        const entries = Object.entries(state.days[day])
        const own = entries.filter(([metric]) => !isTuiMetric(metric))
        const counters = Object.fromEntries((own.length ? own : entries).slice(0, MAX_REPORT_METRICS)) as Counters
        const reportContext = state.dayContexts[day] ?? context
        state.pending = { schemaVersion: 1, revision: state.revision, id: uuid(), day, counters, ...(reportContext ? { context: reportContext } : {}) }
        for (const metric of Object.keys(counters)) delete state.days[day][metric as ProductUsageMetric]
        if (!Object.keys(state.days[day]).length) { delete state.days[day]; delete state.dayContexts[day] }
      }
      // Persist the immutable receipt before sending. A crash or ambiguous response retries that id.
      if (!await persist() || stopped || !enabled) return
      const report = state.pending
      if (!report) return
      posting = true
      const answer = await deps.request('POST', '/api/product-usage/report', report)
      if (stopped) return
      // Busy, failing or out of time (429, 5xx; a timeout is a 504): the next report waits. Anything else is an
      // answer, and the reports go at the ticks again. Either way each attempt counts as before.
      if (answer.status === 429 || answer.status >= 500) backOff(answer.retryAfterMs)
      else { backoffs = 0; postAt = 0 }
      const result = answer.body.data as { accepted?: boolean; reason?: string } | undefined
      if (answer.status === 200 && result?.accepted === true) { state.pending = null; await persist() }
      else if (result?.reason === 'CHOICE_CHANGED') { enabled = false; state = fresh(-1); forget(); health.reset(); await persist() }
      else if (result?.reason === 'EXPIRED') { state.pending = null; add('health_cli_report_expired'); await persist() }
      else if (answer.status === 400 && Object.keys(report.counters).length && Object.keys(report.counters).every(isTuiMetric)) {
        // A backend from before `tui` knows none of hn's names. That is not a failed delivery, so it
        // is not counted as one: the report goes, and hn's counts with it until the next UTC day.
        state.pending = null; tuiRefusedDay = key(now()); await persist()
      }
      else {
        add('health_cli_report_rejected')
        add(`health_cli_report_failure_${reportFailure(answer)}`)
        // A permanently invalid packet must not block every future report behind it.
        if (answer.status === 400 || answer.status === 413) { state.pending = null; await persist() }
      }
    } catch {
      if (posting) backOff()
      if (enabled) add('health_cli_report_failed')
      enabled = false; forget(); health.clearObservations() /* No error text or request body in logs. */
    }
  }
  /** Read the choice and, with [post] (the default), send a report now. */
  const sync = (post = true): Promise<void> => syncing ??= syncOnce(post).finally(() => { syncing = null })
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (ms: number): void => {
    if (stopped) return
    timer = setTimeout(() => { void sync(now() >= postAt).finally(() => schedule(between(TICK_MS))) }, ms)
    timer.unref?.()
  }
  schedule(between(FIRST_REPORT_MS))

  /** A created launch's start failed after its reply said created: counted once, by its listed code. */
  function lateFailure(code: unknown): void {
    add('launch_late_failed')
    add(`launch_late_failed_code_${listed(code)}`)
  }
  /** The engine of an installation's first launch, and for Claude Code or Codex whether it had a credential here:
   *  one look, once per installation, counted on the first launch's day. */
  function firstLaunch(engine: unknown): void {
    const name = launchEngine(engine)
    add(`first_launch_engine_${name}`)
    if (name !== 'claude' && name !== 'codex') return
    const owner = state, day = key(state.firstLaunchAt ?? now())
    const counted = (signedIn: boolean | null): void => {
      // A choice change or a stop since then took this cohort's counts with it.
      if (!enabled || stopped || state !== owner) return
      add(`first_launch_${name}_${signedIn === true ? 'signed_in' : signedIn === false ? 'signed_out' : 'unknown'}`, day)
    }
    void Promise.resolve().then(() => (deps.engineSignedIn ?? engineSignedIn)(name)).then(counted, () => counted(null))
  }

  return {
    sync,
    counter(metric: ProductUsageMetric): void {
      if (stopped || !metricSet.has(metric)) return
      if (isTuiMetric(metric)) {
        if (!enabled) { if (!choiceKnown && tuiHeld.length < 64) tuiHeld.push(metric); return }
        if (tuiRefused()) return
      }
      if (!enabled) return
      add(metric)
      const action = requestActions.get(metric)
      if (action && state.featureDays[action] !== key(now())) {
        add(`${action}_installation_days`)
        add(`${action}_${state.featuresUsed.includes(action) ? 'repeat_installation_days' : 'first_installations'}`)
        if (!state.featuresUsed.includes(action)) state.featuresUsed.push(action)
        state.featureDays[action] = key(now())
      }
    },
    launch(signal: ProductUsageLaunchSignal): void {
      if (!enabled || stopped || !signal || typeof signal.id !== 'string') return
      if (signal.phase === 'work_requested') {
        if (!running.has(signal.id) && signal.id.length > 0 && signal.id.length <= 256 && (signal.origin === 'interactive' || signal.origin === 'tool')) health.intent(signal.id, signal.origin)
        return
      }
      if (!/^[a-zA-Z0-9_-]{16,96}$/.test(signal.id)) return
      if (signal.phase === 'start') {
        if (launches.has(signal.id)) return
        if (!state.launchedBefore) {
          state.launchedBefore = true; state.firstLaunchAt = now(); add('first_launch_installations')
          firstLaunch(signal.engine)
        }
        if (launches.size >= 1000) {
          const oldest = launches.keys().next().value!
          if (!launches.get(oldest)!.done) add('launch_unobserved')
          launches.delete(oldest)
        }
        launches.set(signal.id, { started: now(), done: false, waits: new Set() }); add('launch_started'); return
      }
      const launch = launches.get(signal.id)
      if (!launch || launch.done) return
      if (signal.phase === 'pending') {
        const wait = ['install', 'model', 'native'].includes(signal.wait ?? '') ? signal.wait! : 'other'
        if (!launch.waits.has(wait)) { launch.waits.add(wait); add(`launch_wait_${wait}` as ProductUsageMetric) }
        return
      }
      if (!['created', 'failed', 'cancelled', 'unconfirmed'].includes(signal.phase)) return
      launch.done = true
      add(`launch_${signal.phase}` as ProductUsageMetric)
      if (signal.phase === 'failed') {
        const kind = ['setup', 'auth', 'unavailable', 'invalid'].includes(signal.failure ?? '') ? signal.failure! : 'other'
        add(`launch_failed_${kind}` as ProductUsageMetric)
        // 23 of 25 launch failures were `other` on 2026-10-16 (production counters): the code says which.
        if (kind === 'other') add(`launch_failed_code_${listed(signal.code)}`)
        // Setup's 10 failures on 2026-10-21 could not say which prerequisite failed. A separate family
        // keeps the existing `other` code totals comparable; the launch map still counts polls only once.
        if (kind === 'setup') add(`launch_failed_setup_code_${listed(signal.code)}`)
      }
      if (signal.phase === 'created') {
        // Its start had already failed by the reply that said created (a status poll), or it is still starting:
        // watched for its agent's frame saying failed (launchState below).
        if (signal.late === true) lateFailure(signal.code)
        else if (typeof signal.agent === 'string' && signal.agent.length > 0 && signal.agent.length <= 256) {
          if (starting.size >= 1000) starting.delete(starting.keys().next().value!)
          starting.set(signal.agent, now())
        }
      }
      const elapsed = Math.max(0, now() - launch.started)
      add(elapsed < 10_000 ? 'launch_under_10s' : elapsed < 60_000 ? 'launch_10s_to_1m' : elapsed < 300_000 ? 'launch_1m_to_5m' : 'launch_over_5m')
    },
    /** An agent's launch state from its frame. Only an agent a created launch made is looked at, until its start
     *  is decided: failed is a late failure (ENGINE_DID_NOT_START, ENGINE_NOT_INSTALLED, START_TIMEOUT set after the
     *  reply said created, core/agents/newPane.ts), ready ends the watch. */
    launchState(agent: string, value: string, code?: LaunchErrorCode): void {
      if (!enabled || stopped || !starting.size || !starting.has(agent)) return
      if (value === 'failed') { starting.delete(agent); lateFailure(code) }
      else if (value === 'ready') starting.delete(agent)
    },
    presence(value: boolean): void { active = value; if (value) markActive() },
    opened(surface: 'desktop' | 'tui'): void {
      if (!enabled || stopped) return
      markActive(); add(surface === 'desktop' ? 'desktop_opens' : 'tui_opens')
    },
    observe(type: 'turn_started' | 'turn_ended' | 'text_delta' | 'error', agent: string, replay: boolean, interrupted = false): void {
      if (!enabled || stopped || replay || !agent || agent.length > 256) return
      if (type === 'turn_started') {
        if (running.has(agent)) return
        if (running.size >= 1000) { add('turn_observation_overflow'); return }
        running.set(agent, { started: now(), response: false, error: false, waited: false }); markActive(); add('turns_started'); if (context) health.work(agent)
        launchValue(false)
        if (state.workDay !== key(now())) {
          if (state.workDay && now() - Date.parse(state.workDay) >= 7 * DAY) add('reactivated_after_7d_installations')
          add('working_installation_days')
          add(state.workedBefore ? 'repeat_work_installation_days' : 'first_work_installations')
          state.workDay = key(now()); state.workedBefore = true
          // Return counters belong to the earlier working-day cohort, not today's new starts.
          // Only these date flags stay here; no server-side installation/user join is needed.
          for (const [lag, metric] of [[1, 'd1_returning_work_installations'], [7, 'd7_returning_work_installations'], [28, 'd28_returning_work_installations']] as const) {
            const cohort = key(now() - lag * DAY)
            if (state.workDays.includes(cohort)) add(metric, cohort)
          }
          state.workDays = [...state.workDays.filter(validDay), key(now())]
        }
        const currentMonth = key(now()).slice(0, 7)
        if (state.workMonth !== currentMonth) {
          add('monthly_working_installations')
          const prior = new Date(currentMonth + '-01T00:00:00Z'); prior.setUTCMonth(prior.getUTCMonth() - 1)
          if (state.workMonth === key(prior.getTime()).slice(0, 7)) add('monthly_returning_installations')
          state.workMonth = currentMonth
        }
        const currentWeek = week(now())
        if (state.workWeek !== currentWeek) {
          add('weekly_working_installations')
          if (state.workWeek === key(Date.parse(currentWeek) - 7 * DAY)) add('weekly_returning_installations')
          state.workWeek = currentWeek
        }
      } else {
        const turn = running.get(agent)
        if (!turn) return
        const elapsed = Math.max(0, now() - turn.started)
        if (!turn.response && !turn.waited && elapsed >= 60_000) { turn.waited = true; add('turns_waiting_over_1m') }
        if (type === 'error') {
          if (!turn.error) { turn.error = true; add('turns_with_error') }
          return
        }
        if (type === 'text_delta') {
          if (!turn.response) {
            turn.response = true; add('turns_with_response')
            // Do not attribute a response from a turn already running when the first launch began.
            if (state.firstLaunchAt !== null && turn.started >= state.firstLaunchAt) launchValue(true)
            if (!state.respondedBefore) { state.respondedBefore = true; add('first_response_installations') }
            add(elapsed < 10_000 ? 'response_under_10s' : elapsed < 60_000 ? 'response_10s_to_1m' : elapsed < 300_000 ? 'response_1m_to_5m' : 'response_over_5m')
          }
          return
        }
        running.delete(agent)
        if (!turn.response) add('turns_ended_without_response')
        add(interrupted ? 'turns_interrupted' : 'turns_ended')
        add(elapsed < 10_000 ? 'duration_under_10s' : elapsed < 60_000 ? 'duration_10s_to_1m' : elapsed < 300_000 ? 'duration_1m_to_5m' : 'duration_over_5m')
      }
    },
    /** Stops collecting and writes the final state (clean, or emptied with [discard]) before it returns, so a
     *  process that exits next keeps it. The promise settles once a write already on its way has too. */
    stop(discard = false): Promise<boolean> {
      if (final !== null) return writing ? writing.then(() => true) : Promise.resolve(true)
      stopped = true; enabled = false; clearTimeout(timer); forget(); health.stop(); tuiHeld = []
      if (discard) { state = fresh(-1); health.reset() }
      final = snapshot()
      const written = writeFinal(final)
      return writing ? writing.then(() => written) : Promise.resolve(written)
    },
  }
}
