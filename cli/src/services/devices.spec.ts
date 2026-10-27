// The devices (services/devices.ts): what the core tells them reaches the dial and the window bridges, what
// they say reaches the core through its API alone, and the fleet failing costs the dial nothing.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CableHostWiring } from '../cable/cableHost.js'
import { env } from '../config/env.js'
import { emptyPorts, ServiceUnavailableError, type CoreApi, type CorePorts, type DevicesPort } from '../core/api.js'
import type { FleetEvent } from '../cable/machineFleet.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import type { Fleet, FleetDeps } from './fleet.js'
import type { DevicesDeps } from './devices.js'

const seen = vi.hoisted(() => ({
  host: null as unknown as CableHostWiring,
  dial: null as unknown as { onDialStatus(status: unknown): void },
  cable: null as unknown as { args: unknown[]; calls: Array<[string, unknown[]]>; setSettings: (id: string, patch: unknown) => Promise<{ ok: boolean; error?: string }> },
  bridges: {} as Record<string, { wiring: Record<string, (...args: unknown[]) => unknown>; calls: Array<[string, unknown[]]> }>,
  fleet: null as null | { deps: FleetDeps; events: ((event: FleetEvent) => void) | null; fail: boolean },
  voice: { sessions: vi.fn(), connected: vi.fn(), shutdown: vi.fn() },
}))

vi.mock('../cable/cableHost.js', async (real) => {
  const actual = await real<typeof import('../cable/cableHost.js')>()
  return {
    ...actual,
    DaemonCableHost: class extends actual.DaemonCableHost {
      constructor(wiring: CableHostWiring) { super(wiring); seen.host = wiring; seen.dial = this }
    },
  }
})
vi.mock('../cable/cableFleet.js', async (real) => {
  const actual = await real<typeof import('../cable/cableFleet.js')>()
  const recorder = (name: string) => function (this: { calls: Array<[string, unknown[]]> }, ...args: unknown[]) { this.calls.push([name, args]); return Promise.resolve() }
  class FakeCable {
    calls: Array<[string, unknown[]]> = []
    args: unknown[]
    constructor(...args: unknown[]) { this.args = args; seen.cable = this as never }
    start = recorder('start')
    stop = recorder('stop')
    syncAgents = recorder('syncAgents')
    syncSwarms = recorder('syncSwarms')
    syncSwarmCards = recorder('syncSwarmCards')
    swarmCardRecap = recorder('swarmCardRecap')
    syncMachines = recorder('syncMachines')
    followApp = recorder('followApp')
    replaceNotifications = recorder('replaceNotifications')
    agentSeen = recorder('agentSeen')
    question = recorder('question')
    questionClose = recorder('questionClose')
    turnStarted = recorder('turnStarted')
    turnStep = recorder('turnStep')
    turnReply = recorder('turnReply')
    turnDone = recorder('turnDone')
    turnStats = recorder('turnStats')
    summary = recorder('summary')
    turnError = recorder('turnError')
    petsChanged = recorder('petsChanged')
    wants = true
    connected = true
    get isConnected() { return this.connected }
    wantsStats() { return this.wants }
    petDial = () => ({ supported: false, held: [] as string[], sending: null })
    setSettings = vi.fn(async (id: string, _patch: unknown) => (id === 'usb' ? { ok: true } : { ok: false, error: 'That device is not plugged into this computer.' }))
  }
  return { ...actual, CableFleet: FakeCable }
})
// The window bridges: their wiring is what the devices give them; their own behaviour has its own specs.
for (const [path, name] of [['../cable/windowSelection.js', 'WindowSelection'], ['../cable/windowVisit.js', 'WindowVisit'], ['../cable/windowForm.js', 'WindowForm']] as const) {
  vi.doMock(path, () => ({
    [name]: class {
      calls: Array<[string, unknown[]]> = []
      constructor(wiring: Record<string, (...args: unknown[]) => unknown>) { seen.bridges[name] = { wiring, calls: this.calls } }
      command(...args: unknown[]) { this.calls.push(['command', args]); return Promise.resolve({ ok: true }) }
      cancel(...args: unknown[]) { this.calls.push(['cancel', args]) }
      clear(...args: unknown[]) { this.calls.push(['clear', args]) }
      reply(...args: unknown[]) { this.calls.push(['reply', args]) }
      focusChanged(...args: unknown[]) { this.calls.push(['focusChanged', args]) }
      disconnected(...args: unknown[]) { this.calls.push(['disconnected', args]) }
    },
  }))
}
vi.mock('../cable/windowRoute.js', () => ({
  createWindowRouter: (wiring: Record<string, (...args: unknown[]) => unknown>) => {
    const calls: Array<[string, unknown[]]> = []
    seen.bridges.WindowRouter = { wiring, calls }
    return {
      ask: (...args: unknown[]) => { calls.push(['ask', args]); return Promise.resolve({ t: 'unavailable' }) },
      reply: (...args: unknown[]) => { calls.push(['reply', args]) },
    }
  },
}))
vi.mock('./fleet.js', async (real) => {
  const actual = await real<typeof import('./fleet.js')>()
  return {
    ...actual,
    startFleet: (_core: CoreApi, deps: FleetDeps) => {
      const state = { deps, events: null as ((event: FleetEvent) => void) | null, fail: false }
      seen.fleet = state
      const fleet = new Proxy({} as Fleet, {
        get: (_t, key) => {
          if (key === 'onEvent') return (listener: (event: FleetEvent) => void) => { state.events = listener; return () => {} }
          if (key === 'routeTask') return async (text: string) => ({ agentId: 'a1', machineId: 'm1', name: 'api', confidence: 1, reason: text, candidates: [], weighed: 1, machines: 1, via: 'model' })
          if (key === 'routeSend') return (agentId: string) => agentId === 'far' ? { ok: false, machine: 'mac-mini', reason: 'the last request to it did not come back' }
            : agentId === 'nameless' ? { ok: false, machine: '', reason: 'no such agent' } : { ok: true }
          if (key === 'knows') return () => { if (state.fail) throw new Error('lost'); return true }
          if (key === 'stop') return vi.fn()
          // Any other routing member: unanswered here, and failing once the test says the fleet fails.
          return () => { if (state.fail) throw new Error('lost') }
        },
      })
      return { fleet, router: null }
    },
  }
})
vi.mock('../lib/voiceRouter.js', () => ({
  setVoiceRouterSessions: seen.voice.sessions,
  setVoiceRouterDeviceConnected: seen.voice.connected,
  shutdownVoiceRouter: seen.voice.shutdown,
  routeVoiceTask: vi.fn(),
}))

const jevMade = vi.hoisted(() => vi.fn())
vi.mock('../lib/jev/jevClient.js', async (orig) => {
  const actual = await orig<typeof import('../lib/jev/jevClient.js')>()
  return {
    ...actual,
    createJevDecide: (options: Parameters<typeof actual.createJevDecide>[0]) => {
      jevMade(options)
      // Keep the real hosted request and answer parsing, without discovering a key or calling OpenRouter.
      return actual.createJevDecide({ ...options, key: async () => null })
    },
  }
})

const { startDevices } = await import('./devices.js')

let dataDir: string
let logs: string[]
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'devices-'))
  logs = []
  seen.bridges = {}
  seen.fleet = null
  vi.clearAllMocks()
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function start(over: { core?: CoreApi; faults?: string[]; cableDisabled?: boolean; testDialPort?: string; readUsage?: DevicesDeps['readUsage']; now?: () => number; decideTier?: DevicesDeps['decideTier'] | null } = {}) {
  const core = over.core ?? fakeCore({ dataDir })
  const ports: CorePorts = emptyPorts()
  const onExit = vi.fn()
  const reconnected: Array<() => void> = []
  const requests = startDevices(core, ports, {
    logsDir: join(dataDir, 'logs'),
    petsDir: join(dataDir, 'pets'),
    dialSerials: ['E2E'],
    testDialPort: over.testDialPort,
    cableDisabled: over.cableDisabled,
    readUsage: over.readUsage,
    now: over.now,
    decideTier: over.decideTier === null ? undefined : over.decideTier ?? (async () => ({ tier: 'alert', by: 'test', detail: '', ms: 0 })),
    faults: new Set(over.faults ?? []),
    log: (line) => { logs.push(line) },
    onExit,
    onCoreConnected: (run) => { reconnected.push(run) },
  })
  return { core, ports, port: ports.devices as DevicesPort, requests, onExit, reconnected }
}

const calls = (name: string) => seen.cable.calls.filter(([called]) => called === name).map(([, args]) => args)

