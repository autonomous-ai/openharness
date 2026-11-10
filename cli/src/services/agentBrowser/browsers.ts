/**
 * What each agent's browser is doing, and the one place that moves it: setup, start, stop, delete, restarts after an
 * exit, and the daemon start that cleans up after whatever happened while the service was down (spec § Lifecycle).
 * Work for one agent runs in order; different agents run side by side.
 */
import { browserLimit, type Containers } from './containers.js'
import { PodmanError, type Podman } from './podman.js'
import { defaultSettings, settingsHash, type BrowserHost, type BrowserSettings } from './settings.js'
import type { Setup, SetupStep } from './setup.js'
import type { StateFile } from './stateFile.js'

export type BrowserState = { state: 'setup' | 'starting' | 'ready' | 'failed'; step?: SetupStep | 'building'; error?: string }

/** Every failed state the panel has copy for. */
const FAILED_STATES = new Set([
  'needs_setup', 'podman_install_failed', 'podman_manual', 'podman_old', 'podman_memory', 'state_unreadable',
  'podman_down', 'image_failed', 'browser_stopped', 'profile_unwritable', 'proxy_failed', 'browser_limit',
])
const READY_TRIES = 60
const READY_EVERY_MS = 1_000
// Finding an image that exists takes well under this; only a build takes longer, and then the browser says so.
const IMAGE_LOOKUP_MS = 1_000
const MAX_RESTARTS = 3
const FIRST_RESTART_MS = 1_000
// A browser up this long that exits is a person closing its window now and then, not a crash loop.
const STEADY_MS = 10 * 60_000
// The entrypoint's named exits (spec § The container): restarting cannot fix either.
const EXIT_PROFILE_UNWRITABLE = 3
const EXIT_PROXY_FAILED = 4

const STARTING: BrowserState = { state: 'starting' }
const BUILDING: BrowserState = { state: 'setup', step: 'building' }
const failed = (error: string): BrowserState => ({ state: 'failed', error })

/** A failed or timed-out podman call (`podman_failed`), or anything unnamed, is Podman not running. */
function failedState(error: unknown): string {
  const state = error instanceof PodmanError ? error.state : ''
  return FAILED_STATES.has(state) ? state : 'podman_down'
}

const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms))

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

  /** Setup's `step`: recorded first, so a daemon or Windows restart resumes where it stopped. */
  setupStep(step: SetupStep | null, bootTime?: number): void {
    this.deps.state.update(s => { s.setup = step ? { step, bootTime } : null })
    if (step) this.showSetup({ state: 'setup', step })
  }

  stop(agentId: string): Promise<void> {
    this.forget(agentId)
    this.deps.closeViewers(agentId)
    return this.queue(agentId, () => this.deps.containers.stop(agentId))
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
    return this.deps.state.read().browsers[agentId] ?? defaultSettings(this.deps.host)
  }

  /** Human input applies to the next tool call; anything else creates the container again, and the volume stays. */
  async saveSettings(agentId: string, next: BrowserSettings): Promise<void> {
    const before = this.settings(agentId)
    this.deps.state.update(s => { s.browsers[agentId] = next })
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
      this.deps.log(`agent browser: could not list running browsers: ${(error as Error).message}`)
      return
    }
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
      if ((await this.deps.setup.run(this.deps.state.read().setup ?? { step: null })) === 'restart_needed') return
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
    try {
      let settings = defaultSettings(this.deps.host)
      this.deps.state.update(s => { settings = s.browsers[agentId] ??= settings })
      if (!afterSetup) {
        if (this.setupRun) return this.needsSetup(agentId)
        await this.podmanUp()
      }
      const running = await this.deps.containers.running()
      if (!running.includes(agentId) && running.length >= browserLimit(await this.deps.podman.memoryBytes())) {
        throw new PodmanError('browser_limit', `${running.length} browsers already run on this machine`)
      }
      const slow = setTimeout(() => { if (current()) this.set(agentId, BUILDING) }, IMAGE_LOOKUP_MS)
      const image = await this.deps.image().finally(() => clearTimeout(slow))
      if (!current()) return
      this.set(agentId, STARTING)
      const timeZone = await this.timeZone(agentId, settings)
      this.died.delete(agentId)
      const { limitsDropped } = await this.deps.containers.start(agentId, image, settings, timeZone)
      if (limitsDropped.length > 0) this.deps.measure('agent_browser_limit_dropped')
      for (let tries = 0; tries < READY_TRIES; tries++) {
        if (tries > 0) await sleep(READY_EVERY_MS)
        if (!current() || (await this.exitSeen(agentId))) return
        if (await this.deps.containers.ready(agentId)) {
          const restart = this.restarts.get(agentId)
          if (restart) restart.readyAt = this.now()
          this.set(agentId, { state: 'ready' })
          this.deps.measure('agent_browser_start_ok')
          return
        }
      }
      throw new PodmanError('browser_stopped', `the browser was not ready within ${READY_TRIES} s`)
    } catch (error) {
      if (!current()) return
      this.deps.measure('agent_browser_start_failed')
      const state = failedState(error)
      if (state === 'needs_setup') return this.needsSetup(agentId)
      this.fail(agentId, state, (error as Error).message)
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

  private async remove(agentId: string): Promise<void> {
    await this.deps.containers.remove(agentId)
    this.deps.state.update(s => {
      delete s.browsers[agentId]
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
    const next = (this.queues.get(agentId) ?? Promise.resolve()).then(work).catch((error: unknown) => {
      this.deps.log(`agent browser ${agentId}: ${(error as Error).message}`)
    })
    this.queues.set(agentId, next)
    void next.then(() => { if (this.queues.get(agentId) === next) this.queues.delete(agentId) })
    return next
  }
}
