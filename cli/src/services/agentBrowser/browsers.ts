/**
 * What each agent's browser is doing, and the one place that moves it: setup, start, stop, delete, restarts after an
 * exit, the daemon start that cleans up after whatever happened while the service was down (spec § Lifecycle), and the
 * move of an entry, with the profile its names come from, to the agent that took its pane (decision 19). Work for one
 * agent runs in order; different agents run side by side, and a move holds both agents' queues.
 */
import { randomUUID } from 'node:crypto'
import { browserLimit, type Containers } from './containers.js'
import { PodmanError, type Podman } from './podman.js'
import { defaultSettings, settingsHash, type BrowserHost, type BrowserSettings } from './settings.js'
import type { Setup, SetupStep } from './setup.js'
import type { BrowserStateData, SavedBrowser, StateFile } from './stateFile.js'

export type BrowserState = { state: 'setup' | 'starting' | 'ready' | 'failed'; step?: SetupStep | 'building'; error?: string }

/** Every failed state the panel has copy for. */
const FAILED_STATES = new Set([
  'needs_setup', 'podman_install_failed', 'podman_manual', 'podman_old', 'podman_memory', 'state_unreadable',
  'podman_down', 'image_failed', 'browser_stopped', 'profile_unwritable', 'proxy_failed', 'browser_limit',
  'device_failed',
])
const READY_TRIES = 60
const READY_EVERY_MS = 1_000
// Finding an image that exists takes well under this; only a build takes longer, and then the browser says so.
const IMAGE_LOOKUP_MS = 1_000
const MAX_RESTARTS = 3
const FIRST_RESTART_MS = 1_000
// A browser up this long that exits is a person closing its window now and then, not a crash loop.
const STEADY_MS = 10 * 60_000
// The entrypoint's named exits (spec § The container): restarting cannot fix any of them.
const EXIT_PROFILE_UNWRITABLE = 3
const EXIT_PROXY_FAILED = 4
const EXIT_DEVICE_FAILED = 5

const STARTING: BrowserState = { state: 'starting' }
const BUILDING: BrowserState = { state: 'setup', step: 'building' }
const failed = (error: string): BrowserState => ({ state: 'failed', error })

/** A failed or timed-out podman call (`podman_failed`), or anything unnamed, is Podman not running. */
function failedState(error: unknown): string {
  const state = error instanceof PodmanError ? error.state : ''
  return FAILED_STATES.has(state) ? state : 'podman_down'
}

const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms))

/**
 * The proxy as the state file keeps it: beside its password, a random id that a new password replaces. The container's
 * settings label carries the id, never anything made from the password.
 */
type SavedProxy = NonNullable<BrowserSettings['proxy']> & { secretId?: string }

/** The person's settings, without what only the service keeps: the profile and the proxy's id. */
function settingsOf(saved: SavedBrowser): BrowserSettings {
  const { profile: _profile, ...settings } = saved
  if (!settings.proxy) return settings
  const { secretId: _secretId, ...proxy } = settings.proxy as SavedProxy
  return { ...settings, proxy }
}

/** Whether another entry holds [agentId] as its profile: that agent's browser went with its pane. */
function heldByAnother(browsers: Record<string, SavedBrowser>, agentId: string): boolean {
  return Object.values(browsers).some(saved => saved.profile === agentId)
}

/**
 * [saved] as [agentId]'s entry: with its entry's profile, or, made new for an agent whose id another entry holds, a
 * profile of its own, so the volume that went with its pane is never its (call 27). Any other new entry has none.
 */
function entryOf(browsers: Record<string, SavedBrowser>, agentId: string, saved: SavedBrowser): SavedBrowser {
  const own = browsers[agentId]
  const profile = own ? own.profile : heldByAnother(browsers, agentId) ? randomUUID() : undefined
  return profile === undefined ? saved : { ...saved, profile }
}

export class Browsers {
  private readonly states = new Map<string, BrowserState>()
  private readonly queues = new Map<string, Promise<void>>()
  /** Bumped by stop and delete, so work already asked for the agent ends without starting anything. */
  private readonly generations = new Map<string, number>()
  /** Agents whose browser waits for Podman to be set up. */
  private readonly waiting = new Set<string>()
  /** Agents an exit was heard for, checked against Podman before anything acts on it. */
  private readonly died = new Set<string>()
  private readonly restarts = new Map<string, { count: number; readyAt: number | null; timer?: NodeJS.Timeout }>()
  /**
   * Agents between passing the browser limit and being ready, counted with what Podman lists as running. Claimed in
   * the same turn as the check: three browsers attached at daemon start each saw none running, and all started on a
   * machine with room for one (review, 2026-11-10).
   */
  private readonly starting = new Set<string>()
  /** Whether the last look at what runs failed, so a Podman that stays down is logged once. */
  private listingFailed = false
  /** What a browser waiting on setup shows: its current step, or how it failed. */
  private setupShown: BrowserState | null = null
  private setupRun: Promise<void> | null = null
  private readonly now: () => number

