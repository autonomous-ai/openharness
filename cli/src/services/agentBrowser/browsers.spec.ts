import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Browsers, type BrowserState } from './browsers.js'
import type { Containers } from './containers.js'
import { PodmanError, type Availability, type Podman } from './podman.js'
import { defaultSettings, type BrowserSettings } from './settings.js'
import type { Setup } from './setup.js'
import { StateFile } from './stateFile.js'

const GiB = 1024 ** 3
const IMAGE = 'harness-browser:abc-2026w46'
const host = { timeZone: 'Asia/Ho_Chi_Minh', languages: 'vi-VN' }
const proxy = { scheme: 'http' as const, host: 'proxy.example', port: 8080, username: 'u', password: 'proxy-s3cret' }

const label = (s: BrowserState | undefined) => (s ? [s.state, s.step ?? s.error].filter(Boolean).join('/') : 'none')
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

let dir: string
let path: string
beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'agent-browsers-'))
  path = join(dir, 'agent-browser.json')
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

/** Everything Browsers drives, as fakes: a container "runs" from its start until it is stopped, removed or crashed. */
function rig() {
  const running = new Set<string>()
  const exitCodes = new Map<string, number>()
  const availability: { value: Availability } = { value: { state: 'ready' } }
  const connection: { value: string | null } = { value: null }
  const podman = {
    available: vi.fn(async () => availability.value),
    connection: () => connection.value,
    useConnection: vi.fn((name: string) => { connection.value = name }),
    startMachine: vi.fn(async () => {}),
    memoryBytes: vi.fn(async () => 17 * GiB),
  }
  const containers = {
    start: vi.fn(async (agentId: string, _image: string, _settings: BrowserSettings, _zone: string, _secretId: string) => {
      running.add(agentId)
      return { limitsDropped: [] as string[] }
    }),
    stop: vi.fn(async (agentId: string) => { running.delete(agentId) }),
    remove: vi.fn(async (agentId: string) => { running.delete(agentId) }),
    sweep: vi.fn(async (_listed: Set<string>) => 0),
    running: vi.fn(async () => [...running]),
    ready: vi.fn(async (agentId: string) => running.has(agentId)),
    exitCode: vi.fn(async (agentId: string) => (running.has(agentId) ? null : exitCodes.get(agentId) ?? null)),
  }
  const setup = { run: vi.fn(async (_from: unknown): Promise<void> => {}) }
  const image = vi.fn(async () => IMAGE)
  const exitZone = vi.fn(async (_proxy: unknown): Promise<string | null> => null)
  const seen = new Map<string, string[]>()
  const measured: string[] = []
  const logged: string[] = []
  const closed: string[] = []
  const podmanAnswered = vi.fn()
  const state = new StateFile(path)
  const browsers: Browsers = new Browsers({
    podman: podman as unknown as Podman,
    containers: containers as unknown as Containers,
    setup: setup as unknown as Setup,
    image,
    state,
    host,
    exitZone,
    changed: agentId => seen.set(agentId, [...(seen.get(agentId) ?? []), label(browsers.state(agentId))]),
    closeViewers: agentId => closed.push(agentId),
    measure: name => measured.push(name),
    log: line => logged.push(line),
    podmanAnswered,
  })
  /** The container exits, and nothing has told Browsers yet. */
  const vanish = (agentId: string, code: number) => {
    running.delete(agentId)
    exitCodes.set(agentId, code)
  }
  const crash = (agentId: string, code: number) => {
    vanish(agentId, code)
    browsers.exited(agentId)
  }
  return { browsers, podman, containers, setup, image, exitZone, state, availability, connection, running, seen, measured, logged, closed, podmanAnswered, vanish, crash }
}

const shown = (r: ReturnType<typeof rig>, agentId: string) => label(r.browsers.state(agentId))
/** A start whose container comes up at once has settled after this. */
const settle = async () => { for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0) }

