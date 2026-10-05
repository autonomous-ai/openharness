import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CORE_EXIT_STOP, CORE_EXIT_UPDATE, HARNESSD_PROTOCOL, type MasterMessage } from './protocol.js'
import { DEFAULT_SUPERVISOR_OPTIONS, Supervisor, type CoreHandle, type SupervisorOptions, type SupervisorStatus } from './supervisor.js'

const MIB = 1024 * 1024

class FakeCore implements CoreHandle {
  readonly sent: MasterMessage[] = []
  readonly kills: NodeJS.Signals[] = []
  private messageListeners: Array<(message: unknown) => void> = []
  private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  constructor(readonly pid: number | undefined, readonly env: Record<string, string>) {}
  send(message: MasterMessage): void { this.sent.push(message) }
  kill(signal: NodeJS.Signals): void { this.kills.push(signal) }
  onMessage(listener: (message: unknown) => void): void { this.messageListeners.push(listener) }
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void { this.exitListeners.push(listener) }
  say(message: unknown): void { for (const listener of this.messageListeners) listener(message) }
  bind(protocol = HARNESSD_PROTOCOL): void { this.say({ type: 'harnessd:bound', protocol, port: 18473 }) }
  ready(safeMode?: string): void { this.say(safeMode === undefined ? { type: 'harnessd:ready' } : { type: 'harnessd:ready', safeMode }) }
  /** Bound and ready: up, the way a healthy start-up ends. */
  up(): void { this.bind(); this.ready() }
  beat(rssBytes = 100 * MIB, heapUsedBytes = rssBytes / 2): void { this.say({ type: 'harnessd:heartbeat', rssBytes, heapUsedBytes, loopDelayMs: 3 }) }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void { for (const listener of this.exitListeners) listener(code, signal) }
}

const options: SupervisorOptions = {
  ...DEFAULT_SUPERVISOR_OPTIONS,
  bindTimeoutMs: 10_000,
  readyTimeoutMs: 8_000,
  heartbeatTimeoutMs: 6_000,
  stopGraceMs: 2_000,
  initialBackoffMs: 500,
  maxBackoffMs: 4_000,
  backoffResetMs: 20_000,
  heapLimitMiB: 1_024,
  heapRestartPercent: 75,
  rssLimitMiB: 2_048,
  updateProbationMs: 5_000,
  crashLoopCrashes: 3,
  crashLoopWindowMs: 60_000,
}