describe('the devices, as the core starts them', () => {
  it('fill the devices port, start the dial, and stop the voice router\'s worker with the process', () => {
    const { ports, onExit } = start()
    expect(ports.devices).not.toBeNull()
    expect(calls('start')).toHaveLength(1)
    expect(seen.cable.args[2]).toBe(join(dataDir, 'logs'))
    expect(seen.cable.args[4]).toMatchObject({ serials: ['E2E'] })
    onExit.mock.calls[0][0]()
    expect(seen.voice.shutdown).toHaveBeenCalled()
  })

  it('keep the custom pets where petsDir says, and under HARNESS_DEVICES_DIR/pets by default', () => {
    const dir = join(dataDir, 'pets')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pets.json'), JSON.stringify({ all: 'a'.repeat(16), engines: {} }))
    start()
    expect(seen.host.pets!()!.mapping()).toEqual({ all: 'a'.repeat(16), engines: {} })
    // Without the option the store sits under env.HARNESS_DEVICES_DIR (never a path hard-coded in the service).
    const was = env.HARNESS_DEVICES_DIR
    ;(env as { HARNESS_DEVICES_DIR: string }).HARNESS_DEVICES_DIR = join(dataDir, 'home-devices')
    try {
      mkdirSync(join(dataDir, 'home-devices', 'pets'), { recursive: true })
      writeFileSync(join(dataDir, 'home-devices', 'pets', 'pets.json'), JSON.stringify({ all: 'b'.repeat(16), engines: {} }))
      startDevices(fakeCore({ dataDir }), emptyPorts(), { logsDir: join(dataDir, 'logs'), cableDisabled: true, log: () => {}, onExit: vi.fn() })
      expect(seen.host.pets!()!.mapping().all).toBe('b'.repeat(16))
    } finally {
      ;(env as { HARNESS_DEVICES_DIR: string }).HARNESS_DEVICES_DIR = was
    }
  })

  it('leave the serial ports alone when told to, and find the end-to-end suite\'s dial where it says', async () => {
    start({ cableDisabled: true, testDialPort: '/dev/ttys042' })
    expect(calls('start')).toHaveLength(0)
    expect(logs).toContain('[cable] disabled (CABLE_DISABLE=true) — the serial port is left alone')
    const options = seen.cable.args[4] as { discover: () => Promise<unknown[]> }
    expect(await options.discover()).toEqual([expect.objectContaining({ path: '/dev/ttys042' })])
  })

  it('cut an old dial log down to a pointer, and carry on when it cannot be written', () => {
    writeFileSync(join(dataDir, 'dial.log'), 'years of lines')
    start()
    expect(readFileSync(join(dataDir, 'dial.log'), 'utf8')).toBe(`moved to ${join(dataDir, 'logs', 'dial-YYYYMMDD.log')}\n`)
    rmSync(join(dataDir, 'dial.log'))
    mkdirSync(join(dataDir, 'dial.log'))
    expect(() => start()).not.toThrow()
  })

  it('log to the console by default, and register the worker\'s stop on the process\'s exit', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const once = vi.spyOn(process, 'once').mockImplementation(() => process)
    startDevices(fakeCore({ dataDir }), emptyPorts(), { logsDir: dataDir, cableDisabled: true })
    expect(log).toHaveBeenCalledWith('[cable] disabled (CABLE_DISABLE=true) — the serial port is left alone')
    expect(once).toHaveBeenCalledWith('exit', expect.any(Function))
  })
})

describe('the dial\'s host, wired to the core', () => {
  it('reads the agents, this computer and the sign-in from the core, and reports a dial attached', async () => {
    const agent = { agentId: 'a1', engine: 'claude' } as RegisteredSession
    const core = fakeCore({ dataDir, agents: { advertised: vi.fn(() => [agent]), displayName: vi.fn(() => 'api'), activityText: vi.fn(async () => 'Reading'), runtimeProfile: vi.fn(() => 'p') } })
    start({ core })
    const w = seen.host
    expect(w.sessions()).toEqual([agent])
    expect(w.displayName(agent)).toBe('api')
    expect(await w.activityText!('a1')).toBe('Reading')
    expect(w.machineName()).toBe('This machine')
    expect(w.machineId()).toBe('machine-1')
    expect(w.computerId()).toBe('computer-1')
    expect(w.signedIn!()).toBe(true)
    expect(await w.accessToken!({ force: true })).toBe('token')
    expect(core.account.accessToken).toHaveBeenCalledWith({ force: true })
    expect(w.environment!()).toBe('prod')
    w.watching!(true)
    expect(core.clients.dialWatching).toHaveBeenCalledWith(true)
    expect(w.runtimeProfile!(agent)).toBe('p')
    w.log('cable: hello')
    expect(logs).toContain('[cable] cable: hello')
  })

  it('reaches an agent here through the core\'s own doors', async () => {
    const { core } = start()
    const w = seen.host
    w.sendTurn('a1', 'hello')
    w.stopTurn('a1')
    w.answer('a1', 'r1', { q: 'Coffee' })
    await w.answerReviewed!({ agentId: 'a1' } as never)
    w.recent('a1', 3)
    w.recentAsks('a1')
    w.updateAgent!('a1', 'opus', 'high')
    await w.listModels!('a1')
    await w.forkAgent!('a1')
    expect(core.turns.send).toHaveBeenCalledWith('a1', 'hello')
    expect(core.turns.stop).toHaveBeenCalledWith('a1')
    expect(core.questions.answer).toHaveBeenCalledWith('a1', 'r1', { q: 'Coffee' })
    expect(core.questions.answerReviewed).toHaveBeenCalledWith({ agentId: 'a1' })
    expect(core.turns.recent).toHaveBeenCalledWith('a1', 3)
    expect(core.turns.asks).toHaveBeenCalledWith('a1')
    expect(core.agents.setRuntime).toHaveBeenCalledWith('a1', 'opus', 'high')
    expect(core.agents.runtimeModels).toHaveBeenCalledWith('a1')
    expect(core.agents.fork).toHaveBeenCalledWith('a1')
    // A Super Tab wait is shown, never answered: nothing reaches the pane.
    w.answer('a1', 'supertab:as-1:needs_human', { q: 'Yes' })
    expect(await w.answerReviewed!({ agentId: 'a1', requestId: 'supertab:as-1:needs_human' } as never)).toBe(false)
    expect(core.questions.answer).toHaveBeenCalledTimes(1)
    expect(core.questions.answerReviewed).toHaveBeenCalledTimes(1)
  })

  it('tells the windows on this computer what a hand at this desk did, and the owner\'s apps the device status', () => {
    const { core } = start()
    const w = seen.host
    w.opened!('m1', 'a1')
    w.opened!('m1', 'a1', 'question')
    w.notificationRead!('m1', 'a1', 'tok')
    w.forked!('m1', 'a2', 'a1')
    w.focused!('m1', 'a1')
    w.swarmSelected!('t2')
    w.scrolled!('move', 4, 120)
    w.scrolled!('move', -6, 0, 'st1')
    w.dialStatus!({ attached: true, fw: '1.2.3' })
    w.dialStatus!({ attached: false })
    expect(vi.mocked(core.clients.sendLocal).mock.calls.map(([frame]) => frame)).toEqual([
      { type: 'dial_open', payload: { machineId: 'm1', agentId: 'a1' } },
      { type: 'dial_open', payload: { machineId: 'm1', agentId: 'a1', reason: 'question' } },
      { type: 'dial_notification_read', payload: { machineId: 'm1', agentId: 'a1', readToken: 'tok' } },
      { type: 'dial_forked', payload: { machineId: 'm1', agentId: 'a2', sourceAgentId: 'a1' } },
      { type: 'dial_focus', payload: { machineId: 'm1', agentId: 'a1' } },
      { type: 'dial_swarm', payload: { swarmId: 't2' } },
      { type: 'dial_scroll', payload: { phase: 'move', dy: 4, velocity: 120 } },
      { type: 'dial_scroll', payload: { phase: 'move', dy: -6, velocity: 0, superTabId: 'st1' } },
      { type: 'dial_status', payload: { attached: true, fw: '1.2.3' } },
      { type: 'dial_status', payload: { attached: false } },
    ])
    expect(vi.mocked(core.clients.devicesChanged).mock.calls).toEqual([
      [{ status: { attached: true, fw: '1.2.3' }, revision: 1 }],
      [{ status: { attached: false }, revision: 2 }],
    ])
  })

  it('speaks to the window through its bridges, and routes through the fleet', async () => {
    const { core } = start()
    const w = seen.host
    await w.routeInWindow!('fix it', 'review')
    await w.selectPassage!({ agentId: 'a1', op: 'begin' })
    w.clearSelection!()
    await w.visit!({ agentId: 'a1', op: 'open' } as never)
    w.clearVisit!()
    await w.form!({ op: 'open' } as never)
    w.clearForm!()
    expect(seen.bridges.WindowRouter.calls).toEqual([['ask', ['fix it', 'review']]])
    expect(seen.bridges.WindowSelection.calls.map(([name]) => name)).toEqual(['command', 'cancel'])
    expect(seen.bridges.WindowVisit.calls.map(([name]) => name)).toEqual(['command', 'cancel'])
    expect(seen.bridges.WindowForm.calls.map(([name]) => name)).toEqual(['command', 'clear'])
    expect(w.fleet!()).not.toBeNull()
    void core
  })
})