describe('Browsers', () => {
  it('start with no podman and no setup running is failed needs_setup', async () => {
    const r = rig()
    r.availability.value = { state: 'needs_setup' }
    await r.browsers.start('a1')
    expect(shown(r, 'a1')).toBe('failed/needs_setup')
    expect(r.containers.start).not.toHaveBeenCalled()
    expect(r.measured).toEqual(['agent_browser_start_failed', 'agent_browser_failed_needs_setup'])
  })

  it('setUp reports steps and then starts the waiting browsers', async () => {
    const r = rig()
    r.availability.value = { state: 'needs_setup' }
    await r.browsers.start('a1')
    let recorded: unknown
    r.setup.run.mockImplementation(async () => {
      r.browsers.setupStep('installing')
      recorded = r.state.read().setup
      r.browsers.setupStep('starting_podman')
      r.browsers.setupStep(null)
    })
    await r.browsers.setUp()
    expect(r.setup.run).toHaveBeenCalledWith({ step: null })
    expect(recorded).toEqual({ step: 'installing' })
    expect(r.state.read().setup).toBeNull()
    expect(r.seen.get('a1')).toEqual(['starting', 'failed/needs_setup', 'setup/installing', 'setup/starting_podman', 'setup/building', 'starting', 'ready'])
    expect(r.measured).toContain('agent_browser_setup_ok')
    // Setup just put Podman here: its availability, cached from before the install, is not asked again.
    expect(r.podman.available).toHaveBeenCalledTimes(1)
  })

  it('the connection name survives a restart through the state file', async () => {
    const r = rig()
    r.availability.value = { state: 'needs_setup', ownMachine: true }
    await r.browsers.start('a1')
    r.setup.run.mockImplementationOnce(async () => {
      r.connection.value = 'harness'
      r.browsers.setupStep(null)
    })
    await r.browsers.setUp()
    expect(shown(r, 'a1')).toBe('ready')
    expect(r.state.read().connection).toBe('harness')
    // The daemon starts again: its new Podman runs on Harness's machine before anything asks it.
    const again = rig()
    expect(again.podman.useConnection).toHaveBeenCalledWith('harness')
    expect(again.podman.available).not.toHaveBeenCalled()
    // A file that cannot be read names itself at resume; until then Podman keeps the default.
    writeFileSync(path, '{ broken')
    expect(rig().podman.useConnection).not.toHaveBeenCalled()
  })

  it('a start while setup runs waits for it', async () => {
    const r = rig()
    const run = deferred<void>()
    r.setup.run.mockImplementation(async () => { r.browsers.setupStep('installing'); return await run.promise })
    const setUp = r.browsers.setUp()
    expect(r.browsers.setUp()).toBe(setUp)
    await r.browsers.start('a1')
    expect(shown(r, 'a1')).toBe('setup/installing')
    expect(r.podman.available).not.toHaveBeenCalled()
    run.resolve()
    await setUp
    expect(shown(r, 'a1')).toBe('ready')
    expect(r.setup.run).toHaveBeenCalledTimes(1)
  })

  it('a start in the moment before setup reports its first step joins it', async () => {
    const r = rig()
    const run = deferred<void>()
    r.setup.run.mockReturnValueOnce(run.promise)
    const setUp = r.browsers.setUp()
    await r.browsers.start('a1')
    expect(shown(r, 'a1')).toBe('starting')
    r.browsers.setupStep('starting_podman')
    expect(shown(r, 'a1')).toBe('setup/starting_podman')
    run.resolve()
    await setUp
    expect(shown(r, 'a1')).toBe('ready')
  })

  it('a start that fails after its stop shows nothing', async () => {
    const r = rig()
    const slow = deferred<{ limitsDropped: string[] }>()
    r.containers.start.mockReturnValueOnce(slow.promise)
    const started = r.browsers.start('a1')
    await settle()
    await Promise.all([r.browsers.stop('a1'), (slow.reject(new PodmanError('podman_failed', 'podman create failed')), started)])
    expect(shown(r, 'a1')).toBe('none')
    expect(r.measured).toEqual([])
  })

  it('setup that fails names it on every waiting browser, and Retry runs setup again', async () => {
    const r = rig()
    r.availability.value = { state: 'needs_setup' }
    await r.browsers.start('a1')
    await r.browsers.start('a2')
    r.setup.run.mockRejectedValueOnce(new PodmanError('podman_install_failed', 'osascript exited 1: User canceled'))
    await r.browsers.setUp()
    expect(shown(r, 'a1')).toBe('failed/podman_install_failed')
    expect(shown(r, 'a2')).toBe('failed/podman_install_failed')
    expect(r.measured).toContain('agent_browser_setup_failed')
    expect(r.logged.join('\n')).toContain('User canceled')
    r.setup.run.mockRejectedValueOnce(new PodmanError('podman_manual', 'pkexec is not installed'))
    await r.browsers.retry('a1')
    expect(shown(r, 'a1')).toBe('failed/podman_manual')
    await r.browsers.retry('a1')
    expect(r.setup.run).toHaveBeenCalledTimes(3)
    expect(shown(r, 'a1')).toBe('ready')
    expect(shown(r, 'a2')).toBe('ready')
  })

  it('start starts a stopped machine first', async () => {
    const r = rig()
    r.availability.value = { state: 'stopped' }
    await r.browsers.start('a1')
    expect(r.podman.startMachine).toHaveBeenCalledOnce()
    expect(r.podman.startMachine.mock.invocationCallOrder[0]).toBeLessThan(r.containers.start.mock.invocationCallOrder[0]!)
    expect(shown(r, 'a1')).toBe('ready')
  })

  it('a first start with no image shows setup/building until the build ends, then starting, then ready', async () => {
    const r = rig()
    const build = deferred<string>()
    r.image.mockReturnValueOnce(build.promise)
    const started = r.browsers.start('a1')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(shown(r, 'a1')).toBe('setup/building')
    build.resolve(IMAGE)
    await started
    expect(r.seen.get('a1')).toEqual(['starting', 'setup/building', 'starting', 'ready'])
  })

  it('resume with the step starting_podman runs setUp', async () => {
    const setup = { step: 'starting_podman' }
    writeFileSync(path, JSON.stringify({ browsers: {}, deleting: [], setup }))
    const r = rig()
    r.availability.value = { state: 'needs_setup' }
    const run = deferred<void>()
    r.setup.run.mockReturnValueOnce(run.promise)
    await r.browsers.resume(new Set())
    expect(r.setup.run).toHaveBeenCalledWith(setup)
    await r.browsers.start('a1')
    expect(shown(r, 'a1')).toBe('setup/starting_podman')
    run.resolve()
    await settle()
  })

  it('resume with the step installing does not run the installer', async () => {
    writeFileSync(path, JSON.stringify({ browsers: {}, deleting: [], setup: { step: 'installing' } }))
    const r = rig()
    r.availability.value = { state: 'needs_setup' }
    await r.browsers.resume(new Set())
    expect(r.setup.run).not.toHaveBeenCalled()
    await r.browsers.start('a1')
    expect(shown(r, 'a1')).toBe('failed/podman_install_failed')
    // Only the person's Retry raises the password dialog, from the recorded step.
    await r.browsers.retry('a1')
    expect(r.setup.run).toHaveBeenCalledWith({ step: 'installing' })
  })

  it('start goes starting then ready, looking for the marker once a second for at most 60 s', async () => {
    const r = rig()
    r.containers.ready.mockResolvedValueOnce(false).mockResolvedValueOnce(false)
    const started = r.browsers.start('a1')
    await vi.advanceTimersByTimeAsync(2_000)
    await started
    expect(r.seen.get('a1')).toEqual(['starting', 'ready'])
    expect(r.containers.ready).toHaveBeenCalledTimes(3)
    expect(r.measured).toEqual(['agent_browser_start_ok'])

    r.containers.ready.mockReset().mockResolvedValue(false)
    const never = r.browsers.start('a2')
    await vi.advanceTimersByTimeAsync(120_000)
    await never
    expect(r.containers.ready).toHaveBeenCalledTimes(60)
    expect(shown(r, 'a2')).toBe('failed/browser_stopped')
  })

  it('failures are named', async () => {
    const cases: Array<[string, (r: ReturnType<typeof rig>) => void]> = [
      ['podman_old', r => { r.availability.value = { state: 'podman_old' } }],
      ['podman_memory', r => { r.availability.value = { state: 'podman_memory' } }],
      ['podman_down', r => { r.podman.available.mockRejectedValue(new PodmanError('podman_down', 'Podman is not running')) }],
      ['podman_down', r => { r.availability.value = { state: 'stopped' }; r.podman.startMachine.mockRejectedValue(new PodmanError('podman_down', 'machine did not start')) }],
      // A podman call that failed or timed out is Podman not running, the failure the panel has copy for.
      ['podman_down', r => { r.containers.start.mockRejectedValue(new PodmanError('podman_failed', 'podman create timed out after 30000 ms')) }],
      ['podman_down', r => { r.containers.start.mockRejectedValue(new Error('spawn EACCES')) }],
      ['image_failed', r => { r.image.mockRejectedValue(new PodmanError('image_failed', 'E: Unable to locate package')) }],
      ['browser_limit', r => { r.podman.memoryBytes.mockResolvedValue(3 * GiB); r.running.add('other') }],
    ]
    for (const [state, arrange] of cases) {
      const r = rig()
      arrange(r)
      await r.browsers.start('a1')
      expect(shown(r, 'a1')).toBe(`failed/${state}`)
      expect(r.measured).toEqual(['agent_browser_start_failed', `agent_browser_failed_${state}`])
      expect(r.logged).toEqual([expect.stringContaining(state)])
    }
  })

  it('exit codes 3, 4 and 5 go straight to failed and are not restarted', async () => {
    for (const [code, state] of [[3, 'profile_unwritable'], [4, 'proxy_failed'], [5, 'device_failed']] as const) {
      const r = rig()
      await r.browsers.start('a1')
      r.crash('a1', code)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(shown(r, 'a1')).toBe(`failed/${state}`)
      expect(r.containers.start).toHaveBeenCalledOnce()
      expect(r.measured).toContain(`agent_browser_failed_${state}`)
    }
  })

  it('an exit while the browser starts is seen without waiting out the 60 s', async () => {
    const r = rig()
    r.containers.ready.mockResolvedValue(false)
    const started = r.browsers.start('a1')
    await settle()
    r.crash('a1', 4)
    await vi.advanceTimersByTimeAsync(1_000)
    await started
    expect(shown(r, 'a1')).toBe('failed/proxy_failed')
    expect(r.containers.ready).toHaveBeenCalledTimes(1)
  })

  it('retry on browser_limit starts the browser once another has stopped; the limit counts running browsers only', async () => {
    const r = rig()
    r.podman.memoryBytes.mockResolvedValue(3 * GiB)
    await r.browsers.start('a1')
    await r.browsers.start('a2')
    expect(shown(r, 'a2')).toBe('failed/browser_limit')
    // Its own running browser never counts against it.
    await r.browsers.start('a1')
    expect(shown(r, 'a1')).toBe('ready')
    await r.browsers.stop('a1')
    await r.browsers.retry('a2')
    expect(shown(r, 'a2')).toBe('ready')
  })

  it('starts at the same moment over the limit start exactly the limit, and a failed start gives its slot back', async () => {
    const r = rig()
    // A 4 GB Podman machine: one browser.
    r.podman.memoryBytes.mockResolvedValue(4 * GiB)
    const agents = ['a1', 'a2', 'a3']
    await Promise.all(agents.map(agentId => r.browsers.start(agentId)))
    expect(agents.map(agentId => shown(r, agentId)).sort()).toEqual(['failed/browser_limit', 'failed/browser_limit', 'ready'])
    expect(r.containers.start).toHaveBeenCalledOnce()
    for (const agentId of agents) await r.browsers.stop(agentId)
    r.containers.start.mockRejectedValueOnce(new PodmanError('podman_failed', 'podman create failed: image not known'))
    await r.browsers.start('a4')
    expect(shown(r, 'a4')).toBe('failed/podman_down')
    await r.browsers.start('a5')
    expect(shown(r, 'a5')).toBe('ready')
  })

  it('a browser not ready within 60 s is removed, so it holds no slot', async () => {
    const r = rig()
    r.podman.memoryBytes.mockResolvedValue(4 * GiB)
    r.containers.ready.mockResolvedValue(false)
    const never = r.browsers.start('a1')
    await vi.advanceTimersByTimeAsync(120_000)
    await never
    expect(shown(r, 'a1')).toBe('failed/browser_stopped')
    expect(r.containers.stop).toHaveBeenCalledWith('a1')
    expect(r.running.has('a1')).toBe(false)
    // A removal that fails is logged, and the browser still shows why it stopped.
    r.containers.stop.mockRejectedValueOnce(new PodmanError('podman_failed', 'podman rm timed out after 30000 ms'))
    const again = r.browsers.start('a2')
    await vi.advanceTimersByTimeAsync(120_000)
    await again
    expect(shown(r, 'a2')).toBe('failed/browser_stopped')
    expect(r.logged.join('\n')).toContain('podman rm timed out')
  })

  it('a start whose listing Podman answered says so, for the event stream to try again', async () => {
    const r = rig()
    await r.browsers.start('a1')
    expect(r.podmanAnswered).toHaveBeenCalledOnce()
    const down = rig()
    down.containers.running.mockRejectedValue(new PodmanError('podman_failed', 'podman ps failed: machine is not running'))
    await down.browsers.start('a1')
    expect(down.podmanAnswered).not.toHaveBeenCalled()
  })

  it("the proxy's secret id changes with its password alone, outlives a restart and is never handed out", async () => {
    const r = rig()
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    const lastId = (of = r) => of.containers.start.mock.calls.at(-1)![4]
    const withProxy = { ...defaultSettings(host), proxy }
    await r.browsers.saveSettings('a1', withProxy)
    await r.browsers.start('a1')
    const first = lastId()
    expect(first).toMatch(uuid)
    expect(r.containers.start.mock.calls.at(-1)![2]).toEqual(withProxy)
    expect(r.browsers.settings('a1')).toEqual(withProxy)
    // Kept beside the password, in the person's own 0600 file.
    expect(r.state.read().browsers.a1!.proxy).toMatchObject({ password: proxy.password, secretId: first })
    await r.browsers.saveSettings('a1', { ...withProxy, screen: '1366x768' })
    await settle()
    expect(r.containers.start).toHaveBeenCalledTimes(2)
    expect(lastId()).toBe(first)
    const restarted = rig()
    await restarted.browsers.start('a1')
    expect(lastId(restarted)).toBe(first)
    await r.browsers.saveSettings('a1', { ...withProxy, proxy: { ...proxy, password: 'n3w-pass' } })
    await settle()
    expect(r.containers.start).toHaveBeenCalledTimes(3)
    expect(lastId()).toMatch(uuid)
    expect(lastId()).not.toBe(first)
    await r.browsers.saveSettings('a1', defaultSettings(host))
    await settle()
    expect(lastId()).toBe('')
  })

  it('exit restarts at most 3 times in a row with backoff 1 s, 2 s, 4 s; a fourth gives browser_stopped', async () => {
    const r = rig()
    await r.browsers.start('a1')
    for (const wait of [1_000, 2_000, 4_000]) {
      r.crash('a1', 137)
      await settle()
      expect(shown(r, 'a1')).toBe('starting')
      await vi.advanceTimersByTimeAsync(wait - 1)
      expect(r.running.has('a1')).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(shown(r, 'a1')).toBe('ready')
    }
    r.crash('a1', 137)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(shown(r, 'a1')).toBe('failed/browser_stopped')
    expect(r.containers.start).toHaveBeenCalledTimes(4)
    // Retry starts over.
    await r.browsers.retry('a1')
    r.crash('a1', 137)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(shown(r, 'a1')).toBe('ready')
  })

  it('the count resets after 10 minutes ready', async () => {
    const r = rig()
    await r.browsers.start('a1')
    for (let i = 0; i < 6; i++) {
      r.crash('a1', 0)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(shown(r, 'a1')).toBe('ready')
      await vi.advanceTimersByTimeAsync(10 * 60_000)
    }
  })

  it('an exit the service asked for is not counted', async () => {
    const r = rig()
    await r.browsers.start('a1')
    // A settings change and a move to a new image create the container again: the old one's exit comes after.
    await r.browsers.saveSettings('a1', { ...defaultSettings(host), screen: '1366x768' })
    await settle()
    r.browsers.exited('a1')
    r.image.mockResolvedValue('harness-browser:def-2026w47')
    await r.browsers.start('a1')
    r.browsers.exited('a1')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(shown(r, 'a1')).toBe('ready')
    expect(r.containers.start).toHaveBeenCalledTimes(3)
    await r.browsers.stop('a1')
    r.browsers.exited('a1')
    await r.browsers.start('a2')
    await r.browsers.delete('a2')
    r.browsers.exited('a2')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(r.containers.start).toHaveBeenCalledTimes(4)
    expect(shown(r, 'a1')).toBe('none')
    expect(r.closed).toEqual(['a1', 'a2'])
    // None of them counted: three crashes in a row still restart.
    await r.browsers.start('a1')
    for (let i = 0; i < 3; i++) {
      r.crash('a1', 1)
      await vi.advanceTimersByTimeAsync(4_000)
      expect(shown(r, 'a1')).toBe('ready')
    }
  })

  it('a stop while a restart waits cancels it', async () => {
    const r = rig()
    await r.browsers.start('a1')
    r.crash('a1', 137)
    await settle()
    await r.browsers.stop('a1')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(r.containers.start).toHaveBeenCalledOnce()
    expect(shown(r, 'a1')).toBe('none')
  })

  it('operations are serialized per agent; different agents run in parallel', async () => {
    const r = rig()
    const slow = deferred<{ limitsDropped: string[] }>()
    r.containers.start.mockImplementationOnce(async (agentId: string) => { await slow.promise; r.running.add(agentId); return { limitsDropped: [] } })
    const first = r.browsers.start('a1')
    await settle()
    const stopped = r.browsers.stop('a1')
    // Asked for and then stopped before its turn came: it never starts.
    const late = r.browsers.start('a1')
    const stoppedAgain = r.browsers.stop('a1')
    await r.browsers.start('a2')
    expect(shown(r, 'a2')).toBe('ready')
    expect(r.containers.stop).not.toHaveBeenCalled()
    slow.resolve({ limitsDropped: [] })
    await Promise.all([first, stopped, late, stoppedAgain])
    expect(r.containers.start.mock.calls.filter(call => call[0] === 'a1')).toHaveLength(1)
    expect(r.containers.stop).toHaveBeenCalledWith('a1')
    expect(r.running.has('a1')).toBe(false)
  })

  it('delete during build leaves no container', async () => {
    const r = rig()
    const build = deferred<string>()
    r.image.mockReturnValueOnce(build.promise)
    const started = r.browsers.start('a1')
    await settle()
    const deleted = r.browsers.delete('a1')
    await vi.advanceTimersByTimeAsync(2_000)
    build.resolve(IMAGE)
    await Promise.all([started, deleted])
    expect(r.containers.start).not.toHaveBeenCalled()
    expect(r.containers.remove).toHaveBeenCalledWith('a1')
    expect(r.state.read().browsers).toEqual({})
    expect(shown(r, 'a1')).toBe('none')
  })

  it('delete is recorded first, closes viewers, and resumes after a crash', async () => {
    const r = rig()
    await r.browsers.start('a1')
    let recorded: unknown
    r.containers.remove.mockImplementationOnce(async () => {
      recorded = r.state.read().deleting
      throw new PodmanError('podman_failed', 'podman rm timed out after 30000 ms')
    })
    await r.browsers.delete('a1')
    expect(recorded).toEqual(['a1'])
    expect(r.closed).toEqual(['a1'])
    expect(r.state.read().deleting).toEqual(['a1'])
    expect(r.logged.join('\n')).toContain('timed out')
    r.containers.remove.mockRejectedValueOnce(new PodmanError('podman_failed', 'podman rm timed out after 30000 ms'))
    await r.browsers.delete('a1')
    expect(r.state.read().deleting).toEqual(['a1'])

    const after = rig()
    await after.browsers.resume(null)
    expect(after.containers.remove).toHaveBeenCalledWith('a1')
    expect(after.state.read()).toEqual({ browsers: {}, deleting: [], setup: null })
  })

  it('browser of a gone agent is deleted at service start, and resume sweeps unlisted containers of this daemon', async () => {
    const settings = defaultSettings(host)
    writeFileSync(path, JSON.stringify({ browsers: { a1: settings, a2: settings }, deleting: [], setup: null }))
    const r = rig()
    r.containers.sweep.mockResolvedValue(2)
    await r.browsers.resume(new Set(['a1']))
    expect(r.containers.remove.mock.calls).toEqual([['a2']])
    expect(Object.keys(r.state.read().browsers)).toEqual(['a1'])
    expect(r.containers.sweep).toHaveBeenCalledWith(new Set(['a1']))
    expect(r.logged).toEqual([expect.stringContaining('2')])
  })

  it('no answer from the core deletes nothing', async () => {
    const settings = defaultSettings(host)
    writeFileSync(path, JSON.stringify({ browsers: { a1: settings, a2: settings }, deleting: ['a3'], setup: null }))
    const r = rig()
    await r.browsers.resume(null)
    expect(r.containers.remove.mock.calls).toEqual([['a3']])
    expect(r.containers.sweep).not.toHaveBeenCalled()
    expect(Object.keys(r.state.read().browsers)).toEqual(['a1', 'a2'])
  })

  it('an empty set from the core is believed', async () => {
    const settings = defaultSettings(host)
    writeFileSync(path, JSON.stringify({ browsers: { a1: settings, a2: settings }, deleting: [], setup: null }))
    const r = rig()
    await r.browsers.resume(new Set())
    expect(r.containers.remove.mock.calls).toEqual([['a1'], ['a2']])
    expect(r.state.read().browsers).toEqual({})
  })

  it('a sweep Podman cannot answer is logged', async () => {
    const r = rig()
    r.containers.sweep.mockRejectedValue(new PodmanError('podman_failed', 'podman ps failed: machine is not running'))
    await r.browsers.resume(new Set())
    expect(r.logged).toEqual([expect.stringContaining('machine is not running')])
  })

  it('an unreadable state file removes nothing and is named', async () => {
    writeFileSync(path, '{"browsers": {')
    const r = rig()
    await r.browsers.resume(new Set())
    await r.browsers.start('a1')
    await r.browsers.delete('a1')
    await r.browsers.start('a2')
    expect(shown(r, 'a1')).toBe('none')
    expect(shown(r, 'a2')).toBe('failed/state_unreadable')
    for (const changes of [r.containers.start, r.containers.stop, r.containers.remove, r.containers.sweep, r.podman.startMachine]) {
      expect(changes).not.toHaveBeenCalled()
    }
    expect(readFileSync(path, 'utf8')).toBe('{"browsers": {')
    expect(r.measured).toContain('agent_browser_failed_state_unreadable')
    expect(r.logged.length).toBeGreaterThan(0)
  })

  it('saveSettings with a changed hash restarts the browser and keeps the volume; a human-input-only change does not', async () => {
    const r = rig()
    await r.browsers.start('a1')
    const humanOnly = { ...defaultSettings(host), humanSpeed: 'fast' as const }
    await r.browsers.saveSettings('a1', humanOnly)
    await settle()
    expect(r.containers.start).toHaveBeenCalledOnce()
    expect(r.browsers.settings('a1')).toEqual(humanOnly)
    const moved = { ...humanOnly, languages: 'en-US' }
    await r.browsers.saveSettings('a1', moved)
    await settle()
    expect(r.containers.start).toHaveBeenCalledTimes(2)
    expect(r.containers.start.mock.calls[1]![2]).toEqual(moved)
    expect(r.containers.remove).not.toHaveBeenCalled()
    expect(shown(r, 'a1')).toBe('ready')
    // Saved for an agent whose browser is not running: kept, and nothing starts.
    await r.browsers.saveSettings('a9', moved)
    await settle()
    expect(r.containers.start).toHaveBeenCalledTimes(2)
    expect(r.browsers.settings('a9')).toEqual(moved)
    expect(r.browsers.settings('a8')).toEqual(defaultSettings(host))
  })

  it("auto time zone uses the proxy's exit zone, and the machine's when the lookup fails", async () => {
    const r = rig()
    const zoneOf = async (agentId: string, settings: BrowserSettings) => {
      await r.browsers.saveSettings(agentId, settings)
      await r.browsers.start(agentId)
      return r.containers.start.mock.calls.at(-1)![3]
    }
    r.exitZone.mockResolvedValueOnce('Europe/Berlin')
    expect(await zoneOf('a1', { ...defaultSettings(host), proxy })).toBe('Europe/Berlin')
    expect(r.exitZone).toHaveBeenCalledWith(proxy)
    expect(r.logged).toEqual([])
    expect(await zoneOf('a2', { ...defaultSettings(host), proxy })).toBe('Asia/Ho_Chi_Minh')
    expect(r.logged).toEqual([expect.stringContaining('zone')])
    expect(r.logged.join('\n')).not.toContain(proxy.password)
    expect(await zoneOf('a3', defaultSettings(host))).toBe('Asia/Ho_Chi_Minh')
    expect(await zoneOf('a4', { ...defaultSettings(host), proxy, timeZone: 'America/New_York' })).toBe('America/New_York')
    expect(r.exitZone).toHaveBeenCalledTimes(2)
  })

  it('a dropped limit is counted', async () => {
    const r = rig()
    r.containers.start.mockImplementationOnce(async (agentId: string) => { r.running.add(agentId); return { limitsDropped: ['memory'] } })
    await r.browsers.start('a1')
    expect(r.measured).toEqual(['agent_browser_limit_dropped', 'agent_browser_start_ok'])
  })

  it('reconcile catches an exit the event stream missed', async () => {
    const r = rig()
    await r.browsers.start('a1')
    await r.browsers.start('a2')
    r.vanish('a1', 137)
    await r.browsers.reconcile()
    await settle()
    expect(shown(r, 'a1')).toBe('starting')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(shown(r, 'a1')).toBe('ready')
    expect(r.containers.start).toHaveBeenCalledTimes(3)
    r.containers.running.mockRejectedValueOnce(new PodmanError('podman_failed', 'podman ps timed out after 30000 ms'))
    await r.browsers.reconcile()
    expect(r.logged.at(-1)).toContain('timed out')
  })

  it('a listing that keeps failing is logged once, until one works again', async () => {
    const r = rig()
    r.containers.running.mockRejectedValue(new PodmanError('podman_failed', 'podman ps failed: machine is not running'))
    for (let i = 0; i < 3; i++) await r.browsers.reconcile()
    expect(r.logged).toEqual([expect.stringContaining('machine is not running')])
    r.containers.running.mockResolvedValueOnce([])
    await r.browsers.reconcile()
    await r.browsers.reconcile()
    expect(r.logged).toHaveLength(2)
  })
})