  constructor(private readonly deps: {
    podman: Podman
    containers: Containers
    setup: Setup
    image: () => Promise<string>
    state: StateFile
    host: BrowserHost
    exitZone: (proxy: NonNullable<BrowserSettings['proxy']>) => Promise<string | null>
    changed: (agentId: string) => void
    closeViewers: (agentId: string) => void
    measure: (name: string) => void
    log: (line: string) => void
    /** Podman listed what runs for a start: the event stream, if it gave up, connects again. */
    podmanAnswered: () => void
    now?: () => number
  }) {
    this.now = deps.now ?? Date.now
    // Before anything asks Podman: a browser on Harness's own machine must never start on the person's.
    let connection: string | null | undefined
    try {
      connection = deps.state.read().connection
    } catch {
      // resume names the unreadable file, and starts nothing until it is fixed.
    }
    if (connection) deps.podman.useConnection(connection)
  }

  start(agentId: string): Promise<void> {
    const generation = this.generation(agentId)
    return this.queue(agentId, () => this.launch(agentId, generation))
  }

  /** Runs setup from its recorded step, then starts every browser waiting on it. One run at a time. */
  setUp(): Promise<void> {
    return this.setupRun ??= this.runSetup().finally(() => { this.setupRun = null })
  }

  /** Setup's `step`: recorded first, so a daemon restart resumes where it stopped. */
  setupStep(step: SetupStep | null): void {
    this.deps.state.update(s => { s.setup = step ? { step } : null })
    if (step) this.showSetup({ state: 'setup', step })
  }

  stop(agentId: string): Promise<void> {
    this.forget(agentId)
    this.deps.closeViewers(agentId)
    return this.queue(agentId, async () => {
      const profile = this.profile(agentId)
      if (profile !== null) await this.deps.containers.stop(profile)
    })
  }

  /**
   * The id [agentId]'s browser is named by: its entry's `profile`, else its own id. Null for an agent with no entry
   * whose id another entry holds as its profile: its browser went with its pane, and nothing of that name is its.
   */
  profile(agentId: string): string | null {
    const { browsers } = this.deps.state.read()
    const own = browsers[agentId]
    if (own) return own.profile ?? agentId
    return heldByAnother(browsers, agentId) ? null : agentId
  }

  /**
   * [from]'s entry, its profile with it, becomes [to]'s (decision 19): [from]'s browser is stopped first, in both
   * agents' queues. False, changing nothing, when [from] has no entry or is being deleted, or [to] has an entry of
   * its own. Rejects when the state file cannot be written: both entries are as they were.
   */
  move(from: string, to: string): Promise<boolean> {
    return this.inQueues([from, to], async () => {
      const movable = (s: BrowserStateData) => s.browsers[from] !== undefined && !s.deleting.includes(from) && s.browsers[to] === undefined
      const saved = this.deps.state.read()
      if (!movable(saved)) return false
      if (this.states.has(from)) {
        this.forget(from)
        this.deps.closeViewers(from)
        // The volume stays: it is what moves.
        await this.deps.containers.stop(saved.browsers[from]!.profile ?? from).catch((error: unknown) => {
          this.deps.log(`agent browser ${from}: the browser that moved was not stopped: ${(error as Error).message}`)
        })
      }
      let moved = false
      this.deps.state.update(s => {
        // A save for [to] or a delete of [from] while the browser stopped: nothing moves.
        if (!movable(s)) return
        const entry = s.browsers[from]!
        s.browsers[to] = { ...entry, profile: entry.profile ?? from }
        delete s.browsers[from]
        // [from]'s mark goes with its entry, and [to] gets none: a new conversation, owed its ready line once its
        // browser is ready.
        delete s.told?.[from]
        moved = true
      })
      if (moved) this.deps.log(`agent browser ${to}: took the browser of ${from}`)
      return moved
    })
  }