describe('the window bridges, wired to the core', () => {
  it('ask the window with the focus the core last gave, one window at a time', () => {
    const { core, port } = start()
    const { WindowSelection: selection, WindowVisit: visit, WindowForm: form, WindowRouter: router } = seen.bridges
    expect(selection.wiring.focus()).toBeUndefined()
    expect(visit.wiring.focus()).toBeUndefined()
    expect(form.wiring.focus()).toBeUndefined()
    expect(seen.host.appFocus!()).toBeUndefined()
    port.windowFocus({ voice: { machineId: 'm1', agentId: 'a1', connId: 'w1' }, form: { machineId: 'm1', connId: 'w1' } })
    expect(seen.host.appFocus!()).toMatchObject({ machineId: 'm1', agentId: 'a1' })
    expect(calls('followApp')).toEqual([['m1', 'a1']])
    expect(selection.wiring.focus()).toEqual({ machineId: 'm1', agentId: 'a1', connId: 'w1' })
    expect(visit.wiring.focus()).toEqual({ machineId: 'm1', agentId: 'a1', connId: 'w1' })
    expect(form.wiring.focus()).toEqual({ machineId: 'm1', connId: 'w1' })
    selection.wiring.send('w1', { op: 'begin' })
    visit.wiring.send('w1', { op: 'open' })
    form.wiring.send('w1', { op: 'open' })
    expect(vi.mocked(core.clients.sendToWindow).mock.calls).toEqual([
      ['w1', { type: 'dial_selection', payload: { op: 'begin' } }],
      ['w1', { type: 'dial_visit', payload: { op: 'open' } }],
      ['w1', { type: 'dial_form', payload: { op: 'open' } }],
    ])
    form.wiring.log('form: opened')
    router.wiring.log('route: asked')
    expect(logs).toEqual(expect.arrayContaining(['[cable] form: opened', '[cable] route: asked']))
    expect(router.wiring.hasWindow()).toBe(true)
    router.wiring.send('v1', 'fix it', undefined)
    router.wiring.send('v2', 'fix it', 'review')
    expect(vi.mocked(core.clients.sendLocal).mock.calls.map(([frame]) => frame)).toEqual([
      { type: 'voice_route_request', payload: { voiceId: 'v1', text: 'fix it' } },
      { type: 'voice_route_request', payload: { voiceId: 'v2', text: 'fix it', cmd: 'review' } },
    ])
    expect(logs).toContain('[route] voice → the window · 6 bytes · /review')
    port.windowFocus({ voice: null, form: null })
    expect(seen.host.appFocus!()).toBeUndefined()
    expect(calls('followApp')).toEqual([['m1', 'a1']])
  })

  it('hand each window\'s answer to its bridge, and tell them a window left', () => {
    const { port } = start()
    port.windowReply('selection', 'w1', 'm1', { a: 1 })
    port.windowReply('visit', 'w1', 'm1', { b: 2 })
    port.windowReply('form', 'w1', 'm1', { c: 3 })
    port.voiceReply('v1', { t: 'taken' })
    port.windowGone('w1')
    expect(seen.bridges.WindowSelection.calls).toEqual([['reply', ['w1', 'm1', { a: 1 }]], ['focusChanged', []]])
    expect(seen.bridges.WindowVisit.calls).toEqual([['reply', ['w1', 'm1', { b: 2 }]]])
    expect(seen.bridges.WindowForm.calls).toEqual([['reply', ['w1', 'm1', { c: 3 }]], ['disconnected', ['w1']]])
    expect(seen.bridges.WindowRouter.calls).toEqual([['reply', ['v1', { t: 'taken' }]]])
  })
})

