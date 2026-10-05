import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SERVICE_OPTIONS, ServiceSupervisor, serviceOptions, serviceSpecs, type ServiceSpec, type ServiceSupervisorOptions } from './services.js'
import type { CoreHandle } from './supervisor.js'

const MIB = 1024 * 1024

class FakeService implements CoreHandle {
  readonly kills: NodeJS.Signals[] = []
  private messageListeners: Array<(message: unknown) => void> = []
  private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  constructor(readonly pid: number | undefined, readonly spec: ServiceSpec, readonly env: Record<string, string>) {}
  send(): void {}
  kill(signal: NodeJS.Signals): void { this.kills.push(signal) }
  onMessage(listener: (message: unknown) => void): void { this.messageListeners.push(listener) }
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void { this.exitListeners.push(listener) }
  say(message: unknown): void { for (const listener of this.messageListeners) listener(message) }
  beat(rssBytes = 100 * MIB, heapUsedBytes = rssBytes / 2): void { this.say({ type: 'harnessd:heartbeat', rssBytes, heapUsedBytes, loopDelayMs: 2 }) }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void { for (const listener of this.exitListeners) listener(code, signal) }
}

const options: ServiceSupervisorOptions = {
  ...DEFAULT_SERVICE_OPTIONS,
  heartbeatTimeoutMs: 6_000,
  stopGraceMs: 1_000,
  initialBackoffMs: 1_000,
  maxBackoffMs: 4_000,
  backoffResetMs: 20_000,
  heapRestartPercent: 75,
  parkCrashes: 3,
  parkWindowMs: 60_000,
  parkRetryMs: 120_000,
}
const search: ServiceSpec = { name: 'search', heapLimitMiB: 512, rssLimitMiB: 1_024 }
const devices: ServiceSpec = { name: 'devices', heapLimitMiB: 256, rssLimitMiB: 0 }

