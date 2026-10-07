import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CORE_EXIT_STOP, CORE_EXIT_UPDATE, HARNESSD_PROTOCOL, type MasterMessage } from './protocol.js'
import {
  DEFAULT_SUPERVISOR_OPTIONS, HAND_OVER_GRACE_MS, Supervisor, namesTheDisk, type CoreHandle, type ReexecOutcome, type ResumeState, type SupervisorDeps, type SupervisorOptions,
  type SupervisorStatus,
} from './supervisor.js'

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

  const make = (overrides: Partial<SupervisorOptions> = {}, more: Partial<SupervisorDeps> = {}, identity: ConstructorParameters<typeof Supervisor>[2] = {}) => new Supervisor({
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
    ...more,
  }, { ...options, ...overrides }, identity)

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
      .toEqual({ state: 'idle', corePid: null, restarts: 0, lastExit: null, lastExitReason: null, safeMode: null, protocol: HARNESSD_PROTOCOL, since: 7, masterVersion: null, reexecs: 0 })
    supervisor.start()
    supervisor.start()
    expect(cores).toHaveLength(1)
    expect(core().env).toEqual({ HARNESSD_SUPERVISED: '1', HARNESSD_RESTARTS: '0', HARNESSD_WATCHDOG_MS: '6000', HARNESSD_JUDGES_SUPERSEDED: '1', HARNESSD_UPDATES: 'master' })
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
      protocol: HARNESSD_PROTOCOL, since: Date.now(), masterVersion: null, reexecs: 0,
    })
    expect(lines.at(-1)).toBe('[harnessd] core ready (pid 1000)')
    // Every change is written for `harness status`, and told to the bound core.
    expect(statuses.map((status) => status.state)).toEqual(['starting', 'listening', 'running'])
    expect(core().sent.map((message) => message.type === 'harnessd:status' ? message.status.state : message.type)).toEqual(['listening', 'running'])
    core().ready()
    expect(statuses).toHaveLength(3)
  })

  it('starts the process a bound core asks for, and those a core too old to ask for them never would', () => {
    const wanted: string[] = []
    const unasked: number[] = []
    make({}, { want: (service) => wanted.push(service), unasked: (protocol) => unasked.push(protocol) }).start()
    core().say({ type: 'harnessd:want', service: 'orchestrator' })
    expect(wanted).toEqual([])
    core().bind()
    core().say({ type: 'harnessd:want', service: 'orchestrator' })
    expect(wanted).toEqual(['orchestrator'])
    expect(unasked).toEqual([])
    crash()
    core().bind(2)
    crash()
    core().bind(3)
    expect(unasked).toEqual([2, 3])
    // A master with no services to start ignores both.
    make().start()
    core().bind(2)
    core().say({ type: 'harnessd:want', service: 'orchestrator' })
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
    expect(core().env).toEqual({ HARNESSD_SUPERVISED: '1', HARNESSD_RESTARTS: '1', HARNESSD_WATCHDOG_MS: '6000', HARNESSD_JUDGES_SUPERSEDED: '1', HARNESSD_UPDATES: 'master', HARNESSD_LAST_EXIT: 'signal SIGKILL' })
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

  it('kills a bound core whose heartbeats stop, one beat\'s time after its silence runs out: it is hung', () => {
    const supervisor = make()
    supervisor.start()
    core().up()
    vi.advanceTimersByTime(5_000)
    core().beat()
    vi.advanceTimersByTime(6_000)
    expect(lines.at(-1)).toBe('[harnessd] core sent no heartbeat for 6000 ms — giving it 2000 ms more, in case this master was paused too')
    vi.advanceTimersByTime(1_999)
    expect(core().kills).toEqual([])
    vi.advanceTimersByTime(1)
    expect(core().kills).toEqual(['SIGKILL'])
    expect(lines.at(-1)).toBe('[harnessd] core sent no heartbeat for 8000 ms — it is hung; — killing it')
    core().exit(null, 'SIGKILL')
    expect(supervisor.status().lastExitReason).toBe('hung')
  })

  it('takes no silence it was paused through for a hang: the beat a resumed core sends keeps it', () => {
    // Master and core paused together read, on resume, as the silence running out at once and the
    // core's overdue beat arriving a moment later (e2e/paused.e2e.ts).
    const supervisor = make()
    supervisor.start()
    core().up()
    vi.advanceTimersByTime(6_000)
    expect(lines.at(-1)).toContain('giving it 2000 ms more')
    vi.advanceTimersByTime(10)
    core().beat()
    live(30_000)
    expect(core().kills).toEqual([])
    expect(supervisor.status()).toMatchObject({ state: 'running', restarts: 0 })
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

  describe('an update the updater staged', () => {
    it('asks the running core to hand over, once, and judges its exit as the update\'s', () => {
      const supervisor = make()
      supervisor.start()
      core().up()
      supervisor.updateStaged('9.9.9')
      supervisor.updateStaged('9.9.9')
      expect(core().sent.filter((message) => message.type === 'harnessd:update')).toEqual([{ type: 'harnessd:update', version: '9.9.9' }])
      expect(lines.at(-1)).toBe('[harnessd] the updater staged 9.9.9 — asking the core to hand over')
      core().exit(CORE_EXIT_UPDATE)
      vi.advanceTimersByTime(0)
      expect(cores).toHaveLength(2)
      expect(lines).toContain('[harnessd] core exited (code 75) for an update — restarting')
      core().up()
      // The grace it had to hand over in ended with it.
      live(HAND_OVER_GRACE_MS)
      expect(core().kills).toEqual([])
      expect(calls).toContain('confirm')
    })

    it('stops a core that does not hand over within its grace, and counts that exit as the update\'s', () => {
      const supervisor = make()
      supervisor.start()
      core().up()
      supervisor.updateStaged('9.9.9')
      live(HAND_OVER_GRACE_MS - 1_000)
      expect(core().kills).toEqual([])
      live(1_000)
      expect(core().kills).toEqual(['SIGTERM'])
      expect(lines).toContain('[harnessd] core did not hand over for 9.9.9 within 45000 ms — stopping it')
      core().exit(0)
      vi.advanceTimersByTime(0)
      expect(supervisor.status()).toMatchObject({ lastExitReason: 'update', restarts: 1 })
      expect(cores).toHaveLength(2)
      core().up()
      live(options.updateProbationMs)
      expect(calls).toContain('confirm')
    })

    it('with no core running, starts the next one on the new bundle at once, on probation, with a clean slate', () => {
      const supervisor = make()
      supervisor.start()
      // Into safe mode: the crashes a fix would end.
      for (let i = 0; i < options.crashLoopCrashes; i++) { core().up(); crash() }
      expect(core().env.HARNESSD_SAFE_MODE).toBe('crash-loop')
      core().exit(1)
      expect(supervisor.status().state).toBe('restarting')
      supervisor.updateStaged('9.9.9')
      expect(lines.at(-1)).toBe('[harnessd] the updater staged 9.9.9 — the next core starts on it')
      vi.advanceTimersByTime(0)
      expect(core().env.HARNESSD_SAFE_MODE).toBeUndefined()
      core().up()
      core().exit(1)
      vi.advanceTimersByTime(0)
      // On probation: its crash rolls the update back.
      expect(calls).toContain('restore')
    })

    it('judges the first core when a build is staged before the master starts one', () => {
      const supervisor = make()
      supervisor.updateStaged('9.9.9')
      expect(cores).toHaveLength(0)
      supervisor.start()
      core().up()
      core().exit(1)
      expect(calls).toContain('restore')
    })

    it('leaves a core being started to start on the bundle on disk, and ignores a staging while stopping', () => {
      const deciding: Array<(outcome: ReexecOutcome) => void> = []
      const supervisor = make({}, { reexec: (_state, proceed) => { deciding.push(proceed) } })
      supervisor.start()
      expect(cores).toHaveLength(0)
      supervisor.updateStaged('9.9.9')
      expect(cores).toHaveLength(0)
      deciding[0]('kept')
      expect(cores).toHaveLength(1)
      core().up()
      core().exit(1)
      vi.advanceTimersByTime(0)
      expect(calls).toContain('restore')
      supervisor.stop('stopping')
      const before = lines.length
      supervisor.updateStaged('9.9.10')
      expect(lines.length).toBe(before)
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

    it('takes a core on the new bundle that has no room on the disk to start for no verdict: the update stays on trial, tried again, backing off', () => {
      const supervisor = make()
      supervisor.start()
      core().up()
      core().exit(CORE_EXIT_UPDATE)
      vi.advanceTimersByTime(0)
      // Its socket's claim could not be written: the disk is full, and the build before would fail too.
      core().bind()
      core().ready('listen ENOSPC: no space left on device /data/.claim-1')
      expect(core().kills).toEqual(['SIGKILL'])
      expect(lines.at(-1)).toBe('[harnessd] core could not start on the new bundle for want of room on the disk (listen ENOSPC: no space left on device /data/.claim-1) — not a verdict on the build — killing it')
      core().exit(null, 'SIGKILL')
      expect(calls).toEqual(['claim'])
      expect(lines.at(-1)).toBe(`[harnessd] the updated core had no room to start (signal SIGKILL) — keeping the update on trial; trying again in ${options.initialBackoffMs} ms`)
      expect(supervisor.status()).toMatchObject({ state: 'restarting', lastExitReason: 'not-ready', safeMode: null })
      vi.advanceTimersByTime(options.initialBackoffMs - 1)
      expect(cores).toHaveLength(2)
      vi.advanceTimersByTime(1)
      expect(cores).toHaveLength(3)
      // Not a crash: no safe mode for the next, however many times the disk is still full.
      expect(core().env.HARNESSD_SAFE_MODE).toBeUndefined()
      core().bind()
      core().ready('EDQUOT: disk quota exceeded, write')
      core().exit(null, 'SIGKILL')
      expect(lines.at(-1)).toContain(`trying again in ${options.initialBackoffMs * 2} ms`)
      vi.advanceTimersByTime(options.initialBackoffMs * 2)
      core().bind()
      core().ready('EROFS: read-only file system, open')
      core().exit(null, 'SIGKILL')
      vi.advanceTimersByTime(options.initialBackoffMs * 4)
      expect(cores).toHaveLength(5)
      expect(core().env.HARNESSD_SAFE_MODE).toBeUndefined()
      // Room again: it comes up, and is judged on the update from ready, as any update is.
      core().up()
      vi.advanceTimersByTime(options.updateProbationMs)
      expect(calls).toEqual(['claim', 'confirm'])
    })

    it('still rolls back an update whose core fails on the disk once it was up, or for any other reason', () => {
      const supervisor = make()
      supervisor.start()
      core().up()
      core().exit(CORE_EXIT_UPDATE)
      vi.advanceTimersByTime(0)
      core().up()
      // Up and on probation, then gone: whatever it says, the build did not stay up.
      core().exit(1)
      expect(calls).toEqual(['claim', 'restore'])
      expect(supervisor.status().state).toBe('restarting')
    })

    it('knows a failure that names the disk from one that names the build', () => {
      for (const disk of ['listen ENOSPC: no space left on device /d/.claim-1', 'ENOSPC: no space left on device, write', 'EDQUOT: disk quota exceeded', 'EROFS: read-only file system, mkdir \'/d\'']) {
        expect(namesTheDisk(disk), disk).toBe(true)
      }
      for (const build of ['start-up failed', 'Cannot find module \'./x.js\'', 'SyntaxError: Unexpected token', 'listen EADDRINUSE: address already in use', 'spaces left over']) {
        expect(namesTheDisk(build), build).toBe(false)
      }
    })

    it('judges the newer build a core on probation staged, instead of rolling it back as a failure', () => {
      let disk = 'v1'
      const supervisor = make({}, { bundle: () => disk })
      supervisor.start()
      core().up()
      disk = 'v2'
      core().exit(CORE_EXIT_UPDATE)
      vi.advanceTimersByTime(0)
      core().up()
      vi.advanceTimersByTime(options.updateProbationMs - 1)
      // v2, on probation, finds v3 and stages it.
      disk = 'v3'
      core().exit(CORE_EXIT_UPDATE)
      expect(calls).toEqual(['claim'])
      expect(lines.at(-1)).toBe(`[harnessd] the updated core staged a newer build before it was kept (code ${CORE_EXIT_UPDATE}) — restarting onto that one`)
      vi.advanceTimersByTime(0)
      expect(cores).toHaveLength(3)
      core().up()
      vi.advanceTimersByTime(options.updateProbationMs)
      expect(calls).toEqual(['claim', 'confirm'])
      expect(supervisor.status()).toMatchObject({ state: 'running', restarts: 2, lastExitReason: 'update' })
    })

    it('does not keep an update whose core has staged a newer build while it tears down for it', () => {
      // The probation ends in the seconds between v2's core staging v3 and its exit for it. Kept then,
      // v3's pending note and the backup to roll it back to went with v2's, and v3 had nothing to restore.
      let disk = 'v1'
      const supervisor = make({}, { bundle: () => disk })
      supervisor.start()
      core().up()
      disk = 'v2'
      core().exit(CORE_EXIT_UPDATE)
      vi.advanceTimersByTime(0)
      core().up()
      vi.advanceTimersByTime(options.updateProbationMs - 1)
      disk = 'v3'
      vi.advanceTimersByTime(1)
      expect(calls).toEqual(['claim'])
      expect(lines.at(-1)).toBe('[harnessd] the update stayed up, but has staged a newer build — leaving that one to be judged')
      core().exit(CORE_EXIT_UPDATE)
      vi.advanceTimersByTime(0)
      // v3 on probation of its own: a failure rolls it back, as any update's.
      core().up()
      core().exit(1)
      expect(calls).toEqual(['claim', 'restore'])
      expect(supervisor.status().state).toBe('restarting')
    })

    it('judges the newer build a core still starting on an update staged, and rolls that one back if it fails', () => {
      let disk = 'v1'
      make({}, { bundle: () => disk }).start()
      core().up()
      disk = 'v2'
      core().exit(CORE_EXIT_UPDATE)
      vi.advanceTimersByTime(0)
      core().bind()
      disk = 'v3'
      core().exit(CORE_EXIT_UPDATE)
      expect(calls).toEqual(['claim'])
      vi.advanceTimersByTime(0)
      core().exit(1)
      expect(calls).toEqual(['claim', 'restore'])
    })

    it('rolls back an update whose core exits for an update without a newer bundle on disk, or one it cannot read', () => {
      for (const after of ['v2', null]) {
        calls = []
        let disk: string | null = 'v1'
        make({}, { bundle: () => disk }).start()
        core().up()
        disk = 'v2'
        core().exit(CORE_EXIT_UPDATE)
        vi.advanceTimersByTime(0)
        core().up()
        disk = after
        core().exit(CORE_EXIT_UPDATE)
        expect(calls, String(after)).toEqual(['claim', 'restore'])
      }
    })

    it('judges, from its first core, an update it starts on that no master kept or rolled back', () => {
      make({}, {}, { unjudgedUpdate: '9.9.9' }).start()
      core().up()
      vi.advanceTimersByTime(options.updateProbationMs - 1)
      expect(calls).toEqual(['claim'])
      vi.advanceTimersByTime(1)
      expect(calls).toEqual(['claim', 'confirm'])

      calls = []
      make({}, {}, { unjudgedUpdate: '9.9.9' }).start()
      core().exit(3)
      expect(calls).toEqual(['restore'])

      // A master handed its state by the one it replaced carries that one's judgement instead.
      calls = []
      make({}, {}, { unjudgedUpdate: '9.9.9', resume: { restarts: 0, lastExit: null, lastExitReason: null, update: null, claimed: true, reexecs: 1, unproven: 1 } }).start()
      core().up()
      vi.advanceTimersByTime(options.updateProbationMs)
      expect(calls).toEqual([])
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

  describe('re-executing on the bundle on disk', () => {
    /** A `reexec` that records what it was asked, and answers when the test says. */
    const reexecs = () => {
      const asked: Array<{ state: ResumeState; proceed: (outcome: ReexecOutcome) => void }> = []
      return { asked, deps: { reexec: (state: ResumeState, proceed: (outcome: ReexecOutcome) => void) => { asked.push({ state, proceed }) }, coreUp: () => calls.push('up') } }
    }

    it('asks before every core it starts, and starts it when the master stays as it is', () => {
      const { asked, deps } = reexecs()
      const supervisor = make({}, deps)
      supervisor.start()
      expect(cores).toHaveLength(0)
      expect(asked[0].state).toEqual({ restarts: 0, lastExit: null, lastExitReason: null, update: null, claimed: false, reexecs: 0, unproven: 0 })
      asked[0].proceed('same')
      expect(cores).toHaveLength(1)
      core().up()
      expect(calls).toEqual(['claim', 'up'])
      crash()
      expect(asked).toHaveLength(2)
      asked[1].proceed('kept')
      expect(cores).toHaveLength(2)
      expect(supervisor.status().state).toBe('restarting')
    })

    it('hands an update on probation, and the pid file, to the master it becomes; and starts no core itself', () => {
      const { asked, deps } = reexecs()
      const supervisor = make({}, deps)
      supervisor.start()
      asked[0].proceed('same')
      core().up()
      core().exit(CORE_EXIT_UPDATE)
      vi.advanceTimersByTime(0)
      expect(asked[1].state).toEqual({ restarts: 1, lastExit: `code ${CORE_EXIT_UPDATE}`, lastExitReason: 'update', update: 'pending', claimed: true, reexecs: 0, unproven: 0 })
      // The process is replaced from here: nothing more of this master runs.
      expect(cores).toHaveLength(1)
      expect(supervisor.status()).toMatchObject({ state: 'restarting', corePid: null })
    })

    it('rolls an update back when the new bundle\'s master would not start, and starts the core on the bundle restored', () => {
      const { asked, deps } = reexecs()
      const supervisor = make({}, deps)
      supervisor.start()
      asked[0].proceed('same')
      core().up()
      core().exit(CORE_EXIT_UPDATE)
      vi.advanceTimersByTime(0)
      asked[1].proceed('refused')
      expect(calls).toEqual(['claim', 'up', 'restore'])
      expect(lines.at(-1)).toBe('[harnessd] the new bundle\'s master would not start — rolled back to the previous bundle; restarting')
      expect(asked[2].state.update).toBeNull()
      asked[2].proceed('same')
      core().up()
      vi.runOnlyPendingTimers()
      expect(calls).toEqual(['claim', 'up', 'restore', 'up'])
      // A bundle replaced by hand has no update to fail: its core starts under this master all the same.
      crash()
      asked[3].proceed('refused')
      expect(cores).toHaveLength(3)
    })

    it('rolls a failed update back and asks again, so the master moves back to the bundle restored', () => {
      const { asked, deps } = reexecs()
      const supervisor = make({}, deps)
      supervisor.start()
      asked[0].proceed('same')
      core().up()
      core().exit(CORE_EXIT_UPDATE)
      vi.advanceTimersByTime(0)
      asked[1].proceed('same')
      core().exit(3)
      expect(calls).toEqual(['claim', 'up', 'restore'])
      vi.advanceTimersByTime(0)
      expect(asked[2].state).toMatchObject({ update: null, restarts: 2, lastExit: 'code 3', lastExitReason: 'crashed' })
      expect(supervisor.status().restarts).toBe(2)
    })

    it('starts nothing when it was stopped while deciding', () => {
      const { asked, deps } = reexecs()
      const supervisor = make({}, deps)
      supervisor.start()
      supervisor.stop('SIGTERM')
      expect(exited).toEqual([0])
      asked[0].proceed('same')
      asked[0].proceed('refused')
      expect(cores).toHaveLength(0)
    })

    it('carries on as the master it was, once re-executed: its counts, its claim, its update on probation', () => {
      const { asked, deps } = reexecs()
      const resume: ResumeState = { restarts: 4, lastExit: 'code 75', lastExitReason: 'update', update: 'pending', claimed: true, reexecs: 2, unproven: 1 }
      const supervisor = make({}, deps, { version: '9.9.9', resume })
      expect(supervisor.status()).toMatchObject({ restarts: 4, lastExit: 'code 75', lastExitReason: 'update', masterVersion: '9.9.9', reexecs: 2 })
      supervisor.start()
      asked[0].proceed('same')
      expect(core().env.HARNESSD_RESTARTS).toBe('4')
      core().up()
      // Its pid file was claimed by the master it was: the same process.
      expect(calls).toEqual(['up'])
      vi.advanceTimersByTime(options.updateProbationMs)
      expect(calls).toEqual(['up', 'confirm'])
      crash()
      // A core came up: the re-executions so far are proven, and no longer count towards a loop.
      expect(asked[1].state).toMatchObject({ reexecs: 2, unproven: 0 })
    })

    it('counts a protocol 1 core as up once it is bound', () => {
      const { asked, deps } = reexecs()
      make({}, deps).start()
      asked[0].proceed('same')
      core().bind(1)
      expect(calls).toEqual(['claim', 'up'])
    })
  })
})