describe('what the windows say, reaching the dial', () => {
  it('pushes a changed desk at once, and only a changed one, and says whether a tile is on screen', async () => {
    const { port } = start()
    port.desk(['a1', 'a2'], true)
    port.desk(['a1', 'a2'], true)
    port.desk(['a2', 'a1'], true)
    expect(calls('syncAgents')).toHaveLength(2)
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'done', recap: 'fixed it' } })
    port.desk(['a2', 'a1'], false)
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'done' } })
    port.card({ type: 'commander_event', agentId: 'a9', payload: { kind: 'summary', text: 'done', subagent: true } })
    await vi.waitFor(() => expect(calls('summary')).toHaveLength(3))
    // The one that asked the decider lands last: the other two never wait.
    expect(calls('summary')).toEqual([['a1', 'fixed it', 'done', 'silent', undefined, false], ['a9', 'done', 'done', 'silent', undefined, true], ['a1', 'done', 'done', 'alert', undefined, false]])
  })

  describe('a summary\'s tier', () => {
    afterEach(() => { delete process.env.HARNESS_NOTIFY_SMART })
    it('builds the default decider without Jev when HARNESS_NOTIFY_SMART is 0, and with it otherwise', () => {
      process.env.HARNESS_NOTIFY_SMART = '0'
      start({ decideTier: null })
      expect(jevMade).not.toHaveBeenCalled()
      delete process.env.HARNESS_NOTIFY_SMART
      start({ decideTier: null })
      expect(jevMade).toHaveBeenCalledTimes(1)
    })

    it('asks the signed-in backend for a default tier, sends its answer to the dial, and tallies it', async () => {
      delete process.env.HARNESS_NOTIFY_SMART
      const backend = vi.fn(async () => ({ status: 200, body: { data: { answers: {
        tier: { choice: 'alert', probabilities: { alert: 0.8, list: 0.15, silent: 0.05 } },
      } } } }))
      const core = fakeCore({ dataDir, account: { backend } })
      const { port } = start({ core, decideTier: null })
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'done', recap: 'The requested build is ready.' } })
      await vi.waitFor(() => expect(calls('summary')).toEqual([
        ['a1', 'The requested build is ready.', 'done', 'alert', undefined, false],
      ]))
      expect(backend).toHaveBeenCalledExactlyOnceWith('POST', '/api/route/jev', {
        state: {
          agent: 'an agent', recap: 'The requested build is ready.', turn: 'duration unknown',
          recent: '0 alerts and 0 list entries in the last 30 minutes',
        },
        questions: { tier: {
          type: 'choice', instructions: expect.any(String),
          criteria: { alert: expect.any(String), list: expect.any(String), silent: expect.any(String) },
        } },
      })
      expect(logs).toContainEqual(expect.stringMatching(/^\[cable\] notify · .* · alert · jev · p=alert=0\.80,list=0\.15,silent=0\.05 · \d+ms$/))
      expect(logs).toContainEqual(expect.stringMatching(/^\[cable\] notify · day \d{4}-\d\d-\d\d · alert 1 · list 0 · silent 0$/))
    })

    it('keeps a recap in the list when the decider rejects', async () => {
      const { port } = start({ decideTier: async () => { throw new Error('decision unavailable') } })
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'done', recap: 'The requested build is ready.', fullText: 'The full build report.' } })
      await vi.waitFor(() => expect(calls('summary')).toEqual([
        ['a1', 'The requested build is ready.', 'done', 'list', 'The full build report.', false],
      ]))
    })

    it('keeps the next turn behind a recap still waiting on the decider', async () => {
      vi.useFakeTimers()
      try {
        const decideTier = vi.fn(() => new Promise<{ tier: 'alert'; by: string; detail: string; ms: number }>((r) => setTimeout(() => r({ tier: 'alert', by: 't', detail: '', ms: 0 }), 500)))
        const { port } = start({ decideTier })
        port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'done', text: 'done' } })
        port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'done', recap: 'r' } })
        port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'processing', text: 'next' } })
        await vi.advanceTimersByTimeAsync(100)
        expect(seen.cable.calls.map(([n]) => n).filter((n) => n === 'summary' || n === 'turnStarted')).toEqual([])
        await vi.advanceTimersByTimeAsync(600)
        expect(seen.cable.calls.map(([n]) => n).filter((n) => n === 'summary' || n === 'turnStarted')).toEqual(['summary', 'turnStarted'])
      } finally { vi.useRealTimers() }
    })

    it('does not let a sub-agent\'s summary use up the main turn\'s numbers, and times a restarted turn afresh', async () => {
      const decideTier = vi.fn(async (_i: { durationS: number | null }) => ({ tier: 'alert' as const, by: 't', detail: '', ms: 0 }))
      const { port } = start({ decideTier })
      const card = (kind: string, extra = {}) => port.card({ type: 'commander_event', agentId: 'a1', payload: { kind, text: 'x', ...extra } })
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(0); card('processing')
        vi.setSystemTime(60_000); card('done')
        card('summary', { subagent: true })
        card('summary', { recap: 'first' })
        await vi.waitFor(() => expect(calls('summary')).toHaveLength(2))
        vi.setSystemTime(100_000); card('processing')
        await vi.waitFor(() => expect(calls('turnStarted')).toHaveLength(2))
        vi.setSystemTime(110_000); card('done')
        await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(2))
        card('summary', { recap: 'second' })
        await vi.waitFor(() => expect(decideTier).toHaveBeenCalledTimes(2))
      } finally { vi.useRealTimers() }
      expect(decideTier.mock.calls.map(([i]) => i.durationS)).toEqual([60, 10])
    })

    it('follows a tier the recaps already decided, asking nobody again, and still silences the agent on screen', () => {
      const decideTier = vi.fn()
      const { port } = start({ decideTier })
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'done', recap: 'Deployed', tier: 'list' } })
      expect(calls('summary')).toEqual([['a1', 'Deployed', 'done', 'list', undefined, false]])
      expect(decideTier).not.toHaveBeenCalled()
      expect(logs).toContainEqual(expect.stringMatching(/^\[cable\] notify · .* · list · recaps · decided upstream · 0ms$/))
      port.desk(['a2'], true)
      port.card({ type: 'commander_event', agentId: 'a2', payload: { kind: 'summary', text: 'done', tier: 'alert' } })
      expect(calls('summary').at(-1)).toEqual(['a2', 'done', 'done', 'silent', undefined, false])
      expect(decideTier).not.toHaveBeenCalled()
    })

    const summaryCalls = () => calls('summary')
    it('is silent without asking Jev when the agent is on screen or the turn was a sub-agent\'s', () => {
      const decideTier = vi.fn()
      const { port } = start({ decideTier })
      port.desk(['a1'], true)
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'done' } })
      port.card({ type: 'commander_event', agentId: 'a9', payload: { kind: 'summary', text: 'done', subagent: true } })
      expect(summaryCalls()).toEqual([['a1', 'done', 'done', 'silent', undefined, false], ['a9', 'done', 'done', 'silent', undefined, true]])
      expect(decideTier).not.toHaveBeenCalled()
    })

    it('never asks the decider while no device is connected, and still draws the tile', () => {
      const decideTier = vi.fn()
      const { port } = start({ decideTier })
      ;(seen.cable as unknown as { connected: boolean }).connected = false
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'done', recap: 'fixed it' } })
      expect(decideTier).not.toHaveBeenCalled()
      expect(summaryCalls()).toEqual([['a1', 'fixed it', 'done', 'silent', undefined, false]])
    })

    it('tells the decider a failed cloud summary failed, and logs rule decisions with the day\'s count', async () => {
      const decideTier = vi.fn(async () => ({ tier: 'alert' as const, by: 't', detail: '', ms: 0 }))
      const { port } = start({ decideTier })
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'x', recap: 'r', failed: true } })
      await vi.waitFor(() => expect(decideTier).toHaveBeenCalledWith(expect.objectContaining({ failed: true })))
      port.desk(['a2'], true)
      port.card({ type: 'commander_event', agentId: 'a2', payload: { kind: 'summary', text: 'x' } })
      port.card({ type: 'commander_event', agentId: 'a2', payload: { kind: 'error', text: 'boom' } })
      expect(logs.some((l) => /notify · .* · silent · rule:onScreen · onScreen · 0ms/.test(l))).toBe(true)
      expect(logs.some((l) => /notify · .* · alert · rule:failed/.test(l))).toBe(true)
      expect(logs.some((l) => /notify · day \d{4}-\d\d-\d\d · alert 1 · list 0 · silent 1/.test(l))).toBe(true)
    })

    it('is the decider\'s, asked with the duration and stats of the turn that just ended', async () => {
      const decideTier = vi.fn(async () => ({ tier: 'list' as const, by: 'test', detail: '', ms: 0 }))
      const { port } = start({ decideTier })
      vi.useFakeTimers()
      try {
        vi.setSystemTime(1_000_000)
        port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'processing', text: 'go' } })
        vi.setSystemTime(1_000_000 + 95_000)
        port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'done', text: 'done' } })
      } finally { vi.useRealTimers() }
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'done', recap: 'fixed it' } })
      await vi.waitFor(() => expect(summaryCalls()).toHaveLength(1))
      expect(decideTier).toHaveBeenCalledWith(expect.objectContaining({ recap: 'fixed it', durationS: 95, onScreen: false, subagent: false }))
      expect(summaryCalls()[0].slice(0, 4)).toEqual(['a1', 'fixed it', 'done', 'list'])
    })
  })

  it('passes the tabs, the unread rows, the window\'s focus and what it saw', () => {
    const { port } = start()
    port.swarms({ active: 't1', swarms: [], tiles: [] })
    port.unread([{ agentId: 'a1', machineId: 'm1', text: 'done', question: false }])
    port.appFocus('m1', 'a1')
    port.seen('a1', 'tok')
    expect(seen.cable.calls.map(([name]) => name)).toEqual(['start', 'syncSwarms', 'syncAgents', 'syncSwarmCards', 'replaceNotifications', 'followApp', 'agentSeen'])
    expect(calls('followApp')).toEqual([['m1', 'a1']])
    expect(calls('agentSeen')).toEqual([['a1', 'tok']])
  })

  describe('the Swarm cards for a Harness Pro', () => {
    const lead = { id: 'lead1', projectId: 'proj1', project: 'mobile', engine: 'claude', owner: '', local: '', state: 'work' as const, order: 0 }
    const cards = [{ id: 'st1', name: 'openharness', count: 1, leads: [lead] }]
    const withRequest = (superTabRequest?: CoreApi['superTabRequest']) => start({ core: { ...fakeCore({ dataDir }), ...(superTabRequest ? { superTabRequest } : {}) } as CoreApi })

    it('keeps the list for the cable and tells every device when it changes; a recap is passed on', () => {
      const { port } = start()
      port.swarmCards(cards)
      expect(seen.dial).toMatchObject({ cards })
      expect(calls('syncSwarmCards')).toEqual([[]])
      const recap = { tabId: 'st1', leadId: 'lead1', text: 'hi', at: 1, none: false }
      port.swarmCardRecap(recap)
      expect(calls('swarmCardRecap')).toEqual([[recap]])
    })

    it('asks the service for cards when the first capable device attaches and stops when the last leaves', () => {
      const superTabRequest = vi.fn(async () => ({ ok: true }))
      withRequest(superTabRequest)
      seen.host.swarmCardsWanted!(true)
      seen.host.swarmCardsWanted!(true)
      expect(superTabRequest.mock.calls).toEqual([[{ action: 'cardsWanted', on: true, include: [] }]])
      seen.host.swarmCardsWanted!(false)
      expect(superTabRequest).toHaveBeenCalledTimes(1)
      seen.host.swarmCardsWanted!(false)
      expect(superTabRequest.mock.calls[1]).toEqual([{ action: 'cardsWanted', on: false, include: [] }])
      // A stray "gone" never counts below none.
      seen.host.swarmCardsWanted!(false)
      seen.host.swarmCardsWanted!(true)
      expect(superTabRequest.mock.calls[2]).toEqual([{ action: 'cardsWanted', on: true, include: [] }])
    })

    it('sends the Swarms the desktop has tabs for with the wish, again when they change, and says it all again when the core reconnects', () => {
      const superTabRequest = vi.fn(async () => ({ ok: true }))
      const { port, reconnected } = withRequest(superTabRequest)
      const tabs = (...ids: string[]) => ({ active: 'a', tiles: [], swarms: [{ id: 'plain', name: 'plain', agentIds: [], panes: 0 }, ...ids.map((id) => ({ id: `tab-${id}`, name: id, agentIds: [], panes: 0, superTabId: id }))] })
      // Nobody wants cards yet: nothing is said, but the tabs are remembered.
      port.swarms(tabs('st1', 'st2', 'st1'))
      expect(superTabRequest).not.toHaveBeenCalled()
      seen.host.swarmCardsWanted!(true)
      expect(superTabRequest).toHaveBeenLastCalledWith({ action: 'cardsWanted', on: true, include: ['st1', 'st2'] })
      port.swarms(tabs('st1', 'st2'))
      expect(superTabRequest).toHaveBeenCalledTimes(1)
      port.swarms(tabs('st2'))
      expect(superTabRequest).toHaveBeenLastCalledWith({ action: 'cardsWanted', on: true, include: ['st2'] })
      // The window gone leaves no Swarm tab to read first.
      port.swarms(null)
      expect(superTabRequest).toHaveBeenLastCalledWith({ action: 'cardsWanted', on: true, include: [] })
      port.swarms(tabs('st2'))
      // A core that connects anew has forgotten: the current count is said again, and nothing with no device.
      superTabRequest.mockClear()
      reconnected.forEach((run) => run())
      expect(superTabRequest.mock.calls).toEqual([[{ action: 'cardsWanted', on: true, include: ['st2'] }]])
      seen.host.swarmCardsWanted!(false)
      superTabRequest.mockClear()
      reconnected.forEach((run) => run())
      expect(superTabRequest).not.toHaveBeenCalled()
    })

    it('reads a recap through the service, cut to 1,500 bytes on a character; anything unusable is null', async () => {
      const answers: Array<Record<string, unknown> | 'throw'> = [
        { ok: true, tabId: 'st1', leadId: 'lead1', text: 'é'.repeat(1000), at: 1792560000, none: false },
        { ok: true, text: 'none', at: 0, none: true },
        { error: 'NOT_FOUND' }, { ok: true, text: 5, at: 1, none: false }, { ok: true, text: 'x', at: 1.5, none: false },
        { ok: true, text: 'x', at: -1, none: false }, { ok: true, text: 'x', at: 1, none: 'no' }, 'throw',
      ]
      const superTabRequest = vi.fn(async () => { const next = answers.shift()!; if (next === 'throw') throw new Error('gone'); return next })
      withRequest(superTabRequest)
      const got = await seen.host.swarmCardRecap!('st1', 'lead1')
      expect(superTabRequest).toHaveBeenCalledWith({ action: 'cardRecap', tabId: 'st1', leadId: 'lead1' })
      expect(got).toMatchObject({ tabId: 'st1', leadId: 'lead1', at: 1792560000, none: false })
      expect(got!.text).toBe('é'.repeat(750))
      expect(await seen.host.swarmCardRecap!('st1', 'lead2')).toEqual({ tabId: 'st1', leadId: 'lead2', text: 'none', at: 0, none: true })
      for (let i = 0; i < 6; i++) expect(await seen.host.swarmCardRecap!('st1', 'lead1')).toBeNull()
    })

    it('posts words for a Lead through the service; anything but said: true sends the turn instead', async () => {
      const answers: Array<Record<string, unknown> | 'throw'> = [{ ok: true, said: true }, { ok: true, said: false }, { error: 'NOT_FOUND' }, 'throw']
      const superTabRequest = vi.fn(async () => { const next = answers.shift()!; if (next === 'throw') throw new Error('gone'); return next })
      withRequest(superTabRequest)
      expect(await seen.host.swarmSay!('h1', 'ship it')).toBe(true)
      expect(superTabRequest).toHaveBeenCalledWith({ action: 'cardSay', harnessId: 'h1', text: 'ship it' })
      for (let i = 0; i < 3; i++) expect(await seen.host.swarmSay!('h1', 'ship it')).toBe(false)
    })

    it('posts words in a Swarm conversation through the service and hands back why one did not go', async () => {
      const answers: Array<Record<string, unknown> | 'throw'> = [{ ok: true, posted: true }, { ok: true, posted: false, error: 'That conversation is archived.' },
        { ok: true, posted: false }, { error: 'OWNER_REQUIRED' }, 'throw']
      const superTabRequest = vi.fn(async () => { const next = answers.shift()!; if (next === 'throw') throw new Error('gone'); return next })
      withRequest(superTabRequest)
      expect(await seen.host.conversationSay!('st1', 'c1', 'ship it', 'u1')).toEqual({ ok: true })
      expect(superTabRequest).toHaveBeenCalledWith({ action: 'conversationSay', tabId: 'st1', conversationId: 'c1', text: 'ship it', operationId: 'u1' })
      expect(await seen.host.conversationSay!('st1', 'c1', 'ship it', 'u2')).toEqual({ ok: false, error: 'That conversation is archived.' })
      // No reason, a refusal of the request itself, or no service: nothing says it went, and nothing says it surely did not.
      for (let i = 0; i < 3; i++) expect(await seen.host.conversationSay!('st1', 'c1', 'ship it', `u${i + 3}`)).toEqual({ ok: false, error: 'Could not post. Check the Swarm chat.' })
    })

    it('answers no recap when the core has no service to ask', async () => {
      start()
      expect(await seen.host.swarmCardRecap!('st1', 'lead1')).toBeNull()
      seen.host.swarmCardOpen!('c1', 'st1', 'lead1')   // nothing to tell, and nothing thrown
    })

    it('tells the service which Lead is open, and opens a picked Lead on the desktop', () => {
      const superTabRequest = vi.fn(async () => ({ ok: true }))
      const { core } = withRequest(superTabRequest)
      seen.host.swarmCardOpen!('c1', 'st1', 'lead1')
      seen.host.swarmCardOpen!('c1', 'st1', null)
      expect(superTabRequest.mock.calls).toEqual([
        [{ action: 'cardOpen', session: 'c1', tabId: 'st1', leadId: 'lead1' }], [{ action: 'cardOpen', session: 'c1', tabId: 'st1', leadId: null }]])
      seen.host.superTabSelected!('st1', 'proj1')
      expect(vi.mocked(core.clients.sendLocal)).toHaveBeenCalledWith({ type: 'dial_super_tab', payload: { superTabId: 'st1', projectId: 'proj1' } })
      seen.host.superTabNotifications!('st1')
      expect(vi.mocked(core.clients.sendLocal)).toHaveBeenLastCalledWith({ type: 'dial_super_tab', payload: { superTabId: 'st1', notifications: true } })
    })
  })

  it('changes one device\'s settings, and logs a refusal', async () => {
    const { port } = start()
    port.settings('usb', { brightness: 3 })
    port.settings('', { brightness: 3 })
    port.settings('gone', { brightness: 3 })
    await vi.waitFor(() => expect(logs).toContain('[cable] settings for gone: That device is not plugged into this computer.'))
    expect(logs).toContain('[cable] settings for no device: That device is not plugged into this computer.')
  })

  it('translates every card for the devices into the dial\'s calls, and ignores the rest', () => {
    const { port } = start()
    const card = (kind: string) => port.card({ type: 'commander_event', agentId: 'a1', payload: { kind, text: kind } })
    card('processing'); card('done'); card('error'); card('tool')
    port.card({ type: 'commander_question', agentId: 'a1', payload: { requestId: 'r1', questions: [] } })
    port.card({ type: 'commander_question_close', agentId: 'a1', payload: { requestId: 'r1' } })
    port.card({ type: 'agent_deleted', payload: {} })
    expect(seen.cable.calls.map(([name]) => name)).toEqual(['start', 'turnStarted', 'turnDone', 'turnError', 'turnStep', 'question', 'questionClose'])
  })

  it('hands the dial a Super Tab wait with its tab and what it needs, as an alert', () => {
    const { port } = start()
    port.card({ type: 'commander_question', agentId: 'a1', payload: { requestId: 'supertab:as-1:blocked', questions: [{ q: 'Stuck: no key' }], superTab: 'Pilot', attention: 'stuck' } })
    port.card({ type: 'commander_question', agentId: 'a2', payload: { requestId: 'r2', questions: [], superTab: 'Pilot', attention: 'urgent' } })
    expect(calls('question')).toEqual([['a1', 'supertab:as-1:blocked', [{ q: 'Stuck: no key' }], { superTab: 'Pilot', attention: 'stuck' }],
      ['a2', 'r2', [], undefined]])
    expect(logs.some((l) => /notify · .* · alert · rule:super-tab · question/.test(l))).toBe(true)
  })

  it('hands the dial a tool card as a step, and a processing card\'s latest sentence beside the status', () => {
    const { port } = start()
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'tool', text: 'Read', recap: '/work/cli/src/cable/cableSession.ts' } })
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'processing', text: 'Working', update: 'Reading the spec' } })
    expect(seen.cable.calls.slice(1)).toEqual([['turnStep', ['a1', 'Read · cableSession.ts']], ['turnStarted', ['a1', 'Working', 'Reading the spec']]])
  })

  describe('the reply streaming to the dial', () => {
    const reply = (port: DevicesPort, update: string, agentId = 'a1') =>
      port.card({ type: 'commander_event', agentId, payload: { kind: 'reply_text', update } })
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('sends at most once per 750 ms per agent, with a trailing send of the last text', async () => {
      const { port } = start()
      reply(port, 'one')                                   // t=0: sent at once
      await vi.advanceTimersByTimeAsync(100); reply(port, 'two')
      await vi.advanceTimersByTimeAsync(100); reply(port, 'three')
      expect(calls('turnReply')).toEqual([['a1', 'one']])
      await vi.advanceTimersByTimeAsync(550)               // t=750: the trailing send, with the 200 ms text
      expect(calls('turnReply')).toEqual([['a1', 'one'], ['a1', 'three']])
      await vi.advanceTimersByTimeAsync(150); reply(port, 'four')   // t=900
      await vi.advanceTimersByTimeAsync(599)
      expect(calls('turnReply')).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)                 // t=1500
      expect(calls('turnReply')).toEqual([['a1', 'one'], ['a1', 'three'], ['a1', 'four']])
      await vi.advanceTimersByTimeAsync(5000)              // nothing piles up
      expect(calls('turnReply')).toHaveLength(3)
    })

    it('throttles each agent on its own', async () => {
      const { port } = start()
      reply(port, 'a', 'a1'); reply(port, 'b', 'a2')
      expect(calls('turnReply')).toEqual([['a1', 'a'], ['a2', 'b']])
    })

    it('flushes the last unsent text before the turn ends, and sends nothing after', async () => {
      const { port } = start()
      reply(port, 'one')
      await vi.advanceTimersByTimeAsync(500); reply(port, 'two')
      await vi.advanceTimersByTimeAsync(500)               // t=1000: the trailing send went at 750
      reply(port, 'three')
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'done', text: 'done' } })
      await vi.advanceTimersByTimeAsync(5000)
      expect(seen.cable.calls.slice(1).map(([name, args]) => [name, ...(name === 'turnReply' ? [args[1]] : [])]))
        .toEqual([['turnReply', 'one'], ['turnReply', 'two'], ['turnReply', 'three'], ['turnDone']])
    })

    it('ignores an empty update, ends quietly with nothing waiting, and forgets a deleted agent\'s pending text', async () => {
      const { port } = start()
      reply(port, '')
      reply(port, 'one')
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'done', text: 'done' } })   // nothing pending
      reply(port, 'two'); reply(port, 'three')
      port.card({ type: 'agent_deleted', payload: { agentId: 'a1' } })
      await vi.advanceTimersByTimeAsync(2000)
      expect(calls('turnReply')).toEqual([['a1', 'one'], ['a1', 'two']])
    })

    it('sends nothing after stop(), even with a send pending', async () => {
      const { port } = start()
      reply(port, 'one'); reply(port, 'two')
      await port.stop()
      await vi.advanceTimersByTimeAsync(5000)
      expect(calls('turnReply')).toEqual([['a1', 'one']])
    })

    it('throttles on the injected monotonic clock, not the wall clock', async () => {
      let mono = 1000
      const { port } = start({ now: () => mono })
      reply(port, 'one')
      vi.setSystemTime(Date.now() + 10 * 60_000)   // the wall clock jumps; the monotonic one does not
      reply(port, 'two')
      expect(calls('turnReply')).toEqual([['a1', 'one']])
      mono += 750; vi.setSystemTime(Date.now() - 20 * 60_000); reply(port, 'three')
      expect(calls('turnReply')).toEqual([['a1', 'one'], ['a1', 'three']])
    })

    it('drops a pending send when a new turn starts', async () => {
      const { port } = start()
      reply(port, 'one'); reply(port, 'two')
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'turn_started' } })
      await vi.advanceTimersByTimeAsync(2000)
      expect(calls('turnReply')).toEqual([['a1', 'one']])
    })

    it('keeps the streamed text for the working screen\'s first activity read', async () => {
      const { port } = start()
      reply(port, 'streamed so far')
      expect(await seen.host.activitySnapshot!('a1')).toEqual(null)
    })
  })

  it('sums a turn\'s shell results and tells the dial before the turn ends', () => {
    const { port } = start()
    const ran = (id: string, command: string, outputTail: string) =>
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'tool_end', id, tool: 'Bash', command, isError: false, outputTail } })
    ran('t1', 'git commit -m x', '[main abc] x')
    ran('t2', 'npm test', 'Tests: 44 passed')
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'tool_end' } })
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'tool_end', id: 't3', command: 'ls', isError: true } })
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'done', text: 'done' } })
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'done', text: 'done' } })
    expect(seen.cable.calls.slice(1).map(([name]) => name)).toEqual(['turnStats', 'turnDone', 'turnDone'])
    expect(calls('turnStats')).toEqual([['a1', { testsPassed: 44, testsFailed: 0, commits: 1 }]])
  })

  describe('a turn\'s tokens', () => {
    const ev = (port: DevicesPort, payload: object) => port.card({ type: 'commander_event', agentId: 'a1', payload })
    const readings = (...values: Array<{ input?: number; cached?: number; output?: number } | null>) => {
      const queue = [...values]
      return vi.fn(async (_id: string) => queue.shift() ?? null)
    }
    const turn = async (readUsage: DevicesDeps['readUsage'], tool = false) => {
      const { port } = start({ readUsage })
      ev(port, { kind: 'turn_started' })
      if (tool) {
        ev(port, { kind: 'tool_end', id: 't1', tool: 'Bash', command: 'git commit -m x', isError: false, outputTail: '[main abc] x' })
        ev(port, { kind: 'tool_end', id: 't2', tool: 'Bash', command: 'npm test', isError: false, outputTail: 'Tests: 44 passed' })
      }
      ev(port, { kind: 'done', text: 'done' })
      return port
    }
    const stats = () => calls('turnStats').map(([, f]) => f)

    it('sends the difference of the two readings before the turn ends, merged with tests and commits', async () => {
      const read = readings({ input: 1000, cached: 0, output: 200 }, { input: 43900, cached: 0, output: 18700 })
      await turn(read, true)
      await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(1))
      expect(stats()).toEqual([{ testsPassed: 44, testsFailed: 0, commits: 1, tokensIn: 42900, tokensOut: 18500 }])
      expect(seen.cable.calls.slice(1).map(([name]) => name)).toEqual(['turnStats', 'turnDone'])
      expect(read).toHaveBeenCalledWith('a1')
    })

    it('counts input without cache reads: (input - cached) difference', async () => {
      await turn(readings({ input: 1_200_000, cached: 1_150_000, output: 1000 }, { input: 2_500_000, cached: 2_410_000, output: 6000 }))
      await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(1))
      expect(stats()).toEqual([{ tokensIn: 40_000, tokensOut: 5000 }])
    })

    it('omits tokensIn, keeping tokensOut, when cached is unknown', async () => {
      await turn(readings({ input: 1_200_000, output: 10 }, { input: 2_500_000, cached: 2_410_000, output: 30 }))
      await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(1))
      expect(stats()).toEqual([{ tokensOut: 20 }])
    })

    it.each([
      ['the start reading is missing', [null, { input: 5, cached: 0, output: 5 }]],
      ['the done reading is missing', [{ input: 5, cached: 0, output: 5 }, null]],
      ['a difference is negative', [{ input: 100, cached: 0, output: 100 }, { input: 50, cached: 0, output: 50 }]],
      ['a difference is over 50 000 000', [{ input: 0, cached: 0, output: 0 }, { input: 50_000_001, cached: 0, output: 50_000_001 }]],
    ] as const)('omits the fields when %s', async (_name, values) => {
      await turn(readings(...values))
      await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(1))
      expect(stats()).toEqual([])
    })

    it('omits only the field whose difference is out of range', async () => {
      await turn(readings({ input: 0, cached: 0, output: 100 }, { input: 7, cached: 0, output: 50 }))
      await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(1))
      expect(stats()).toEqual([{ tokensIn: 7 }])
    })

    it('reads the core\'s fresh usage by default, and none when the core has none', async () => {
      const usageFresh = vi.fn()
        .mockResolvedValueOnce({ inputTokens: 10, cachedTokens: 0, outputTokens: 1 })
        .mockResolvedValueOnce({ inputTokens: 30, cachedTokens: 0, outputTokens: 5 })
      const { port } = start({ core: { ...fakeCore({ dataDir }), usageFresh } })
      ev(port, { kind: 'turn_started' })
      ev(port, { kind: 'done', text: 'done' })
      await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(1))
      expect(stats()).toEqual([{ tokensIn: 20, tokensOut: 4 }])
      const bare = start()
      ev(bare.port, { kind: 'turn_started' })
      ev(bare.port, { kind: 'done', text: 'done' })
      await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(1))
      expect(stats()).toEqual([])  // a new dial session: its own calls
    })

    it('omits the fields when a reading throws, and still ends the turn', async () => {
      await turn(vi.fn(async () => { throw new Error('transcript gone') }))
      await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(1))
      expect(stats()).toEqual([])
    })

    it('omits the fields for an agent whose usage is unknown or remote (null)', async () => {
      await turn(readings(null, null))
      await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(1))
      expect(stats()).toEqual([])
    })

    it('does not hold the turn\'s end past 2 s for a slow done reading', async () => {
      vi.useFakeTimers()
      try {
        let n = 0
        const slow = vi.fn((_id: string) => (++n === 1 ? Promise.resolve({ input: 1, cached: 0, output: 1 }) : new Promise<{ input: number; cached: number; output: number }>((resolve) => setTimeout(() => resolve({ input: 9, cached: 0, output: 9 }), 2500))))
        await turn(slow, true)
        await vi.advanceTimersByTimeAsync(1999)
        expect(calls('turnDone')).toHaveLength(0)
        await vi.advanceTimersByTimeAsync(2)
        expect(calls('turnDone')).toHaveLength(1)
        expect(stats()).toEqual([{ testsPassed: 44, testsFailed: 0, commits: 1 }])
        await vi.advanceTimersByTimeAsync(1000)
        expect(calls('turnStats')).toHaveLength(1)
      } finally { vi.useRealTimers() }
    })

    it('drops the start reading when the turn errors, so the next turn starts clean', async () => {
      const read = readings({ input: 1, cached: 0, output: 1 }, { input: 9, cached: 0, output: 9 })
      const { port } = start({ readUsage: read })
      ev(port, { kind: 'turn_started' })
      ev(port, { kind: 'error', text: 'boom' })
      ev(port, { kind: 'done', text: 'done' })
      await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(1))
      expect(stats()).toEqual([])
      expect(read).toHaveBeenCalledTimes(1)
    })

    it('keeps a card that follows a delayed done behind it', async () => {
      const { port } = start({ readUsage: readings({ input: 1, cached: 0, output: 1 }, { input: 2, cached: 0, output: 2 }) })
      ev(port, { kind: 'turn_started' })
      ev(port, { kind: 'done', text: 'done' })
      ev(port, { kind: 'processing', text: 'Working' })
      await vi.waitFor(() => expect(calls('turnStarted')).toHaveLength(1))
      expect(seen.cable.calls.slice(1).map(([name]) => name)).toEqual(['turnStats', 'turnDone', 'turnStarted'])
    })

    it('keeps a question, its close and a step behind a delayed done, in order', async () => {
      let finish!: (r: { input: number; cached: number; output: number }) => void
      let n = 0
      const slow = vi.fn((_id: string) => (++n === 1 ? Promise.resolve({ input: 1, cached: 0, output: 1 })
        : new Promise<{ input: number; cached: number; output: number }>((resolve) => { finish = resolve })))
      const { port } = start({ readUsage: slow })
      ev(port, { kind: 'turn_started' })
      ev(port, { kind: 'done', text: 'done' })
      port.card({ type: 'commander_question', agentId: 'a1', payload: { requestId: 'r1', questions: [] } })
      port.card({ type: 'commander_question_close', agentId: 'a1', payload: { requestId: 'r1' } })
      ev(port, { kind: 'tool', text: 'Read', recap: '/work/a.ts' })
      seen.fleet!.events!({ kind: 'question', agentId: 'a1', requestId: 'r2', questions: [] } as never)
      seen.fleet!.events!({ kind: 'questionClosed', agentId: 'a1', requestId: 'r2' } as never)
      port.card({ type: 'commander_question', agentId: 'other', payload: { requestId: 'r9', questions: [] } })
      expect(seen.cable.calls.slice(1).map(([name]) => name)).toEqual(['question'])  // another agent is not held
      finish({ input: 2, cached: 0, output: 2 })
      await vi.waitFor(() => expect(calls('questionClose')).toHaveLength(2))
      expect(seen.cable.calls.slice(1).map(([name]) => name)).toEqual(['question', 'turnStats', 'turnDone', 'question', 'questionClose', 'turnStep', 'question', 'questionClose'])
    })

    it('keeps the queue alive when a queued dispatch throws', async () => {
      const { port } = start({ readUsage: readings({ input: 1, cached: 0, output: 1 }, { input: 2, cached: 0, output: 2 }) })
      ev(port, { kind: 'turn_started' })
      ev(port, { kind: 'done', text: 'done' })
      const fake = seen.cable as unknown as Record<string, unknown>
      fake.turnStarted = () => { throw new Error('port gone') }
      ev(port, { kind: 'processing', text: 'Working' })
      await new Promise((resolve) => setTimeout(resolve, 20))
      fake.turnStarted = (...args: unknown[]) => { seen.cable.calls.push(['turnStarted', args]); return Promise.resolve() }
      ev(port, { kind: 'turn_started' })
      ev(port, { kind: 'done', text: 'again' })
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'processing', text: 'Next' } })
      await vi.waitFor(() => expect(calls('turnStarted')).toHaveLength(1))
    })

    it('reads no tokens, and sends done at once, when no connected dial asks for turn stats', () => {
      const read = readings({ input: 1, cached: 0, output: 1 }, { input: 2, cached: 0, output: 2 })
      const { port } = start({ readUsage: read })
      ;(seen.cable as unknown as { wants: boolean }).wants = false
      ev(port, { kind: 'turn_started' })
      ev(port, { kind: 'done', text: 'done' })
      expect(calls('turnDone')).toHaveLength(1)
      expect(read).not.toHaveBeenCalled()
    })
  })

  it('drops a turn\'s stats when it ends in an error, so the next turn starts clean', () => {
    const { port } = start()
    const ev = (payload: object) => port.card({ type: 'commander_event', agentId: 'a1', payload })
    ev({ kind: 'tool_end', id: 't1', tool: 'Bash', command: 'git commit -m x', isError: false, outputTail: '[main abc] x' })
    ev({ kind: 'error', text: 'boom' })
    ev({ kind: 'processing', text: 'Working' })
    ev({ kind: 'done', text: 'done' })
    expect(calls('turnStats')).toEqual([])
  })

  it('drops the stats a turn left behind when the next turn starts', async () => {
    const { port } = start()
    const ev = (payload: object) => port.card({ type: 'commander_event', agentId: 'a1', payload })
    ev({ kind: 'tool_end', id: 't1', tool: 'Bash', command: 'git commit -m x', isError: false, outputTail: '[main abc] x' })
    ev({ kind: 'turn_started' })
    ev({ kind: 'done', text: 'done' })
    await vi.waitFor(() => expect(calls('turnDone')).toHaveLength(1))
    expect(calls('turnStats')).toEqual([])
  })

  it('hands the dial the whole answer a summary card carries', async () => {
    const { port } = start()
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'summary', text: 'b', recap: 'r', fullText: 'the whole answer' } })
    await vi.waitFor(() => expect(calls('summary')).toHaveLength(1))
    expect(seen.cable.calls.slice(1)).toEqual([['summary', ['a1', 'r', 'b', 'alert', 'the whole answer', false]]])
  })

  it('forgets an agent\'s latest sentence when its processing card has none, and when the agent goes', async () => {
    const { port, core } = start()
    vi.mocked(core.agents.activityText).mockResolvedValue('Working')
    const wired = () => seen.host.activitySnapshot!('a1')
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'processing', text: 'Working', update: 'First' } })
    expect(await wired()).toMatchObject({ action: 'First' })
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'processing', text: 'Working' } })
    expect(await wired()).not.toHaveProperty('action')
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'processing', text: 'Working', update: 'Second' } })
    port.card({ type: 'agent_deleted', payload: { agentId: 'a1' } })
    expect(await wired()).not.toHaveProperty('action')
  })

  it('prefers the core\'s activity snapshot, and has none when the core has nothing to say', async () => {
    const { core } = start()
    const wired = () => seen.host.activitySnapshot!('a1')
    vi.mocked(core.agents.activityText).mockResolvedValue(null as never)
    expect(await wired()).toBeNull()
    ;(core.agents as { activitySnapshot?: unknown }).activitySnapshot = vi.fn(async () => ({ text: 'Core', since: 5 }))
    expect(await wired()).toEqual({ text: 'Core', since: 5 })
  })

  it('says, with frame logging on, whether each card was teed to the dial', () => {
    const was = env.LOG_FRAMES
    ;(env as { LOG_FRAMES: boolean }).LOG_FRAMES = true
    try {
      const { port } = start()
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'done' } })
      port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'tool' } })
      port.card({ type: 'commander_event', agentId: 'a1' })
      expect(logs).toEqual(expect.arrayContaining(['[cable] tee done → sent', '[cable] tee tool → ignored', '[cable] tee ? → ignored']))
    } finally {
      ;(env as { LOG_FRAMES: boolean }).LOG_FRAMES = was
    }
  })

  it('logs a dial that throws on a card, and goes on', () => {
    const { port } = start({ faults: ['dial'] })
    port.card({ type: 'commander_event', agentId: 'a1', payload: { kind: 'done' } })
    port.desk(['a1'], true)
    expect(logs).toContain('[devices] dial failed · injected fault: dial')
    expect(calls('turnDone')).toEqual([])
  })
})