  /** Recorded before anything is removed, so a delete cut off by a crash is finished at the next service start. */
  async delete(agentId: string): Promise<void> {
    this.forget(agentId)
    this.deps.closeViewers(agentId)
    try {
      this.deps.state.update(s => { if (!s.deleting.includes(agentId)) s.deleting.push(agentId) })
    } catch (error) {
      this.deps.log(`agent browser ${agentId}: not deleted: ${(error as Error).message}`)
      return
    }
    await this.queue(agentId, () => this.remove(agentId))
  }

  retry(agentId: string): Promise<void> {
    clearTimeout(this.restarts.get(agentId)?.timer)
    this.restarts.delete(agentId)
    // A failed install goes again from its step; only Install asks for a password the first time.
    if (this.waiting.has(agentId) && this.states.get(agentId)?.error !== 'needs_setup') return this.setUp()
    return this.start(agentId)
  }

  state(agentId: string): BrowserState | undefined {
    return this.states.get(agentId)
  }

  settings(agentId: string): BrowserSettings {
    const saved = this.deps.state.read().browsers[agentId]
    return saved ? settingsOf(saved) : defaultSettings(this.deps.host)
  }

  /**
   * Human input applies to the next tool call; anything else creates the container again, and the volume stays. A new
   * password drops the proxy's id, so the next start makes another and the label changes. The entry's profile stays.
   */
  async saveSettings(agentId: string, next: BrowserSettings): Promise<void> {
    const before = this.settings(agentId)
    this.deps.state.update(s => {
      const kept = (s.browsers[agentId]?.proxy as SavedProxy | null | undefined)?.secretId
      const saved = !kept || !next.proxy || next.proxy.password !== before.proxy?.password
        ? next
        : { ...next, proxy: { ...next.proxy, secretId: kept } satisfies SavedProxy }
      s.browsers[agentId] = entryOf(s.browsers, agentId, saved)
    })
    const shown = this.states.get(agentId)
    if (shown && shown.state !== 'setup' && settingsHash(before) !== settingsHash(next)) void this.start(agentId)
  }

  /** From the event stream. An exit the service asked for finds the container gone or running again, and is let be. */
  exited(agentId: string): void {
    const shown = this.states.get(agentId)?.state
    if (shown !== 'ready' && shown !== 'starting') return
    this.died.add(agentId)
    // A starting browser's own start looks at it while it waits for the browser to be ready.
    if (shown === 'ready') void this.queue(agentId, async () => { await this.exitSeen(agentId) })
  }

  /** After the event stream reconnects: one look at what runs, for an exit it missed. */
  async reconcile(): Promise<void> {
    let running: Set<string>
    try {
      running = new Set(await this.deps.containers.running())
    } catch (error) {
      if (!this.listingFailed) this.deps.log(`agent browser: could not list running browsers: ${(error as Error).message}`)
      this.listingFailed = true
      return
    }
    this.listingFailed = false
    for (const [agentId, shown] of this.states) if (shown.state === 'ready' && !running.has(agentId)) this.exited(agentId)
  }

  /**
   * At service start. `known` is the core's live and stopped agents, or null when it gave no answer: then only the
   * deletes already recorded are finished, since a missing answer must never delete a person's login.
   */
  async resume(known: Set<string> | null): Promise<void> {
    let saved
    try {
      saved = this.deps.state.read()
    } catch (error) {
      // Every browser shows state_unreadable as it starts, until a person fixes or removes the file.
      this.deps.log(`agent browser: ${(error as Error).message}; nothing is removed or started`)
      return
    }
    for (const agentId of saved.deleting) await this.queue(agentId, () => this.remove(agentId))
    if (known) {
      for (const agentId of Object.keys(saved.browsers)) if (!known.has(agentId)) await this.delete(agentId)
      try {
        const swept = await this.deps.containers.sweep(new Set(Object.keys(this.deps.state.read().browsers)))
        if (swept > 0) this.deps.log(`agent browser: removed ${swept} containers this daemon no longer lists`)
      } catch (error) {
        this.deps.log(`agent browser: could not sweep containers: ${(error as Error).message}`)
      }
    }
    // An install cut off is never run again by itself: it would raise the password dialog nobody asked for.
    if (saved.setup?.step === 'installing') {
      this.setupShown = failed('podman_install_failed')
    } else if (saved.setup) {
      this.setupShown = { state: 'setup', step: saved.setup.step }
      void this.setUp()
    }
  }

