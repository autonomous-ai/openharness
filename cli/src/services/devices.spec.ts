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
    syncMachines = recorder('syncMachines')
    followApp = recorder('followApp')
    replaceNotifications = recorder('replaceNotifications')
    agentSeen = recorder('agentSeen')
    question = recorder('question')
    questionClose = recorder('questionClose')
    turnStarted = recorder('turnStarted')
    turnDone = recorder('turnDone')
    summary = recorder('summary')
    turnError = recorder('turnError')
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

function start(over: { core?: CoreApi; faults?: string[]; cableDisabled?: boolean; testDialPort?: string } = {}) {
  const core = over.core ?? fakeCore({ dataDir })
  const ports: CorePorts = emptyPorts()
  const onExit = vi.fn()
  const requests = startDevices(core, ports, {
    logsDir: join(dataDir, 'logs'),
    dialSerials: ['E2E'],
    testDialPort: over.testDialPort,
    cableDisabled: over.cableDisabled,
    faults: new Set(over.faults ?? []),
    log: (line) => { logs.push(line) },
    onExit,
  })
  return { core, ports, port: ports.devices as DevicesPort, requests, onExit }
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
    port.windowFocus({ voice: { machineId: 'm1', agentId: 'a1', connId: 'w1' }, form: { machineId: 'm1', connId: 'w1' } })
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
    expect(calls('summary')).toEqual([['a1', 'fixed it', 'done', true, false], ['a1', 'done', 'done', false, false], ['a9', 'done', 'done', false, true]])
  })

  it('passes the tabs, the unread rows, the window\'s focus and what it saw', () => {
    const { port } = start()
    port.swarms({ active: 't1', swarms: [], tiles: [] })
    port.unread([{ agentId: 'a1', machineId: 'm1', text: 'done', question: false }])
    port.appFocus('m1', 'a1')
    port.seen('a1', 'tok')
    expect(seen.cable.calls.map(([name]) => name)).toEqual(['start', 'syncSwarms', 'syncAgents', 'replaceNotifications', 'followApp', 'agentSeen'])
    expect(calls('followApp')).toEqual([['m1', 'a1']])
    expect(calls('agentSeen')).toEqual([['a1', 'tok']])
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
    expect(seen.cable.calls.map(([name]) => name)).toEqual(['start', 'turnStarted', 'turnDone', 'turnError', 'question', 'questionClose'])
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
  it('reach the dial through the same calls as this computer\'s', () => {
    start()
    const tell = seen.fleet!.events!
    tell({ machineId: 'm2', kind: 'state', state: 'ready' })
    tell({ machineId: 'm2', kind: 'questionClosed', agentId: 'b1', requestId: 'r1' })
    tell({ machineId: 'm2', kind: 'question', agentId: 'b1', requestId: 'r2', questions: [] })
    tell({ machineId: 'm2', kind: 'processing', agentId: 'b1', text: 'go', recap: '' })
    tell({ machineId: 'm2', kind: 'summary', agentId: 'b1', text: 'done', recap: 'fixed', subagent: true })
    tell({ machineId: 'm2', kind: 'summary', agentId: 'b1', text: 'done', recap: '' })
    expect(seen.cable.calls.map(([name]) => name)).toEqual(['start', 'syncMachines', 'questionClose', 'question', 'turnStarted', 'summary', 'summary'])
    expect(calls('summary')).toEqual([['b1', 'fixed', 'done', false, true], ['b1', 'done', 'done', false, false]])
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
})