describe('the other machines\' cards', () => {
  it('reach the dial through the same calls as this computer\'s', async () => {
    start()
    const tell = seen.fleet!.events!
    tell({ machineId: 'm2', kind: 'state', state: 'ready' })
    tell({ machineId: 'm2', kind: 'questionClosed', agentId: 'b1', requestId: 'r1' })
    tell({ machineId: 'm2', kind: 'question', agentId: 'b1', requestId: 'r2', questions: [] })
    tell({ machineId: 'm2', kind: 'processing', agentId: 'b1', text: 'go', recap: '' })
    tell({ machineId: 'm2', kind: 'summary', agentId: 'b1', text: 'done', recap: 'fixed', subagent: true })
    tell({ machineId: 'm2', kind: 'summary', agentId: 'b1', text: 'done', recap: '' })
    await vi.waitFor(() => expect(calls('summary')).toHaveLength(2))
    expect(seen.cable.calls.map(([name]) => name)).toEqual(['start', 'syncMachines', 'questionClose', 'question', 'turnStarted', 'summary', 'summary'])
    expect(calls('summary')).toEqual([['b1', 'fixed', 'done', 'silent', undefined, true], ['b1', 'done', 'done', 'alert', undefined, false]])
  })
})

describe('⌘K, the Wi-Fi device\'s borrowed walk, the voice router and stopping', () => {
  it('route a typed task and its send through the fleet, saying why a send was refused', async () => {
    const { port } = start()
    expect(await port.routeTask('fix the parser')).toMatchObject({ agentId: 'a1', reason: 'fix the parser' })
    expect(await port.routeSend('a1', 'go')).toEqual({ ok: true })
    expect(await port.routeSend('far', 'go')).toMatchObject({ ok: false, machine: 'mac-mini' })
    expect(await port.routeSend('nameless', 'go')).toMatchObject({ ok: false, machine: '' })
    expect(logs).toEqual(expect.arrayContaining([
      '[route] ⌘K → a1 · bytes=2',
      '[route] ⌘K → far · bytes=2 · REFUSED: the last request to it did not come back (mac-mini)',
      '[route] ⌘K → nameless · bytes=2 · REFUSED: no such agent',
    ]))
  })

  it('answer ⌘K with no agent list when the fleet did not start, and the dial routes this computer itself', async () => {
    const { port } = start({ faults: ['fleet'] })
    expect(await port.routeTask('anything')).toMatchObject({ agentId: '', reason: 'no agent list yet', candidates: [] })
    expect(await port.routeSend('a1', 'go')).toEqual({ ok: false, machine: '', reason: 'no agent list yet' })
    expect(logs).toContain('[devices] fleet did not start · injected fault: fleet · the devices run without it')
    expect(seen.host.fleet!()).toBeNull()
    await port.stop()
    expect(calls('stop')).toHaveLength(1)
  })

  it('answer the dial\'s routing as unavailable once the fleet fails, so the dial routes by itself', () => {
    start()
    seen.fleet!.fail = true
    expect(() => seen.host.fleet!()!.knows('a1')).toThrow(ServiceUnavailableError)
  })

  it('lend the Wi-Fi device the dial\'s walk and stroke', async () => {
    const { core, port } = start()
    port.desk(['a1', 'a2'], true)
    port.swarms({ active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: ['a1', 'a2'], panes: 2 }], tiles: [] })
    vi.mocked(core.agents.advertised).mockReturnValue([{ agentId: 'a1', registeredAt: 1, engine: 'claude' }, { agentId: 'a2', registeredAt: 2, engine: 'claude' }] as RegisteredSession[])
    // The fleet's router is a stand-in here, so the walk is the host's own over the core's agents.
    seen.fleet!.fail = true
    expect(await port.stepFocus('next', 'a1')).toEqual(expect.objectContaining({ agentId: 'a2' }))
    port.scroll('down', 0, 0)
    expect(vi.mocked(core.clients.sendLocal).mock.calls.map(([frame]) => frame.type)).toEqual(['dial_focus', 'dial_scroll'])
  })

  it('walk the cloud harnesses on the desk too, where the core offers them', async () => {
    const { core, port } = start()
    port.desk(['a1', 'cloud_1'], true)
    port.swarms({ active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: ['a1', 'cloud_1'], panes: 2 }], tiles: [] })
    vi.mocked(core.agents.advertised).mockReturnValue([{ agentId: 'a1', registeredAt: 1, engine: 'claude' }] as RegisteredSession[])
    core.agents.cloud = () => [{ agentId: 'cloud_1', registeredAt: 2, engine: 'fo' }] as unknown as RegisteredSession[]
    seen.fleet!.fail = true
    expect(await port.stepFocus('next', 'a1')).toEqual(expect.objectContaining({ agentId: 'cloud_1' }))
  })

  it('tell the voice router the engines here and whether a device watches, and stop everything', async () => {
    const { port } = start()
    port.engines(['claude', 'codex'])
    port.commanders(true)
    expect(seen.voice.sessions).toHaveBeenCalledWith([{ engine: 'claude' }, { engine: 'codex' }])
    expect(seen.voice.connected).toHaveBeenCalledWith(true)
    await port.stop()
    expect(calls('stop')).toHaveLength(1)
    expect(seen.voice.shutdown).toHaveBeenCalled()
  })
})