  private async runSetup(): Promise<void> {
    try {
      await this.deps.setup.run(this.deps.state.read().setup ?? { step: null })
    } catch (error) {
      const state = failedState(error)
      this.deps.measure('agent_browser_setup_failed')
      this.deps.log(`agent browser: setup failed (${state}): ${(error as Error).message}`)
      this.setupShown = failed(state)
      for (const agentId of this.waiting) this.fail(agentId, state)
      return
    }
    this.deps.measure('agent_browser_setup_ok')
    this.deps.state.update(s => { s.connection = this.deps.podman.connection() })
    this.setupShown = null
    const waiting = [...this.waiting]
    this.waiting.clear()
    await Promise.all(waiting.map(agentId => {
      this.set(agentId, BUILDING)
      const generation = this.generation(agentId)
      return this.queue(agentId, () => this.launch(agentId, generation, true))
    }))
  }

  /** `afterSetup`: setup has just put Podman here and started it, so its availability, cached from before, is not asked. */
  private async launch(agentId: string, generation: number, afterSetup = false): Promise<void> {
    const current = () => this.generation(agentId) === generation
    if (!current()) return
    if (this.states.get(agentId)?.state !== 'setup') this.set(agentId, STARTING)
    let claimed = false
    try {
      let settings = defaultSettings(this.deps.host)
      let secretId = ''
      // Resolved once for the whole start: its every name, and its every look at whether it is ready.
      let profile = agentId
      this.deps.state.update(s => {
        const saved = s.browsers[agentId] ??= entryOf(s.browsers, agentId, settings)
        // Made here, the one place a proxy is applied, after a save with a new password dropped the last one.
        if (saved.proxy) secretId = (saved.proxy as SavedProxy).secretId ??= randomUUID()
        profile = saved.profile ?? agentId
        settings = settingsOf(saved)
      })
      if (!afterSetup) {
        if (this.setupRun) return this.needsSetup(agentId)
        await this.podmanUp()
      }
      const running = await this.deps.containers.running()
      this.deps.podmanAnswered()
      const limit = browserLimit(await this.deps.podman.memoryBytes())
      // No await between the count and the claim.
      const taken = new Set([...running, ...this.starting])
      if (!running.includes(agentId) && taken.size >= limit) {
        throw new PodmanError('browser_limit', `${taken.size} browsers already run on this machine`)
      }
      this.starting.add(agentId)
      claimed = true
      const slow = setTimeout(() => { if (current()) this.set(agentId, BUILDING) }, IMAGE_LOOKUP_MS)
      const image = await this.deps.image().finally(() => clearTimeout(slow))
      if (!current()) return
      this.set(agentId, STARTING)
      const timeZone = await this.timeZone(agentId, settings)
      this.died.delete(agentId)
      const { limitsDropped } = await this.deps.containers.start(agentId, profile, image, settings, timeZone, secretId)
      if (limitsDropped.length > 0) this.deps.measure('agent_browser_limit_dropped')
      for (let tries = 0; tries < READY_TRIES; tries++) {
        if (tries > 0) await sleep(READY_EVERY_MS)
        if (!current() || (await this.exitSeen(agentId))) return
        if (await this.deps.containers.ready(profile)) {
          const restart = this.restarts.get(agentId)
          if (restart) restart.readyAt = this.now()
          this.set(agentId, { state: 'ready' })
          this.deps.measure('agent_browser_start_ok')
          return
        }
      }
      // Left up, it would run unseen and count against the limit.
      await this.deps.containers.stop(profile).catch((error: unknown) => {
        this.deps.log(`agent browser ${agentId}: the browser that was not ready was not removed: ${(error as Error).message}`)
      })
      throw new PodmanError('browser_stopped', `the browser was not ready within ${READY_TRIES} s`)
    } catch (error) {
      if (!current()) return
      this.deps.measure('agent_browser_start_failed')
      const state = failedState(error)
      if (state === 'needs_setup') return this.needsSetup(agentId)
      this.fail(agentId, state, (error as Error).message)
    } finally {
      // Ready, it runs and Podman lists it; anything else, it holds no slot.
      if (claimed) this.starting.delete(agentId)
    }
  }

  private async podmanUp(): Promise<void> {
    const availability = await this.deps.podman.available()
    if (availability.state === 'stopped') await this.deps.podman.startMachine()
    else if (availability.state !== 'ready') throw new PodmanError(availability.state, `Podman is ${availability.state}`)
  }

  private needsSetup(agentId: string): void {
    this.waiting.add(agentId)
    if (this.setupShown) this.set(agentId, this.setupShown)
    else if (!this.setupRun) this.fail(agentId, 'needs_setup')
  }

