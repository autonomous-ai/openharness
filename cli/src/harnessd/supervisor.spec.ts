import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CORE_EXIT_UPDATE, HARNESSD_PROTOCOL, type MasterMessage } from './protocol.js'
import { DEFAULT_SUPERVISOR_OPTIONS, Supervisor, type CoreHandle, type SupervisorOptions } from './supervisor.js'

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
  bind(): void { this.say({ type: 'harnessd:bound', protocol: HARNESSD_PROTOCOL, port: 18473 }) }
  beat(rssBytes = 100 * 1024 * 1024): void { this.say({ type: 'harnessd:heartbeat', rssBytes, heapUsedBytes: rssBytes / 2 }) }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void { for (const listener of this.exitListeners) listener(code, signal) }
}

const options: SupervisorOptions = {
  ...DEFAULT_SUPERVISOR_OPTIONS,
  bindTimeoutMs: 10_000,
  heartbeatTimeoutMs: 6_000,
  stopGraceMs: 2_000,
  initialBackoffMs: 500,
  maxBackoffMs: 4_000,
  backoffResetMs: 20_000,
  rssLimitMiB: 512,
  updateProbationMs: 5_000,
}

describe('Supervisor', () => {
  let cores: FakeCore[]
  let calls: string[]
  let lines: string[]
  let exited: number[]
  let pidOf: (index: number) => number | undefined
  const core = () => cores[cores.length - 1]

  const make = (overrides: Partial<SupervisorOptions> = {}) => new Supervisor({
    spawnCore: (env) => {
      const next = new FakeCore(pidOf(cores.length), env)
      cores.push(next)
      return next
    },
    now: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    claimPidFile: () => calls.push('claim'),
    releasePidFile: () => calls.push('release'),
    restoreUpdate: () => calls.push('restore'),
    confirmUpdate: () => calls.push('confirm'),
    log: (line) => lines.push(line),
    exit: (code) => exited.push(code),
  }, { ...options, ...overrides })

  beforeEach(() => {
    vi.useFakeTimers()
    cores = []
    calls = []
    lines = []
    exited = []
    pidOf = (index) => 1000 + index
  })
  afterEach(() => vi.useRealTimers())

  it('starts one core, claims the pid file once it is bound, and tells it how things stand', () => {
    const supervisor = make()
    expect(new Supervisor({} as never).status()).toMatchObject({ state: 'idle', corePid: null, restarts: 0, lastExit: null })
    supervisor.start()
    supervisor.start()
    expect(cores).toHaveLength(1)
    expect(core().env).toEqual({ HARNESSD_SUPERVISED: '1', HARNESSD_RESTARTS: '0' })
    expect(supervisor.status()).toMatchObject({ state: 'starting', corePid: 1000 })
    expect(calls).toEqual([])
    core().bind()
    expect(calls).toEqual(['claim'])
    expect(supervisor.status()).toEqual({ state: 'running', corePid: 1000, restarts: 0, lastExit: null, protocol: HARNESSD_PROTOCOL })
    expect(core().sent).toEqual([{ type: 'harnessd:status', status: supervisor.status() }])
  })

  it('ignores what is not a core message, and a heartbeat before the bind', () => {
    const supervisor = make()
    supervisor.start()
    core().say(null)
    core().say({ type: 'other' })
    core().beat()
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
    expect(supervisor.status()).toMatchObject({ state: 'restarting', restarts: 1, lastExit: 'signal SIGKILL' })
    vi.advanceTimersByTime(499)
    expect(cores).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(cores).toHaveLength(2)
    expect(core().env).toEqual({ HARNESSD_SUPERVISED: '1', HARNESSD_RESTARTS: '1', HARNESSD_LAST_EXIT: 'signal SIGKILL' })
    expect(lines.at(-1)).toBe('[harnessd] core started (pid ?) · restart 1')
    core().bind()
    expect(lines.at(-1)).toBe(`[harnessd] core bound (pid ?, protocol ${HARNESSD_PROTOCOL})`)
  })

  it('kills a bound core whose heartbeats stop: it is hung', () => {
    make().start()
    core().bind()
    vi.advanceTimersByTime(5_000)
    core().beat()
    vi.advanceTimersByTime(5_999)
    expect(core().kills).toEqual([])
    vi.advanceTimersByTime(1)
    expect(core().kills).toEqual(['SIGKILL'])
  })

  it('backs off crash after crash, up to its cap, and starts over after a good run', () => {
    const supervisor = make()
    supervisor.start()
    const crash = () => { core().exit(1); vi.runOnlyPendingTimers() }
    const delays: number[] = []
    for (let i = 0; i < 5; i++) {
      const before = Date.now()
      core().exit(1)
      const spawned = cores.length
      while (cores.length === spawned) vi.advanceTimersByTime(100)
      delays.push(Date.now() - before)
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 4000])
    core().bind()
    vi.advanceTimersByTime(options.backoffResetMs)
    core().beat()
    const before = Date.now()
    crash()
    expect(Date.now() - before).toBe(500)
    expect(supervisor.status().restarts).toBe(6)
  })

  it('follows a core that ends itself on purpose, and releases the pid file it claimed', () => {
    make().start()
    core().bind()
    core().exit(0)
    expect(exited).toEqual([0])
    expect(calls).toEqual(['claim', 'release'])
  })

  it('restarts a core that outgrows its memory budget at once, by SIGTERM, and SIGKILL if it lingers', () => {
    const supervisor = make()
    supervisor.start()
    core().bind()
    core().beat(511 * 1024 * 1024)
    expect(core().kills).toEqual([])
    core().beat(513 * 1024 * 1024)
    core().beat(900 * 1024 * 1024)
    expect(core().kills).toEqual(['SIGTERM'])
    vi.advanceTimersByTime(options.stopGraceMs)
    expect(core().kills).toEqual(['SIGTERM', 'SIGKILL'])
    core().exit(0)
    expect(exited).toEqual([])
    vi.advanceTimersByTime(options.initialBackoffMs - 1)
    expect(cores).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(cores).toHaveLength(2)
    expect(supervisor.status().lastExit).toBe('code 0')
    // Over budget again at once: it backs off like a crash rather than restarting as fast as it binds.
    core().bind()
    core().beat(900 * 1024 * 1024)
    core().exit(0)
    vi.advanceTimersByTime(options.initialBackoffMs * 2 - 1)
    expect(cores).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(cores).toHaveLength(3)
  })

  it('does not check memory with a budget of 0', () => {
    make({ rssLimitMiB: 0 }).start()
    core().bind()
    core().beat(64 * 1024 * 1024 * 1024)
    expect(core().kills).toEqual([])
  })

  it('stops the core and itself on request, and kills the core on a second request', () => {
    const supervisor = make()
    supervisor.start()
    core().bind()
    supervisor.stop('SIGTERM')
    expect(core().kills).toEqual(['SIGTERM'])
    expect(supervisor.status().state).toBe('stopping')
    supervisor.stop('SIGTERM')
    expect(core().kills).toEqual(['SIGTERM', 'SIGKILL'])
    core().bind()
    expect(supervisor.status().state).toBe('stopping')
    core().exit(null, 'SIGKILL')
    expect(exited).toEqual([0])
    expect(calls).toEqual(['claim', 'release'])
    supervisor.stop('again')
    expect(exited).toEqual([0])
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
    first.exit(1)
    vi.runOnlyPendingTimers()
    first.bind()
    first.exit(1)
    expect(calls).toEqual([])
    expect(cores).toHaveLength(2)
  })

  describe('updates', () => {
    it('restarts at once onto the new bundle and keeps it once it has stayed up', () => {
      const supervisor = make()
      supervisor.start()
      core().bind()
      core().exit(CORE_EXIT_UPDATE)
      vi.advanceTimersByTime(0)
      expect(cores).toHaveLength(2)
      core().bind()
      vi.advanceTimersByTime(options.updateProbationMs - 1)
      expect(calls).toEqual(['claim'])
      vi.advanceTimersByTime(1)
      expect(calls).toEqual(['claim', 'confirm'])
      expect(supervisor.status()).toMatchObject({ state: 'running', restarts: 1 })
      core().exit(1)
      expect(calls).toEqual(['claim', 'confirm'])
    })

    it.each([
      ['never binds', (c: FakeCore) => c.exit(1)],
      ['crashes while on probation', (c: FakeCore) => { c.bind(); vi.advanceTimersByTime(1000); c.exit(null, 'SIGABRT') }],
    ])('rolls the bundle back when the updated core %s', (_, fail) => {
      const supervisor = make()
      supervisor.start()
      core().bind()
      core().exit(CORE_EXIT_UPDATE)
      vi.advanceTimersByTime(0)
      fail(core())
      expect(calls).toEqual(['claim', 'restore'])
      vi.advanceTimersByTime(0)
      expect(cores).toHaveLength(3)
      expect(supervisor.status().restarts).toBe(2)
      core().bind()
      vi.runOnlyPendingTimers()
      expect(calls).toEqual(['claim', 'restore'])
    })

    it('leaves the update unconfirmed when stopped while on probation', () => {
      const supervisor = make()
      supervisor.start()
      core().exit(CORE_EXIT_UPDATE)
      vi.advanceTimersByTime(0)
      core().bind()
      supervisor.stop('SIGTERM')
      core().exit(0)
      vi.runAllTimers()
      expect(calls).toEqual(['claim', 'release'])
    })
  })
})