describe('the devices\' own copy of the machine list', () => {
  it('is read through the core, and writes no file of its own', async () => {
    const machines = vi.fn(async (): Promise<{ status: number; body: Record<string, unknown> }> => ({ status: 200, body: { success: true, data: { machines: [{ machineId: 'm1', computerId: 'computer-1', name: 'Mine', status: 'running' }] } } }))
    start({ core: fakeCore({ dataDir, account: { machines } }) })
    const list = seen.fleet!.deps.machines
    await list.refresh()
    expect(list.list()).toEqual({ source: 'backend', machines: [expect.objectContaining({ machineId: 'm1', local: true })] })
    expect(existsSync(join(dataDir, 'machines.json'))).toBe(false)
    machines.mockResolvedValueOnce({ status: 500, body: {} })
    await list.refresh()
    expect(logs).toContain('[cable] machines: HTTP 500 — showing the last known list')
    expect(seen.fleet!.deps.desk()).toEqual([])
  })
})

describe('the Devices tab', () => {
  it('answers the owner alone: the devices here, and one device\'s settings', async () => {
    const { requests } = start()
    // The dial's own status, as its session reports it to the host, which tells the windows (revision 1).
    seen.dial.onDialStatus({ attached: true, devices: [{ id: 'usb', attached: true, settings: { brightness: 80 } }] })
    const owner = { local: true, owner: true }
    expect(await requests.harness_devices_list({}, { local: false, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
    expect(await requests.harness_devices_list({}, owner)).toMatchObject({ protocol: 1, revision: 1, status: { attached: true } })
    expect(await requests.harness_device_settings({ id: 'usb', patch: { brightness: 35 } }, owner)).toMatchObject({ ok: true, revision: 1 })
    expect(seen.cable.setSettings).toHaveBeenCalledWith('usb', { brightness: 35 })
  })
  it('answers the pet requests to the owner on this computer only', async () => {
    const { requests } = start()
    for (const type of ['pet_preview', 'pet_apply', 'pet_reset', 'pet_status'] as const) {
      expect(await requests[type]({}, { local: false, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
      expect(await requests[type]({}, { local: true, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
      expect(await requests[type]({}, { local: false, owner: true })).toEqual({ error: 'LOCAL_ONLY' })
    }
    expect(await requests.pet_status({}, { local: true, owner: true })).toEqual({
      mapping: { all: null, engines: {} }, dial: { supported: false, held: [], sending: null }, pets: {},
    })
    expect(await requests.pet_apply({ target: 'all', id: '0123456789abcdef' }, { local: true, owner: true })).toMatchObject({ error: 'UNKNOWN_PET' })
    expect(calls('petsChanged')).toEqual([])
    // A changed mapping reaches every live dial.
    expect(await requests.pet_reset({ target: 'all' }, { local: true, owner: true })).toMatchObject({ ok: true })
    expect(calls('petsChanged')).toEqual([[]])
  })
})