describe('Supervisor', () => {
  let cores: FakeCore[]
  let calls: string[]
  let lines: string[]
  let exited: number[]
  let statuses: SupervisorStatus[]
  let pidOf: (index: number) => number | undefined
  const core = () => cores[cores.length - 1]

  const make = (overrides: Partial<SupervisorOptions> = {}) => new Supervisor({
    spawnCore: (env) => {
      const next = new FakeCore(pidOf(cores.length), env)
      cores.push(next)
      return next
    },
    now: () => performance.now(),
    wallClock: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    claimPidFile: () => calls.push('claim'),
    releasePidFile: () => calls.push('release'),
    restoreUpdate: () => calls.push('restore'),
    confirmUpdate: () => calls.push('confirm'),
    writeStatus: (status) => statuses.push(status),
    log: (line) => lines.push(line),
    exit: (code) => exited.push(code),
  }, { ...options, ...overrides })

  /** Let time pass for a running core, beating as a healthy one does. */
  const live = (ms: number) => { for (let left = ms; left > 0; left -= 1_000) { vi.advanceTimersByTime(Math.min(1_000, left)); core().beat() } }
  /** Crash the running core and let its replacement start. */
  const crash = (code: number | null = 1, signal: NodeJS.Signals | null = null) => { core().exit(code, signal); vi.runOnlyPendingTimers() }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    cores = []
    calls = []
    lines = []
    exited = []
    statuses = []
    pidOf = (index) => 1000 + index
  })
  afterEach(() => vi.useRealTimers())

  it('starts one core, claims the pid file once it is bound, and runs it once it is ready', () => {
    const supervisor = make()
    expect(new Supervisor({ wallClock: () => 7 } as never).status())
      .toEqual({ state: 'idle', corePid: null, restarts: 0, lastExit: null, lastExitReason: null, safeMode: null, protocol: HARNESSD_PROTOCOL, since: 7 })
    supervisor.start()
    supervisor.start()
    expect(cores).toHaveLength(1)
    expect(core().env).toEqual({ HARNESSD_SUPERVISED: '1', HARNESSD_RESTARTS: '0', HARNESSD_WATCHDOG_MS: '6000' })
    expect(supervisor.status()).toMatchObject({ state: 'starting', corePid: 1000 })
    core().bind()
    expect(calls).toEqual(['claim'])
    expect(supervisor.status().state).toBe('listening')
    core().bind()
    expect(calls).toEqual(['claim'])
    vi.advanceTimersByTime(1_000)
    core().ready()
    expect(supervisor.status()).toEqual({
      state: 'running', corePid: 1000, restarts: 0, lastExit: null, lastExitReason: null, safeMode: null,
      protocol: HARNESSD_PROTOCOL, since: Date.now(),
    })
    expect(lines.at(-1)).toBe('[harnessd] core ready (pid 1000)')
    // Every change is written for `harness status`, and told to the bound core.
    expect(statuses.map((status) => status.state)).toEqual(['starting', 'listening', 'running'])
    expect(core().sent.map((message) => message.status.state)).toEqual(['listening', 'running'])
    core().ready()
    expect(statuses).toHaveLength(3)
  })

  it('ignores what is not a core message, and anything but a bind before the bind', () => {
    const supervisor = make()
    supervisor.start()
    core().say(null)
    core().say({ type: 'other' })
    core().beat()
    core().ready()
    vi.advanceTimersByTime(options.bindTimeoutMs - 1)
    expect(core().kills).toEqual([])
    expect(supervisor.status().state).toBe('starting')
  })

  it('kills a core that never binds and starts another after the backoff', () => {
    pidOf = (index) => (index === 1 ? undefined : 1000 + index)
    const supervisor = make()
    supervisor.start()
    vi.advanceTimersByTime(options.bindTimeoutMs)
    expect(core().kills).toEqual(['SIGKILL'])
    core().exit(null, 'SIGKILL')
    expect(supervisor.status()).toMatchObject({ state: 'restarting', restarts: 1, lastExit: 'signal SIGKILL', lastExitReason: 'did-not-bind' })
    vi.advanceTimersByTime(499)
    expect(cores).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(cores).toHaveLength(2)
    expect(core().env).toEqual({ HARNESSD_SUPERVISED: '1', HARNESSD_RESTARTS: '1', HARNESSD_WATCHDOG_MS: '6000', HARNESSD_LAST_EXIT: 'signal SIGKILL' })
    expect(lines.at(-1)).toBe('[harnessd] core started (pid ?) · restart 1')
    core().bind()
    expect(lines.at(-1)).toBe(`[harnessd] core bound (pid ?, protocol ${HARNESSD_PROTOCOL})`)
    core().ready()
    expect(lines.at(-1)).toBe('[harnessd] core ready (pid ?)')
  })

  it('kills a core that binds but never finishes starting', () => {
    const supervisor = make()
    supervisor.start()
    core().bind()
    // Its heartbeats go on — an event loop that turns — and still it never says it is ready.
    for (let i = 0; i < 7; i++) { vi.advanceTimersByTime(1_000); core().beat() }
    expect(core().kills).toEqual([])
    vi.advanceTimersByTime(1_000)
    expect(core().kills).toEqual(['SIGKILL'])
    expect(lines.at(-1)).toBe(`[harnessd] core bound but not ready within ${options.readyTimeoutMs} ms — killing it`)
    core().exit(null, 'SIGKILL')
    expect(supervisor.status()).toMatchObject({ restarts: 1, lastExitReason: 'not-ready' })
  })

  it('kills a bound core whose heartbeats stop: it is hung', () => {
    const supervisor = make()
    supervisor.start()
    core().up()
    vi.advanceTimersByTime(5_000)
    core().beat()
    vi.advanceTimersByTime(5_999)
    expect(core().kills).toEqual([])
    vi.advanceTimersByTime(1)
    expect(core().kills).toEqual(['SIGKILL'])
    core().exit(null, 'SIGKILL')
    expect(supervisor.status().lastExitReason).toBe('hung')
  })

  it('backs off crash after crash, up to its cap, and starts over after a good run', () => {
    const supervisor = make({ crashLoopCrashes: 100 })
    supervisor.start()
    const delays: number[] = []
    for (let i = 0; i < 5; i++) {
      const before = Date.now()
      core().exit(1)
      const spawned = cores.length
      while (cores.length === spawned) vi.advanceTimersByTime(100)
      delays.push(Date.now() - before)
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 4000])
    core().up()
    live(options.backoffResetMs)
    const before = Date.now()
    crash()
    expect(Date.now() - before).toBe(500)
    expect(supervisor.status()).toMatchObject({ restarts: 6, lastExitReason: 'crashed' })
  })

  describe('what an exit means', () => {
    it('stops for good with a core that says so (78), releasing the pid file it claimed', () => {
      const supervisor = make()
      supervisor.start()
      core().up()
      core().exit(CORE_EXIT_STOP)
      expect(exited).toEqual([0])
      expect(calls).toEqual(['claim', 'release'])
      expect(supervisor.status()).toMatchObject({ state: 'stopped', lastExit: `code ${CORE_EXIT_STOP}`, lastExitReason: 'stopped' })
      expect(lines.at(-1)).toBe(`[harnessd] core stopped for good (code ${CORE_EXIT_STOP}) — stopping`)
    })

    it('restarts a core that exits 0 — an emptied event loop, or a SIGTERM from outside', () => {
      const supervisor = make()
      supervisor.start()
      core().up()
      crash(0)
      expect(exited).toEqual([])
      expect(cores).toHaveLength(2)
      expect(supervisor.status()).toMatchObject({ restarts: 1, lastExit: 'code 0', lastExitReason: 'crashed' })
      // One that never even bound is held to this protocol too.
      crash(0)
      expect(cores).toHaveLength(3)
    })

    it('holds a core from before `ready` to what it could say: running once bound, stopped for good by 0', () => {
      const supervisor = make()
      supervisor.start()
      core().bind(1)
      expect(supervisor.status().state).toBe('running')
      live(options.readyTimeoutMs * 2)
      expect(core().kills).toEqual([])
      core().exit(0)
      expect(exited).toEqual([0])
    })

    it('restarts a protocol 1 core that the master itself was restarting, whatever its exit', () => {
      make({ rssLimitMiB: 512 }).start()
      core().bind(1)
      core().beat(600 * MIB)
      core().exit(0)
      vi.runOnlyPendingTimers()
      expect(exited).toEqual([])
      expect(cores).toHaveLength(2)
    })
  })

  describe('memory', () => {
    it('restarts a core past its share of the heap limit, cleanly, before V8 would abort it', () => {
      const supervisor = make()
      supervisor.start()
      core().up()
      core().beat(100 * MIB, 767 * MIB)
      expect(core().kills).toEqual([])
      core().beat(100 * MIB, 769 * MIB)
      core().beat(100 * MIB, 900 * MIB)
      expect(core().kills).toEqual(['SIGTERM'])
      expect(lines.at(-1)).toBe('[harnessd] core its heap is at 769 MiB, past 75% of its 1024 MiB limit — restarting it')
      core().exit(0)
      expect(supervisor.status().lastExitReason).toBe('memory')
    })

    it('restarts a core over its resident budget, by SIGTERM, then SIGKILL if it lingers, backing off', () => {
      const supervisor = make({ crashLoopCrashes: 100 })
      supervisor.start()
      core().up()
      core().beat(2_047 * MIB, 10 * MIB)
      expect(core().kills).toEqual([])
      core().beat(2_049 * MIB, 10 * MIB)
      expect(core().kills).toEqual(['SIGTERM'])
      vi.advanceTimersByTime(options.stopGraceMs)
      expect(core().kills).toEqual(['SIGTERM', 'SIGKILL'])
      core().exit(0)
      expect(exited).toEqual([])
      vi.advanceTimersByTime(options.initialBackoffMs - 1)
      expect(cores).toHaveLength(1)
      vi.advanceTimersByTime(1)
      expect(cores).toHaveLength(2)
      expect(supervisor.status()).toMatchObject({ lastExit: 'code 0', lastExitReason: 'memory' })
      // Over budget again at once: it backs off like a crash rather than restarting as fast as it binds.
      core().up()
      core().beat(4_000 * MIB, 10 * MIB)
      core().exit(0)
      vi.advanceTimersByTime(options.initialBackoffMs * 2 - 1)
      expect(cores).toHaveLength(2)
      vi.advanceTimersByTime(1)
      expect(cores).toHaveLength(3)
    })

    it('does not check memory with budgets of 0', () => {
      make({ rssLimitMiB: 0, heapLimitMiB: 0 }).start()
      core().up()
      core().beat(64 * 1024 * MIB, 64 * 1024 * MIB)
      expect(core().kills).toEqual([])
    })
  })

  describe('crash loops', () => {
    it('starts the core in safe mode after enough crashes close together, and a normal one after', () => {
      const supervisor = make()
      supervisor.start()
      crash()
      vi.advanceTimersByTime(options.crashLoopWindowMs) // the first crash ages out
      crash()
      crash()
      expect(core().env.HARNESSD_SAFE_MODE).toBeUndefined()
      crash()
      expect(lines).toContain('[harnessd] core crashed 3 times in 1 min — starting it in safe mode')
      expect(core().env.HARNESSD_SAFE_MODE).toBe('crash-loop')
      expect(lines.at(-1)).toMatch(/· safe mode: crash-loop$/)
      expect(supervisor.status().safeMode).toBe('crash-loop')
      core().bind()
      core().ready('harnessd saw this core crash again and again')
      expect(supervisor.status()).toMatchObject({ state: 'running', safeMode: 'harnessd saw this core crash again and again' })
      // Safe mode ran out without a fix: a normal core gets another try, and its crashes count afresh.
      crash()
      expect(core().env.HARNESSD_SAFE_MODE).toBeUndefined()
      expect(supervisor.status().safeMode).toBeNull()
      crash()
      expect(core().env.HARNESSD_SAFE_MODE).toBeUndefined()
    })

    it('leaves safe mode at once for an update', () => {
      make().start()
      crash(); crash(); crash()
      expect(core().env.HARNESSD_SAFE_MODE).toBe('crash-loop')
      core().bind()
      core().ready('waiting for a fix')
      core().exit(CORE_EXIT_UPDATE)
      vi.advanceTimersByTime(0)
      expect(core().env.HARNESSD_SAFE_MODE).toBeUndefined()
    })

    it('reports a core that fell into safe mode on its own, and gives it a normal try after', () => {
      const supervisor = make()
      supervisor.start()
      core().bind()
      core().ready('start-up failed: no tmux')
      expect(supervisor.status().safeMode).toBe('start-up failed: no tmux')
      crash()
      expect(supervisor.status().safeMode).toBeNull()
      expect(core().env.HARNESSD_SAFE_MODE).toBeUndefined()
    })
  })

  it('stops the core and itself on request, and kills the core on a second request', () => {
    const supervisor = make()
    supervisor.start()
    core().up()
    supervisor.stop('SIGTERM')
    expect(core().kills).toEqual(['SIGTERM'])
    expect(supervisor.status().state).toBe('stopping')
    supervisor.stop('SIGTERM')
    expect(core().kills).toEqual(['SIGTERM', 'SIGKILL'])
    core().bind()
    core().beat(64 * 1024 * MIB)
    expect(supervisor.status().state).toBe('stopping')
    core().exit(null, 'SIGKILL')
    expect(exited).toEqual([0])
    expect(calls).toEqual(['claim', 'release'])
    expect(supervisor.status()).toMatchObject({ state: 'stopped', lastExitReason: 'stopped' })
    supervisor.stop('again')
    expect(exited).toEqual([0])
  })

  it('stops while a core is still starting, without waiting for it to be ready', () => {
    const supervisor = make()
    supervisor.start()
    core().bind()
    supervisor.stop('SIGTERM')
    vi.advanceTimersByTime(options.readyTimeoutMs)
    expect(core().kills).toEqual(['SIGTERM', 'SIGKILL'])
    core().ready()
    expect(supervisor.status().state).toBe('stopping')
  })

  it('binds a core that was asked to stop before it bound, without calling it running', () => {
    const supervisor = make()
    supervisor.start()
    supervisor.stop('SIGTERM')
    core().bind()
    expect(supervisor.status().state).toBe('stopping')
  })

  it('stops at once when there is no core: never started, or waiting to restart one', () => {
    const idle = make()
    idle.stop('SIGTERM')
    expect(exited).toEqual([0])
    const waiting = make()
    waiting.start()
    core().exit(1)
    waiting.stop('SIGTERM')
    vi.runAllTimers()
    expect(cores).toHaveLength(1)
    expect(exited).toEqual([0, 0])
    expect(calls).toEqual([])
  })

  it('kills a core that takes too long to stop', () => {
    const supervisor = make()
    supervisor.start()
    supervisor.stop('SIGTERM')
    vi.advanceTimersByTime(options.stopGraceMs)
    expect(core().kills).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('pays no attention to a core it has already replaced', () => {
    make().start()
    const first = core()
    crash()
    first.bind()
    first.exit(1)
    expect(calls).toEqual([])
    expect(cores).toHaveLength(2)
  })

  describe('updates', () => {
    it('restarts at once onto the new bundle and keeps it once it has stayed up, from ready', () => {
      const supervisor = make()
      supervisor.start()
      core().up()
      core().exit(CORE_EXIT_UPDATE)
      expect(lines.at(-1)).toBe(`[harnessd] core exited (code ${CORE_EXIT_UPDATE}) for an update — restarting`)
      vi.advanceTimersByTime(0)
      expect(cores).toHaveLength(2)
      core().bind()
      vi.advanceTimersByTime(options.updateProbationMs)
      expect(calls).toEqual(['claim'])
      core().ready()
      vi.advanceTimersByTime(options.updateProbationMs - 1)
      expect(calls).toEqual(['claim'])
      vi.advanceTimersByTime(1)
      expect(calls).toEqual(['claim', 'confirm'])
      expect(supervisor.status()).toMatchObject({ state: 'running', restarts: 1, lastExitReason: 'update' })
      core().exit(1)
      expect(calls).toEqual(['claim', 'confirm'])
    })

    it('judges a protocol 1 core\'s update from its bind', () => {
      make().start()
      core().up()
      core().exit(CORE_EXIT_UPDATE)
      vi.advanceTimersByTime(0)
      core().bind(1)
      vi.advanceTimersByTime(options.updateProbationMs)
      expect(calls).toEqual(['claim', 'confirm'])
    })

    it.each([
      ['never binds', (c: FakeCore) => c.exit(1)],
      ['crashes while on probation', (c: FakeCore) => { c.up(); vi.advanceTimersByTime(1000); c.exit(null, 'SIGABRT') }],
      ['starts in safe mode', (c: FakeCore) => { c.bind(); c.ready('start-up failed'); expect(c.kills).toEqual(['SIGKILL']); c.exit(null, 'SIGKILL') }],
    ])('rolls the bundle back when the updated core %s', (_, fail) => {
      const supervisor = make()
      supervisor.start()
      core().up()
      core().exit(CORE_EXIT_UPDATE)
      vi.advanceTimersByTime(0)
      fail(core())
      expect(calls).toEqual(['claim', 'restore'])
      vi.advanceTimersByTime(0)
      expect(cores).toHaveLength(3)
      expect(supervisor.status().restarts).toBe(2)
      core().up()
      vi.runOnlyPendingTimers()
      expect(calls).toEqual(['claim', 'restore'])
    })

    it('leaves the update unconfirmed when stopped while on probation', () => {
      const supervisor = make()
      supervisor.start()
      core().exit(CORE_EXIT_UPDATE)
      vi.advanceTimersByTime(0)
      core().up()
      supervisor.stop('SIGTERM')
      core().exit(0)
      vi.runAllTimers()
      expect(calls).toEqual(['claim', 'release'])
    })
  })
})