describe('ServiceSupervisor', () => {
  let children: FakeService[]
  let lines: string[]
  const latest = (name = 'search') => children.filter((child) => child.spec.name === name).at(-1)!
  const make = (specs: ServiceSpec[] = [search], overrides: Partial<ServiceSupervisorOptions> = {}, env: Record<string, string> = {}) =>
    new ServiceSupervisor(specs, {
      spawnService: (spec, extra) => {
        const child = new FakeService(2000 + children.length, spec, extra)
        children.push(child)
        return child
      },
      now: () => performance.now(),
      wallClock: () => Date.now(),
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      log: (line) => lines.push(line),
    }, { ...options, ...overrides }, env)

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    children = []
    lines = []
  })
  afterEach(() => vi.useRealTimers())

  it('starts every service with its name, its token and its watchdog, and none waits on another', () => {
    const supervisor = make([search, devices], {}, { HARNESSD_SERVICE_TOKEN: 'secret' })
    supervisor.start()
    expect(children.map((child) => child.spec.name)).toEqual(['search', 'devices'])
    expect(latest().env).toEqual({ HARNESSD_SERVICE_TOKEN: 'secret', HARNESSD_SERVICE: 'search', HARNESSD_RESTARTS: '0', HARNESSD_WATCHDOG_MS: '6000' })
    expect(supervisor.status().map((status) => status.state)).toEqual(['starting', 'starting'])
    latest().beat()
    expect(supervisor.status()[0]).toMatchObject({ name: 'search', state: 'running', pid: 2000, restarts: 0, lastExit: null })
    // Anything that is not a heartbeat is ignored.
    latest().say({ type: 'harnessd:bound', protocol: 2, port: 1 })
    latest().say('noise')
    expect(supervisor.status()[0].state).toBe('running')
  })

  it('restarts a crashed service with a backoff that doubles, caps, and is forgiven after a long run', () => {
    const supervisor = make([search], { parkCrashes: 99 })
    supervisor.start()
    latest().beat()
    latest().exit(1)
    expect(supervisor.status()[0]).toMatchObject({ state: 'restarting', restarts: 1, lastExit: 'code 1', lastExitReason: 'crashed', pid: null })
    vi.advanceTimersByTime(999)
    expect(children).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(children).toHaveLength(2)
    expect(latest().env.HARNESSD_RESTARTS).toBe('1')
    expect(supervisor.status()[0].state).toBe('restarting')
    latest().beat()
    expect(supervisor.status()[0].state).toBe('running')
    for (const delay of [2_000, 4_000, 4_000]) {
      latest().exit(null, 'SIGSEGV')
      vi.advanceTimersByTime(delay - 1)
      const before = children.length
      vi.advanceTimersByTime(1)
      expect(children.length).toBe(before + 1)
    }
    expect(lines.some((line) => line.includes('exited (signal SIGSEGV, crashed) — restarting in 4000 ms'))).toBe(true)
    // Up long enough: the next crash restarts after the initial delay again.
    for (let left = 21_000; left > 0; left -= 1_000) { vi.advanceTimersByTime(1_000); latest().beat() }
    latest().exit(1)
    const before = children.length
    vi.advanceTimersByTime(1_000)
    expect(children.length).toBe(before + 1)
  })

  it('kills a service that stops beating, from its start too, and restarts it as hung', () => {
    const supervisor = make()
    supervisor.start()
    // Never beat at all: hung from the start.
    vi.advanceTimersByTime(6_000)
    expect(latest().kills).toEqual(['SIGKILL'])
    latest().exit(null, 'SIGKILL')
    expect(supervisor.status()[0]).toMatchObject({ lastExitReason: 'hung', state: 'restarting' })
    vi.advanceTimersByTime(1_000)
    const second = latest()
    for (let i = 0; i < 3; i++) { vi.advanceTimersByTime(5_000); second.beat() }
    expect(second.kills).toEqual([])
    vi.advanceTimersByTime(6_000)
    expect(second.kills).toEqual(['SIGKILL'])
    expect(lines.some((line) => line.includes('sent no heartbeat for 6000 ms — it is hung'))).toBe(true)
  })

  it('restarts a service that outgrows its heap share or its resident budget, and counts it like a crash', () => {
    const supervisor = make([search, devices], { parkCrashes: 99 })
    supervisor.start()
    latest('search').beat(200 * MIB, 380 * MIB)
    expect(latest('search').kills).toEqual([])
    latest('search').beat(200 * MIB, 390 * MIB)
    expect(latest('search').kills).toEqual(['SIGTERM'])
    // While it is going, more beats do not ask again.
    latest('search').beat(200 * MIB, 500 * MIB)
    expect(latest('search').kills).toEqual(['SIGTERM'])
    latest('search').exit(0)
    expect(supervisor.status()[0]).toMatchObject({ lastExitReason: 'memory', restarts: 1 })
    vi.advanceTimersByTime(1_000)
    latest('search').beat(1_100 * MIB, 10 * MIB)
    expect(latest('search').kills).toEqual(['SIGTERM'])
    expect(lines.some((line) => line.includes('over its 1024 MiB budget'))).toBe(true)
    // No resident budget: only the heap share counts.
    latest('devices').beat(9_000 * MIB, 10 * MIB)
    expect(latest('devices').kills).toEqual([])
    expect(lines.some((line) => line.includes('past 75% of its 512 MiB limit'))).toBe(true)
  })

  it('SIGKILLs a service that outlives its grace to stop for memory', () => {
    make().start()
    latest().beat(100 * MIB, 500 * MIB)
    expect(latest().kills).toEqual(['SIGTERM'])
    vi.advanceTimersByTime(1_000)
    expect(latest().kills).toEqual(['SIGTERM', 'SIGKILL'])
    expect(lines.some((line) => line.includes('outlived its 1000 ms to stop'))).toBe(true)
  })

  it('parks a service that keeps crashing, says so, and tries it again later', () => {
    const supervisor = make()
    supervisor.start()
    for (let crash = 1; crash <= 2; crash++) {
      latest().exit(1)
      vi.advanceTimersByTime(4_000)
    }
    latest().exit(1)
    expect(supervisor.status()[0]).toMatchObject({ state: 'parked', restarts: 3 })
    expect(lines.some((line) => line.includes('ended 3 times in 1 min (code 1, crashed) — parked; trying again in 2 min'))).toBe(true)
    const parked = children.length
    vi.advanceTimersByTime(119_999)
    expect(children.length).toBe(parked)
    vi.advanceTimersByTime(1)
    expect(children.length).toBe(parked + 1)
    // A fresh start: its next crash is one, not the fourth.
    latest().exit(1)
    expect(supervisor.status()[0].state).toBe('restarting')
  })

  it('crashes far apart never park a service', () => {
    const supervisor = make()
    supervisor.start()
    for (let crash = 0; crash < 5; crash++) {
      latest().exit(1)
      vi.advanceTimersByTime(61_000)
    }
    expect(supervisor.status()[0].state).not.toBe('parked')
  })

  it('stops every service, SIGKILLing one that outlives its grace, and says when all are gone', () => {
    const supervisor = make([search, devices])
    supervisor.start()
    const done = vi.fn()
    supervisor.stop(done)
    expect(supervisor.status().map((status) => status.state)).toEqual(['stopping', 'stopping'])
    expect(latest('search').kills).toEqual(['SIGTERM'])
    latest('search').exit(0)
    expect(done).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(latest('devices').kills).toEqual(['SIGTERM', 'SIGKILL'])
    latest('devices').exit(null, 'SIGKILL')
    expect(done).toHaveBeenCalledOnce()
    expect(supervisor.status()).toEqual([
      expect.objectContaining({ name: 'search', state: 'stopped', lastExitReason: 'stopped', lastExit: 'code 0' }),
      expect.objectContaining({ name: 'devices', state: 'stopped', lastExitReason: 'stopped', lastExit: 'signal SIGKILL' }),
    ])
    // Stopping again, or a late exit from a process already let go, changes nothing.
    const again = vi.fn()
    supervisor.stop(again)
    expect(again).toHaveBeenCalledOnce()
  })

  it('a second stop while stopping waits for the same end, and sends no second signal', () => {
    const supervisor = make()
    supervisor.start()
    const first = vi.fn()
    const second = vi.fn()
    supervisor.stop(first)
    supervisor.stop(second)
    expect(latest().kills).toEqual(['SIGTERM'])
    latest().exit(0)
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  it('stops a service waiting to restart, or parked, without starting it', () => {
    const supervisor = make([search, devices])
    supervisor.start()
    latest('search').beat()
    for (let crash = 0; crash < 3; crash++) { latest('devices').exit(1); vi.advanceTimersByTime(4_000); latest('search').beat() }
    latest('search').exit(1)
    expect(supervisor.status().map((status) => status.state)).toEqual(['restarting', 'parked'])
    const started = children.length
    const done = vi.fn()
    supervisor.stop(done)
    expect(done).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(300_000)
    expect(children.length).toBe(started)
    expect(supervisor.status().map((status) => status.state)).toEqual(['stopped', 'stopped'])
  })

  it('with no services, starting does nothing and stopping is done at once', () => {
    const supervisor = make([])
    supervisor.start()
    const done = vi.fn()
    supervisor.stop(done)
    expect(done).toHaveBeenCalledOnce()
    expect(supervisor.status()).toEqual([])
  })

  it('names a process with no pid, and ignores what a process it let go of says', () => {
    const supervisor = new ServiceSupervisor([search], {
      spawnService: (spec, env) => { const child = new FakeService(undefined, spec, env); children.push(child); return child },
      now: () => performance.now(),
      wallClock: () => Date.now(),
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      log: (line) => lines.push(line),
    }, options)
    supervisor.start()
    expect(lines[0]).toContain('started (pid ?)')
    const first = latest()
    first.exit(1)
    vi.advanceTimersByTime(1_000)
    first.beat(9_000 * MIB, 9_000 * MIB)
    first.exit(1)
    expect(latest().kills).toEqual([])
    expect(supervisor.status()[0].restarts).toBe(1)
  })

  it('reads its timings from the environment, keeping the defaults for what is unset or invalid', () => {
    expect(serviceOptions({})).toEqual(DEFAULT_SERVICE_OPTIONS)
    expect(serviceOptions({
      HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '2000', HARNESSD_SERVICE_STOP_GRACE_MS: '50', HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '10',
      HARNESSD_SERVICE_MAX_BACKOFF_MS: '20', HARNESSD_SERVICE_BACKOFF_RESET_MS: '30', HARNESSD_SERVICE_HEAP_RESTART_PERCENT: '150',
      HARNESSD_SERVICE_PARK_CRASHES: '2', HARNESSD_SERVICE_PARK_WINDOW_MS: '40', HARNESSD_SERVICE_PARK_RETRY_MS: '60',
    })).toEqual({ heartbeatTimeoutMs: 2_000, stopGraceMs: 50, initialBackoffMs: 10, maxBackoffMs: 20, backoffResetMs: 30, heapRestartPercent: 100, parkCrashes: 2, parkWindowMs: 40, parkRetryMs: 60 })
    // A heartbeat patience under a second, or a value that is not a number, keeps the default.
    expect(serviceOptions({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '10', HARNESSD_SERVICE_PARK_CRASHES: 'many' }))
      .toEqual(DEFAULT_SERVICE_OPTIONS)
  })

  it('reads the services to run from the environment, keeping only known ones, once each', () => {
    const known = { search: { heapLimitMiB: 512, rssLimitMiB: 1_024 }, devices: { heapLimitMiB: 256, rssLimitMiB: 0 } }
    expect(serviceSpecs({ HARNESSD_SERVICES: ' search, nope ,devices,search,' }, known)).toEqual([search, devices])
    expect(serviceSpecs({}, known)).toEqual([])
    expect(serviceSpecs({ HARNESSD_SERVICES: 'toString,constructor' }, known)).toEqual([])
    // One heap limit for every service, when given as a whole number of MiB.
    expect(serviceSpecs({ HARNESSD_SERVICES: 'search', HARNESSD_SERVICE_HEAP_LIMIT_MIB: '96' }, known)).toEqual([{ ...search, heapLimitMiB: 96 }])
    expect(serviceSpecs({ HARNESSD_SERVICES: 'search', HARNESSD_SERVICE_HEAP_LIMIT_MIB: 'lots' }, known)).toEqual([search])
  })
})
