import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SERVICE_OPTIONS, ENGINE_LIVE_ENV, ENGINE_RUNTIME_ENV, ENGINE_SCREEN_ENV, ENGINE_MODEL_CONTROL_ENV, masterRunsEngineModelControl, ENGINE_QUESTION_CONTROL_ENV, masterRunsEngineQuestionControl, KNOWN_SERVICES, SERVICE_HOSTS, SERVICE_PROCESSES_ENV, ServiceSupervisor, UPDATER_HOST, masterRunsLiveEngines, masterRunsEngineRuntime, masterRunsEngineScreen, serviceOptions, serviceProcessesEnv, serviceSpecs, servicesTheMasterRuns,
  type ServiceSpec, type ServiceSupervisorOptions,
} from './services.js'
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
const search: ServiceSpec = { name: 'search', services: ['search'], heapLimitMiB: 512, rssLimitMiB: 1_024 }
const devices: ServiceSpec = { name: 'devices', services: ['devices'], heapLimitMiB: 256, rssLimitMiB: 0 }

describe('ServiceSupervisor', () => {
  let children: FakeService[]
  let lines: string[]
  const latest = (name = 'search') => children.filter((child) => child.spec.name === name).at(-1)!
  const staged: string[] = []
  const make = (specs: ServiceSpec[] = [search], overrides: Partial<ServiceSupervisorOptions> = {}, env: Record<string, string> = {}, tell = true) =>
    new ServiceSupervisor(specs, {
      ...(tell ? { staged: (version: string) => { staged.push(version) } } : {}),
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

  it('passes on what the updater staged, and starts it again at once when it asks: not a crash', () => {
    const updater: ServiceSpec = { name: 'updater', ...UPDATER_HOST }
    staged.length = 0
    const supervisor = make([updater], { parkCrashes: 2 })
    supervisor.start()
    latest('updater').beat()
    latest('updater').say({ type: 'harnessd:staged', version: '9.9.9' })
    expect(staged).toEqual(['9.9.9'])
    expect(lines).toContain('[harnessd] service updater staged 9.9.9')
    for (let i = 0; i < 3; i++) {
      latest('updater').exit(75)
      vi.advanceTimersByTime(0)
    }
    expect(children).toHaveLength(4)
    expect(supervisor.status()[0]).toMatchObject({ state: 'restarting', restarts: 3, lastExit: 'code 75', lastExitReason: 'restart' })
    expect(lines).toContain('[harnessd] service updater asked to start again (code 75) — restarting')
    // Killed for hanging, its 75 is no request.
    latest('updater').beat()
    vi.advanceTimersByTime(options.heartbeatTimeoutMs * 2)
    latest('updater').exit(75)
    expect(supervisor.status()[0].lastExitReason).toBe('hung')
    // A master that was not told how to pass a staging on only says it.
    const quiet = make([updater], {}, {}, false)
    quiet.start()
    latest('updater').say({ type: 'harnessd:staged', version: '9.9.10' })
    expect(staged).toEqual(['9.9.9'])
  })

  it('takes a staged build, or a request to start again at once, from the updater alone', () => {
    // A staged build restarts the core. From any other service it is a bug or worse: said once, nothing done.
    staged.length = 0
    const supervisor = make([search], { parkCrashes: 2 })
    supervisor.start()
    latest().beat()
    latest().say({ type: 'harnessd:staged', version: '6.6.6' })
    latest().say({ type: 'harnessd:staged', version: '6.6.7' })
    expect(staged).toEqual([])
    expect(lines.filter((line) => line.includes('staged'))).toEqual(['[harnessd] service search said it staged 6.6.6, which only the updater may — ignored'])
    // Its exit 75 is a crash like any other: restarted after the backoff, and parked when it keeps on.
    latest().exit(75)
    expect(supervisor.status()[0]).toMatchObject({ state: 'restarting', lastExit: 'code 75', lastExitReason: 'crashed' })
    vi.advanceTimersByTime(0)
    expect(children).toHaveLength(1)
    vi.advanceTimersByTime(options.initialBackoffMs)
    expect(children).toHaveLength(2)
    latest().exit(75)
    expect(supervisor.status()[0].state).toBe('parked')
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
    // Never beat at all: hung from the start, once one beat's time more has passed.
    vi.advanceTimersByTime(6_000)
    expect(latest().kills).toEqual([])
    vi.advanceTimersByTime(2_000)
    expect(latest().kills).toEqual(['SIGKILL'])
    latest().exit(null, 'SIGKILL')
    expect(supervisor.status()[0]).toMatchObject({ lastExitReason: 'hung', state: 'restarting' })
    vi.advanceTimersByTime(1_000)
    const second = latest()
    for (let i = 0; i < 3; i++) { vi.advanceTimersByTime(5_000); second.beat() }
    expect(second.kills).toEqual([])
    vi.advanceTimersByTime(8_000)
    expect(second.kills).toEqual(['SIGKILL'])
    expect(lines.some((line) => line.includes('sent no heartbeat for 8000 ms — it is hung'))).toBe(true)
  })

  it('takes no silence it was paused through for a hang: the beat a resumed service sends keeps it', () => {
    const supervisor = make()
    supervisor.start()
    const child = latest()
    child.beat()
    // Paused with the master: on resume the silence runs out at once and the overdue beat follows.
    vi.advanceTimersByTime(6_000)
    vi.advanceTimersByTime(10)
    child.beat()
    for (let i = 0; i < 6; i++) { vi.advanceTimersByTime(5_000); child.beat() }
    expect(child.kills).toEqual([])
    expect(supervisor.status()[0]).toMatchObject({ restarts: 0 })
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

  it('leaves the new reader workers off for old cores that already read inline, and starts only the requested engine', () => {
    const specs = serviceSpecs({}, SERVICE_HOSTS).filter(spec => spec.name.startsWith('engine-'))
    expect(specs.map(spec => spec.name)).toEqual(['engine-claude', 'engine-codex'])
    const supervisor = make(specs)
    supervisor.start()
    for (const protocol of [0, 1, 2, 3, 4]) supervisor.unasked(protocol)
    expect(children).toHaveLength(0)
    supervisor.want('engine-codex')
    expect(children.map(child => child.spec.name)).toEqual(['engine-codex'])
  })

  it('starts an experiment\'s process only once the core asks for one of its services, and keeps it like any other', () => {
    const experiment: ServiceSpec = { name: 'experiments', services: ['orchestrator', 'teams'], heapLimitMiB: 256, rssLimitMiB: 512, onDemand: true }
    const supervisor = make([search, experiment])
    supervisor.start()
    expect(children.map((child) => child.spec.name)).toEqual(['search'])
    expect(supervisor.status().map((status) => status.state)).toEqual(['starting', 'off'])
    supervisor.want('search')
    supervisor.want('nobody')
    expect(children).toHaveLength(1)
    supervisor.want('teams')
    expect(latest('experiments').env.HARNESSD_SERVICE).toBe('experiments')
    // Asked again, while it runs or after it crashed: the master's to restart, once.
    supervisor.want('orchestrator')
    latest('experiments').exit(1)
    supervisor.want('teams')
    expect(children.filter((child) => child.spec.name === 'experiments')).toHaveLength(1)
    vi.advanceTimersByTime(1_000)
    expect(children.filter((child) => child.spec.name === 'experiments')).toHaveLength(2)
    expect(lines.filter((line) => line.includes('service experiments started'))).toHaveLength(2)
  })

  it('starts every process on demand a core too old to ask for it would never ask for, and stops one never started at once', () => {
    const experiment: ServiceSpec = { name: 'orchestrator', services: ['orchestrator'], heapLimitMiB: 256, rssLimitMiB: 512, onDemand: true }
    const devices: ServiceSpec = { name: 'devices', services: ['devices', 'wifi'], heapLimitMiB: 256, rssLimitMiB: 512, onDemand: true, askedSince: 4 }
    const idle: ServiceSpec = { ...experiment, name: 'teams', services: ['teams'] }
    // A core of protocol 3 asks for the experiments, not for the devices: theirs starts as it binds.
    const three = make([search, experiment, devices])
    three.start()
    three.unasked(3)
    expect(children.map((child) => child.spec.name)).toEqual(['search', 'devices'])
    three.unasked(4)
    expect(children).toHaveLength(2)
    // A core from before `want` asks for none.
    children.length = 0
    const supervisor = make([experiment, devices])
    supervisor.start()
    supervisor.unasked(2)
    expect(children.map((child) => child.spec.name)).toEqual(['orchestrator', 'devices'])
    const never = make([idle])
    never.start()
    const done = vi.fn()
    never.stop(done)
    expect(done).toHaveBeenCalledOnce()
    expect(never.status()[0].state).toBe('stopped')
    // Started again with the others (a re-execution the new bundle refused): off, and started when asked.
    never.start()
    expect(never.status()[0].state).toBe('off')
    never.unasked(2)
    expect(children.map((child) => child.spec.name)).toEqual(['orchestrator', 'devices', 'teams'])
    // One running then is stopped and started with the others, and waits to be asked for again.
    never.stop(vi.fn())
    latest('teams').exit(0)
    never.start()
    expect(never.status()[0].state).toBe('off')
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
    const known = { search: { services: ['search'], heapLimitMiB: 512, rssLimitMiB: 1_024 }, devices: { services: ['devices'], heapLimitMiB: 256, rssLimitMiB: 0 } }
    expect(serviceSpecs({ HARNESSD_SERVICES: ' devices, nope ,search,devices,' }, known)).toEqual([search, devices])
    // Every service in its own process unless told otherwise: isolation is the default.
    expect(serviceSpecs({}, known)).toEqual([search, devices])
    expect(serviceSpecs({ HARNESSD_SERVICES: 'none' }, known)).toEqual([])
    expect(serviceSpecs({ HARNESSD_SERVICES: '' }, known)).toEqual([])
    expect(serviceSpecs({ HARNESSD_SERVICES: 'none,search' }, known)).toEqual([search])
    expect(serviceSpecs({ HARNESSD_SERVICES: 'toString,constructor' }, known)).toEqual([])
    // One heap limit for every service, when given as a whole number of MiB.
    expect(serviceSpecs({ HARNESSD_SERVICES: 'search', HARNESSD_SERVICE_HEAP_LIMIT_MIB: '96' }, known)).toEqual([{ ...search, heapLimitMiB: 96 }])
    expect(serviceSpecs({ HARNESSD_SERVICES: 'search', HARNESSD_SERVICE_HEAP_LIMIT_MIB: 'lots' }, known)).toEqual([search])
  })

  it('runs the services a host shares in one process: those named of them, or all of them by its name', () => {
    const edge = { services: ['workspaces', 'usage', 'monitor'], heapLimitMiB: 256, rssLimitMiB: 512 }
    const hosts = { search: { services: ['search'], heapLimitMiB: 512, rssLimitMiB: 1_024 }, edge }
    expect(serviceSpecs({}, hosts)).toEqual([search, { name: 'edge', ...edge }])
    expect(serviceSpecs({ HARNESSD_SERVICES: 'monitor,workspaces' }, hosts)).toEqual([{ name: 'edge', ...edge, services: ['workspaces', 'monitor'] }])
    expect(serviceSpecs({ HARNESSD_SERVICES: 'edge,search' }, hosts)).toEqual([search, { name: 'edge', ...edge }])
    expect(serviceSpecs({ HARNESSD_SERVICES: 'usage' }, hosts)).toEqual([{ name: 'edge', ...edge, services: ['usage'] }])
  })

  it('leaves an experiment\'s process to the core\'s asking, unless it is named: then it starts with the others', () => {
    const orchestrator = { services: ['orchestrator'], heapLimitMiB: 256, rssLimitMiB: 512, onDemand: true }
    const hosts = { search: { services: ['search'], heapLimitMiB: 512, rssLimitMiB: 1_024 }, orchestrator }
    expect(serviceSpecs({}, hosts)).toEqual([search, { name: 'orchestrator', ...orchestrator }])
    expect(serviceSpecs({ HARNESSD_SERVICES: 'search,orchestrator' }, hosts))
      .toEqual([search, { name: 'orchestrator', services: ['orchestrator'], heapLimitMiB: 256, rssLimitMiB: 512 }])
    expect(serviceSpecs({ HARNESSD_SERVICES: 'search' }, hosts)).toEqual([search])
  })

  it('runs the devices only once there is one, asked for by a core of protocol 4, and from the start when named (tests)', () => {
    const [devices] = serviceSpecs({}, SERVICE_HOSTS).filter((spec) => spec.name === 'devices')
    expect(devices).toMatchObject({ services: ['devices', 'wifi'], onDemand: true, askedSince: 4 })
    const [named] = serviceSpecs({ HARNESSD_SERVICES: 'devices' }, SERVICE_HOSTS)
    expect(named.services).toEqual(['devices', 'wifi'])
    expect(named.onDemand).toBeUndefined()
  })

  it('runs models only once grid is in use or asked for, by a core of protocol 4, and from the start when named', () => {
    const [models] = serviceSpecs({}, SERVICE_HOSTS).filter((spec) => spec.name === 'models')
    expect(models).toMatchObject({ services: ['models'], onDemand: true, askedSince: 4 })
    const [named] = serviceSpecs({ HARNESSD_SERVICES: 'models' }, SERVICE_HOSTS)
    expect(named.services).toEqual(['models'])
    expect(named.onDemand).toBeUndefined()
  })

  it('knows every service each process this build runs hosts, and each in one process only', () => {
    const hosted = Object.values(SERVICE_HOSTS).flatMap((host) => host.services)
    expect(KNOWN_SERVICES).toEqual(hosted)
    expect(new Set(hosted).size).toBe(hosted.length)
    expect(SERVICE_HOSTS.edge.services).toEqual(['workspaces', 'usage', 'monitor', 'projects', 'handoff', 'recaps', 'windowNames', 'shell'])
  })
})

describe('which services the core leaves to its master', () => {
  const known = ['search', 'viewers', 'workspaces', 'teams']
  const supervised = { HARNESSD_SUPERVISED: '1', HARNESSD_SERVICE_TOKEN: 'token' }

  it('is what the master says it runs, told in a form a core from before the list reads too', () => {
    const specs = serviceSpecs({ HARNESSD_SERVICES: 'search,workspaces' }, SERVICE_HOSTS)
    expect(serviceProcessesEnv(specs, 42)).toEqual({ [SERVICE_PROCESSES_ENV]: 'search,workspaces', HARNESSD_SERVICES: 'search,workspaces', [ENGINE_LIVE_ENV]: '42:1', [ENGINE_RUNTIME_ENV]: '42:1', [ENGINE_SCREEN_ENV]: '42:1', [ENGINE_MODEL_CONTROL_ENV]: '42:1', [ENGINE_QUESTION_CONTROL_ENV]: '42:1' })
    // A process named as one of its services is named whole: the viewers' process runs the Store beside them.
    expect(serviceProcessesEnv(serviceSpecs({ HARNESSD_SERVICES: 'viewers' }, SERVICE_HOSTS), 42)).toMatchObject({ [SERVICE_PROCESSES_ENV]: 'viewers,store' })
    expect(serviceProcessesEnv(serviceSpecs({ HARNESSD_SERVICES: 'store' }, SERVICE_HOSTS), 42)).toMatchObject({ [SERVICE_PROCESSES_ENV]: 'store' })
    // By service, not by process: a core from before the edge host routes the services it knows of it.
    const hosted = serviceSpecs({ HARNESSD_SERVICES: 'edge' }, SERVICE_HOSTS)
    expect(serviceProcessesEnv(hosted, 42)).toEqual({ [SERVICE_PROCESSES_ENV]: 'workspaces,usage,monitor,projects,handoff,recaps,windowNames,shell', HARNESSD_SERVICES: 'workspaces,usage,monitor,projects,handoff,recaps,windowNames,shell', [ENGINE_LIVE_ENV]: '42:1', [ENGINE_RUNTIME_ENV]: '42:1', [ENGINE_SCREEN_ENV]: '42:1', [ENGINE_MODEL_CONTROL_ENV]: '42:1', [ENGINE_QUESTION_CONTROL_ENV]: '42:1' })
    expect([...servicesTheMasterRuns({ ...supervised, ...serviceProcessesEnv(hosted, 42) }, known)]).toEqual(['workspaces'])
    expect(serviceProcessesEnv([], 42)).toEqual({ [SERVICE_PROCESSES_ENV]: '', HARNESSD_SERVICES: 'none', [ENGINE_LIVE_ENV]: '42:1', [ENGINE_RUNTIME_ENV]: '42:1', [ENGINE_SCREEN_ENV]: '42:1', [ENGINE_MODEL_CONTROL_ENV]: '42:1', [ENGINE_QUESTION_CONTROL_ENV]: '42:1' })
    expect([...servicesTheMasterRuns({ ...supervised, ...serviceProcessesEnv(specs, 42) }, known)]).toEqual(['search', 'workspaces'])
    expect([...servicesTheMasterRuns({ ...supervised, ...serviceProcessesEnv([], 42) }, known)]).toEqual([])
    // What the master says wins over whatever HARNESSD_SERVICES the core inherited; names it does not know are its own.
    expect([...servicesTheMasterRuns({ ...supervised, [SERVICE_PROCESSES_ENV]: ' teams, nothing ', HARNESSD_SERVICES: 'search' }, known)]).toEqual(['teams'])
  })

  it('under a master too old to say, is what HARNESSD_SERVICES names, and nothing when it names none: never every service', () => {
    // A released master (0.3.58) runs no service process unless HARNESSD_SERVICES names one, and does not
    // re-execute on an update: the core it starts must not take every service for out of process.
    expect([...servicesTheMasterRuns(supervised, known)]).toEqual([])
    expect([...servicesTheMasterRuns({ ...supervised, HARNESSD_SERVICES: 'search' }, known)]).toEqual(['search'])
  })

  it('accepts live engine support only from the actual supervising parent', () => {
    const env = { ...supervised, ...serviceProcessesEnv([], 42) }
    expect(masterRunsLiveEngines(env, 42)).toBe(true)
    expect(masterRunsLiveEngines(env, 43)).toBe(false)
    expect(masterRunsLiveEngines(supervised, 42)).toBe(false)
    expect(masterRunsLiveEngines({ ...env, [ENGINE_LIVE_ENV]: '1' }, 42)).toBe(false)
    expect(masterRunsLiveEngines({ ...env, [ENGINE_LIVE_ENV]: '42:2' }, 42)).toBe(false)
    expect(masterRunsLiveEngines({ ...env, HARNESSD_SUPERVISED: undefined }, 42)).toBe(false)
    expect(masterRunsLiveEngines({ ...env, HARNESSD_SERVICE_TOKEN: undefined }, 42)).toBe(false)
  })

  it('accepts runtime profile support only from the actual supervising parent, independently of live support', () => {
    const env = { ...supervised, ...serviceProcessesEnv([], 42) }
    expect(masterRunsEngineRuntime(env, 42)).toBe(true)
    expect(masterRunsEngineRuntime(env, 43)).toBe(false)
    expect(masterRunsEngineRuntime(supervised, 42)).toBe(false)
    expect(masterRunsEngineRuntime({ ...env, [ENGINE_RUNTIME_ENV]: '1' }, 42)).toBe(false)
    expect(masterRunsEngineRuntime({ ...env, [ENGINE_RUNTIME_ENV]: '42:2' }, 42)).toBe(false)
    expect(masterRunsEngineRuntime({ ...env, HARNESSD_SUPERVISED: undefined }, 42)).toBe(false)
    expect(masterRunsEngineRuntime({ ...env, HARNESSD_SERVICE_TOKEN: undefined }, 42)).toBe(false)
    expect(masterRunsLiveEngines({ ...env, [ENGINE_RUNTIME_ENV]: undefined }, 42)).toBe(true)
  })

  it('negotiates model controls only from a capable supervising parent', () => {
    const env = { ...supervised, ...serviceProcessesEnv([], 42) }
    expect(masterRunsEngineQuestionControl(env, 42)).toBe(true)
    expect(masterRunsEngineQuestionControl(env, 43)).toBe(false)
    expect(masterRunsEngineQuestionControl({ ...env, [ENGINE_QUESTION_CONTROL_ENV]: undefined }, 42)).toBe(false)
    expect(masterRunsEngineQuestionControl({ ...env, HARNESSD_SERVICE_TOKEN: undefined }, 42)).toBe(false)
    expect(masterRunsEngineModelControl(env, 42)).toBe(true)
    expect(masterRunsEngineModelControl(env, 43)).toBe(false)
    expect(masterRunsEngineModelControl({ ...env, [ENGINE_MODEL_CONTROL_ENV]: undefined }, 42)).toBe(false)
    expect(masterRunsEngineModelControl({ ...env, [ENGINE_LIVE_ENV]: undefined }, 42)).toBe(false)
    expect(masterRunsEngineModelControl({ ...env, HARNESSD_SERVICE_TOKEN: undefined }, 42)).toBe(false)
  })

  it('negotiates screen readers only from a capable supervising parent', () => {
    const env = { ...supervised, ...serviceProcessesEnv([], 42) }
    expect(masterRunsEngineScreen(env, 42)).toBe(true)
    expect(masterRunsEngineScreen(env, 43)).toBe(false)
    expect(masterRunsEngineScreen({ ...env, [ENGINE_SCREEN_ENV]: undefined }, 42)).toBe(false)
    expect(masterRunsEngineScreen({ ...env, [ENGINE_LIVE_ENV]: undefined }, 42)).toBe(false)
    expect(masterRunsEngineScreen({ ...env, HARNESSD_SERVICE_TOKEN: undefined }, 42)).toBe(false)
  })

  it('is none without a master, or without the token its services would connect with', () => {
    expect([...servicesTheMasterRuns({ [SERVICE_PROCESSES_ENV]: 'search' }, known)]).toEqual([])
    expect([...servicesTheMasterRuns({ HARNESSD_SUPERVISED: '1', [SERVICE_PROCESSES_ENV]: 'search' }, known)]).toEqual([])
  })
})