  private showSetup(shown: BrowserState): void {
    this.setupShown = shown
    for (const agentId of this.waiting) this.set(agentId, shown)
  }

  /** Auto is the proxy's exit zone, or the machine's. */
  private async timeZone(agentId: string, settings: BrowserSettings): Promise<string> {
    if (settings.timeZone) return settings.timeZone
    if (!settings.proxy) return this.deps.host.timeZone
    const exit = await this.deps.exitZone(settings.proxy)
    if (exit) return exit
    this.deps.log(`agent browser ${agentId}: the proxy's exit zone could not be looked up; using this machine's zone`)
    return this.deps.host.timeZone
  }

  /** True when an exit was heard and Podman confirms the container stopped; then it is handled here. */
  private async exitSeen(agentId: string): Promise<boolean> {
    if (!this.died.delete(agentId)) return false
    const code = await this.deps.containers.exitCode(agentId)
    if (code === null) return false
    if (code === EXIT_PROFILE_UNWRITABLE) this.fail(agentId, 'profile_unwritable')
    else if (code === EXIT_PROXY_FAILED) this.fail(agentId, 'proxy_failed')
    else if (code === EXIT_DEVICE_FAILED) this.fail(agentId, 'device_failed')
    else this.restartLater(agentId, code)
    return true
  }

  private restartLater(agentId: string, code: number): void {
    const restart = this.restarts.get(agentId) ?? { count: 0, readyAt: null }
    if (restart.readyAt !== null && this.now() - restart.readyAt >= STEADY_MS) restart.count = 0
    if (restart.count >= MAX_RESTARTS) return this.fail(agentId, 'browser_stopped', `it exited ${MAX_RESTARTS + 1} times in a row (last ${code})`)
    const delay = FIRST_RESTART_MS * 2 ** restart.count
    restart.count += 1
    restart.readyAt = null
    this.deps.log(`agent browser ${agentId}: the browser exited (${code}); starting it again in ${delay / 1000} s`)
    this.set(agentId, STARTING)
    // stop and delete clear it.
    restart.timer = setTimeout(() => void this.start(agentId), delay)
    this.restarts.set(agentId, restart)
  }

  /** The volume of the agent's own profile, and no other: none when its id names a browser that went with its pane. */
  private async remove(agentId: string): Promise<void> {
    const profile = this.profile(agentId)
    if (profile !== null) await this.deps.containers.remove(profile)
    this.deps.state.update(s => {
      delete s.browsers[agentId]
      // The agent is gone: nobody is left owing or owed its ready line (notices.ts).
      delete s.told?.[agentId]
      s.deleting = s.deleting.filter(id => id !== agentId)
    })
  }

  private forget(agentId: string): void {
    this.generations.set(agentId, this.generation(agentId) + 1)
    clearTimeout(this.restarts.get(agentId)?.timer)
    this.restarts.delete(agentId)
    this.waiting.delete(agentId)
    this.died.delete(agentId)
    if (this.states.delete(agentId)) this.deps.changed(agentId)
  }

  private generation(agentId: string): number {
    return this.generations.get(agentId) ?? 0
  }

  private fail(agentId: string, error: string, why?: string): void {
    this.set(agentId, failed(error))
    this.deps.measure(`agent_browser_failed_${error}`)
    this.deps.log(`agent browser ${agentId}: failed (${error})${why ? `: ${why}` : ''}`)
  }

  private set(agentId: string, next: BrowserState): void {
    const shown = this.states.get(agentId)
    if (shown?.state === next.state && shown.step === next.step && shown.error === next.error) return
    this.states.set(agentId, next)
    this.deps.changed(agentId)
  }

  private queue(agentId: string, work: () => Promise<void>): Promise<void> {
    return this.inQueues([agentId], work).catch((error: unknown) => {
      this.deps.log(`agent browser ${agentId}: ${(error as Error).message}`)
    })
  }

  /**
   * [work] runs once everything already asked for each of [agentIds] has ended, and each one's later work waits for
   * it; its own outcome is returned. Taken in every queue at once, so two works over the same agents never wait for
   * each other.
   */
  private inQueues<T>(agentIds: string[], work: () => Promise<T>): Promise<T> {
    const result = Promise.all(agentIds.map(agentId => this.queues.get(agentId))).then(work)
    const ended = result.then(() => {}, () => {})
    for (const agentId of agentIds) this.queues.set(agentId, ended)
    void ended.then(() => {
      for (const agentId of agentIds) if (this.queues.get(agentId) === ended) this.queues.delete(agentId)
    })
    return result
  }
}
