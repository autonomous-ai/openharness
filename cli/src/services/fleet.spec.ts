// The fleet service: the machine list kept fresh, the lane to the other machines, the router every
// turn goes through, and ⌘K's two requests answered from it — with the dial nowhere in sight.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { env } from '../config/env.js'
import type { DeviceLinkOpts } from '../device/deviceLink.js'
import type { MachineListCache } from '../device/machineList.js'
import type { RegisteredSession } from '../lib/registry.js'
import { routeVoiceTask, type RouteDecision, type RouterAgent } from '../lib/voiceRouter.js'
import { fakeCore } from '../testing/fakeCore.js'
import { FAIL, type CoreApi } from '../core/api.js'
import { FLEET_FALLBACKS, startFleet, type Fleet, type FleetDeps } from './fleet.js'

// The lane is a cloud socket and the pinned keys a file under the data folder: neither in a test.
const lane = vi.hoisted(() => ({
  opts: null as DeviceLinkOpts | null,
  frames: null as ((frame: Record<string, unknown>) => void) | null,
  stop: vi.fn(),
  rpc: vi.fn(async (_type: string): Promise<Record<string, unknown>> => ({})),
  sendSealed: vi.fn(async () => {}),
  online: vi.fn(async () => {}),
  attach: vi.fn(async (_machineId: string) => {}),
  release: vi.fn(),
  peers: new Map<string, { pub: string }>(),
}))
vi.mock('../device/deviceLink.js', () => ({
  DeviceLink: class {
    selectedMachine = ''
    constructor(opts: DeviceLinkOpts) { lane.opts = opts }
    onFrame(cb: (frame: Record<string, unknown>) => void) { lane.frames = cb; return () => {} }
    stop() { lane.stop() }
    rpc(type: string) { return lane.rpc(type) }
    sendSealed(...args: unknown[]) { return lane.sendSealed(...(args as [])) }
    online() { return lane.online() }
    attach(machineId: string) { return lane.attach(machineId) }
    release() { lane.release() }
    resetSession() { return false }
  },
}))
vi.mock('../lib/e2ee/machinePeers.js', () => ({
  MachinePeerStore: class { get(machineId: string) { return lane.peers.get(machineId) ?? null } },
}))
vi.mock('../lib/voiceRouter.js', () => ({ routeVoiceTask: vi.fn() }))

const route = vi.mocked(routeVoiceTask)

const session = (agentId: string, registeredAt = 1, engine = 'claude') =>
  ({ agentId, registeredAt, engine, sessionId: `s-${agentId}` }) as unknown as RegisteredSession

type Row = { machineId: string; name: string; state: 'ready' | 'offline' | 'unknown' | 'needs-link'; authMode: 'remote'; local: boolean }
const THIS: Row = { machineId: 'mine', name: 'This one', state: 'ready', authMode: 'remote', local: true }
const OTHER: Row = { machineId: 'other', name: 'office-imac', state: 'ready', authMode: 'remote', local: false }

function machinesOf(rows: Row[] = [THIS, OTHER]) {
  return {
    list: vi.fn(() => ({ machines: rows, source: 'backend' as const })),
    find: vi.fn((machineId: string) => rows.find((row) => row.machineId === machineId)),
    adopt: vi.fn(() => true),
    refresh: vi.fn(async () => {}),
    applyLive: vi.fn(() => false),
  }
}

/** This computer as the core names it: its ids, its name and its account's environment. */
function coreOf(over: { machineId?: () => string } = {}, core: CoreApi = fakeCore()): CoreApi {
  return {
    ...core,
    machine: { id: over.machineId ?? (() => 'mine'), computerId: () => 'computer-1', name: () => 'MacbookPro.local' },
    account: { ...core.account, environment: () => 'test-env' },
  }
}

function setup(over: Partial<FleetDeps> & { machineId?: () => string } = {}, base = fakeCore()) {
  const machines = machinesOf()
  const { machineId, ...rest } = over
  const core = coreOf({ machineId }, base)
  const deps: FleetDeps = {
    machines: machines as unknown as MachineListCache,
    desk: () => [],
    ...rest,
  }
  const { fleet, router } = startFleet(core, deps)
  return { router, fleet: fleet as Fleet, deps, machines, core }
}

const decision = (over: Partial<RouteDecision> = {}): RouteDecision =>
  ({ agentId: 'a1', confidence: 1, reason: 'only agent in machine', needNewAgent: false, via: 'only-agent', ...over })

let log: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  lane.peers = new Map([['other', { pub: 'pinned' }]])
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  route.mockReset()
  lane.stop.mockReset()
  lane.rpc.mockReset().mockResolvedValue({})
  lane.sendSealed.mockReset()
})

describe('the machine list', () => {
  it('is read through the core at once, and again every minute until the fleet stops', () => {
    vi.useFakeTimers()
    const { fleet, machines } = setup()
    expect(machines.refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(machines.refresh).toHaveBeenCalledTimes(2)
    fleet.stop()
    expect(lane.stop).toHaveBeenCalled()
    vi.advanceTimersByTime(120_000)
    expect(machines.refresh).toHaveBeenCalledTimes(2)
  })
})

describe('the lane to the other machines', () => {
  it('signs in and seals through the core, holding no credential, reading the pinned keys and this machine’s id fresh', async () => {
    let machineId = ''
    const { router, core } = setup({ machineId: () => machineId })
    const opts = lane.opts!
    expect(opts).toMatchObject({ backendWsBase: env.BACKEND_WS_URL, computerId: 'computer-1', autonomousEnv: 'test-env' })
    // Its tokens are the core's session's, a forced refresh included; its sessions the gateway's.
    expect(await opts.auth.accessToken({ force: true, failedToken: 'old' })).toBe('token')
    expect(core.account.accessToken).toHaveBeenCalledWith({ force: true, failedToken: 'old' })
    expect(opts.seal).toBe(core.account.lane)
    expect(Object.keys(opts)).not.toContain('identity')
    expect(opts.peer('other')).toEqual({ pub: 'pinned' })
    expect(opts.peer('third')).toBeNull()
    lane.peers.set('third', { pub: 'later' })
    expect(opts.peer('third')).toEqual({ pub: 'later' })
    expect(opts.localMachineId()).toBe('')
    // Before this computer has a machine id, its row is named by its computer id.
    expect(router.localId()).toBe('cable:computer-1')
    machineId = 'mine'
    expect(opts.localMachineId()).toBe('mine')
    opts.log('device: connecting')
    expect(log).toHaveBeenCalledWith('[device] device: connecting')
    // A machine with no pinned key is reachable but unreadable, and the wheel says so.
    lane.peers.delete('other')
    expect((await router.listMachines()).machines.find((m) => m.id === 'other')?.state).toBe('needs-link')
    lane.peers.set('other', { pub: 'pinned' })
    expect((await router.listMachines()).machines.find((m) => m.id === 'other')?.state).toBe('ready')
  })

  it('notes which machine a card came from, so a question from an agent never listed is named and routed home', () => {
    const { router } = setup()
    lane.frames!({ type: 'node_status', machineId: 'other', payload: { online: true } })
    expect(router.machineOf('other')).toBe('')
    lane.frames!({ type: 'commander_question', machineId: 'other', agentId: 'r9', payload: { requestId: 'q1', questions: [] } })
    expect(router.machineOf('r9')).toBe('other')
    expect(router.describe('r9')).toEqual({ name: '', engine: '', machine: '' })
  })

  it('reaches another machine’s agents over the lane, and says when it could not', async () => {
    lane.rpc.mockImplementation(async (type: string) => {
      if (type === 'agents_list') return { agents: [{ id: 'r1', name: 'api', engine: 'claude' }] }
      throw new Error('timed out')
    })
    const { router, fleet } = setup()
    await router.listAgentsFlat()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await router.listAgentsFlat()).map((a) => a.id)).toEqual(['r1'])
    expect(log).toHaveBeenCalledWith('[cable] cable: office-imac → 1 agents')
    expect(fleet.sendTurn('r1', 'ship it')).toEqual({ ok: true })
    expect(lane.sendSealed).toHaveBeenCalledWith(expect.objectContaining({ type: 'message', machineId: 'other' }))
    expect(await router.recentSummaries('r1')).toEqual([])
    expect(log).toHaveBeenCalledWith('[device] device: agent_recent r1 failed (timed out)')
  })
})

describe('this computer’s side of every route', () => {
  it('goes through the core’s own doors', async () => {
    const core = fakeCore({
      agents: {
        advertised: vi.fn(() => [session('a1')]),
        displayName: vi.fn(() => 'api'),
        runtimeProfile: vi.fn(() => 'runtime-v1:s-a1:claude:opus@high'),
        fork: vi.fn(async () => ({ ok: true as const, agentId: 'a1-fork' })),
        runtimeModels: vi.fn(async () => [{ id: 'opus', displayName: 'Opus' }]),
      },
      turns: { recent: vi.fn(async () => [{ recap: 'Done', text: 'Done' }]), asks: vi.fn(async () => ['what next?']) },
      questions: { answerReviewed: vi.fn(async () => true) },
    })
    // Asked as the dial asks it: through the port, the router's own answers.
    const { fleet } = setup({ desk: () => ['a1'] }, core)
    expect(await fleet.listAgentsFlat()).toEqual([
      { id: 'a1', name: 'api', engine: 'claude', machineId: 'mine', machine: 'MacbookPro.local', model: 'opus', effort: 'high' },
    ])
    expect(fleet.sendTurn('a1', 'hello')).toEqual({ ok: true })
    expect(core.turns.send).toHaveBeenCalledWith('a1', 'hello')
    expect(fleet.routeSend('a1', 'from cmd-k')).toEqual({ ok: true })
    expect(core.turns.send).toHaveBeenLastCalledWith('a1', 'from cmd-k')
    fleet.stopTurn('a1')
    expect(core.turns.stop).toHaveBeenCalledWith('a1')
    fleet.answer('a1', 'q', { scope: 'File' })
    expect(core.questions.answer).toHaveBeenCalledWith('a1', 'q', { scope: 'File' })
    const reviewed = { agentId: 'a1', requestId: 'q', questions: [], answers: {}, selections: {} }
    expect(await fleet.answerReviewed(reviewed)).toEqual({ ok: true })
    expect(core.questions.answerReviewed).toHaveBeenCalledWith(reviewed)
    expect(await fleet.recentSummaries('a1')).toEqual([{ recap: 'Done', text: 'Done', ask: '' }])
    expect(core.turns.recent).toHaveBeenCalledWith('a1', 3)
    expect(await fleet.recentAsks('a1')).toEqual(['what next?'])
    fleet.updateAgent('a1', 'sonnet', 'low')
    expect(core.agents.setRuntime).toHaveBeenCalledWith('a1', 'sonnet', 'low')
    expect(await fleet.listModels('a1')).toEqual(['opus'])
    expect(await fleet.forkAgent('a1')).toEqual({ result: { ok: true, agentId: 'a1-fork' }, machineId: 'mine', asked: true })
    expect(core.agents.fork).toHaveBeenCalledWith('a1')
  })
})

describe('what the dial asks through the port', () => {
  it('is the router\'s: its machines, what it knows of an agent, the person\'s last turn, and the lane', async () => {
    const core = fakeCore({ agents: { advertised: vi.fn(() => [session('a1')]), displayName: vi.fn(() => 'api') } })
    const { fleet } = setup({}, core)
    const { machines, source } = await fleet.listMachines()
    expect(source).toBe('backend')
    expect(machines.map((m) => m.id)).toEqual(['mine', 'other'])
    await fleet.listAgentsFlat()
    expect(fleet.agentTotal()).toBe(1)
    expect(fleet.describe('a1')).toEqual({ name: 'api', engine: 'claude', machine: 'MacbookPro.local' })
    fleet.noteAgent('other', 'r9')
    expect(fleet.machineOf('r9')).toBe('other')
    expect(fleet.knows('a1')).toBe(true)
    expect(fleet.isLocalAgent('r9')).toBe(false)
    expect(fleet.canSpeakQuestion('a1')).toBe(true)
    expect(fleet.lastRouted()).toBeUndefined()
    fleet.sendTurn('a1', 'hello')
    expect(fleet.lastRouted()).toMatchObject({ agentId: 'a1' })
    // The lane: there while signed in, held for a dial, and let go of.
    expect(fleet.hasLane()).toBe(true)
    expect(await fleet.online()).toEqual({ ok: true })
    expect(await fleet.select('other')).toEqual({ ok: true })
    fleet.release(true)
    expect(lane.release).toHaveBeenCalled()
  })

  it('carries the other machines\' cards to whoever listens, until they stop', () => {
    const { fleet } = setup()
    const heard: unknown[] = []
    const stop = fleet.onEvent((event) => heard.push(event))
    lane.frames!({ type: 'commander_event', machineId: 'other', agentId: 'r1', payload: { kind: 'done' } })
    stop()
    lane.frames!({ type: 'commander_event', machineId: 'other', agentId: 'r1', payload: { kind: 'done' } })
    expect(heard).toEqual([{ machineId: 'other', kind: 'done', agentId: 'r1', text: '', recap: '' }])
  })
})

describe('⌘K: which agent a typed task belongs to', () => {
  it('weighs every agent it knows with the person’s own questions, and remembers who they were just talking to', async () => {
    const core = fakeCore({
      agents: { advertised: vi.fn(() => [session('a1'), session('a2', 2, 'codex')]), displayName: vi.fn((s: RegisteredSession) => `name-${s.agentId}`) },
      turns: { asks: vi.fn(async (agentId: string) => (agentId === 'a1' ? ['  fix the\nparser '] : [])) },
    })
    const { fleet } = setup({}, core)
    route.mockResolvedValue(decision({ agentId: 'a2', confidence: 0.8, reason: 'parser work', via: 'claude' }))
    expect(await fleet.routeTask('fix the lexer')).toEqual({
      agentId: 'a2', machineId: 'mine', name: 'name-a2', confidence: 0.8, reason: 'parser work', weighed: 2, machines: 1, via: 'model',
      candidates: [
        { agentId: 'a2', name: 'name-a2', machineId: 'mine', machine: 'MacbookPro.local', engine: 'codex', recent: '', confidence: 0.8 },
        { agentId: 'a1', name: 'name-a1', machineId: 'mine', machine: 'MacbookPro.local', engine: 'claude', recent: '', confidence: 0 },
      ],
    })
    const [text, candidates, signal, timeoutMs, continuity] = route.mock.calls[0]!
    expect(text).toBe('fix the lexer')
    expect(candidates.map((c: RouterAgent) => [c.id, c.prompts])).toEqual([['a1', ['fix the parser']], ['a2', []]])
    expect([signal, timeoutMs, continuity]).toEqual([undefined, 20_000, undefined])
    // A turn ⌘K sent is who the person is talking to, for the next route.
    fleet.sendTurn('a2', 'and the lexer')
    await fleet.routeTask('one more')
    expect(route.mock.calls[1]![4]).toMatchObject({ agentId: 'a2' })
  })

  it('weighs the first fifteen in rail order and says so; ranks the router’s runners-up first', async () => {
    const sessions = Array.from({ length: 17 }, (_, i) => session(`a${String(i).padStart(2, '0')}`, i))
    const { fleet } = setup({}, fakeCore({ agents: { advertised: vi.fn(() => sessions), displayName: vi.fn((s: RegisteredSession) => s.agentId) } }))
    route.mockResolvedValue(decision({
      agentId: 'a05', confidence: 0.3, reason: 'names', via: 'heuristic-names',
      scores: [{ agentId: 'a09', confidence: 0.2 }, { agentId: 'a05', confidence: 0.3 }, { agentId: 'gone', confidence: 0.1 }],
    }))
    const answer = await fleet.routeTask('something')
    expect(log).toHaveBeenCalledWith('[route] 17 agents · weighing the first 15 (open tiles first)')
    expect(answer.weighed).toBe(15)
    expect(answer.via).toBe('heuristic')
    expect(answer.candidates.map((c) => c.agentId).slice(0, 4)).toEqual(['a05', 'a09', 'a00', 'a01'])
    expect(answer.candidates).toHaveLength(15)
    expect(answer.candidates.map((c) => c.confidence).slice(0, 3)).toEqual([0.3, 0.2, 0])
  })

  it('picks nobody when the router does, and still shows what it weighed', async () => {
    const { fleet, router } = setup()
    // An agent listed with nothing to say about where it lives or what it runs, and a router that wrote
    // its own summary onto the candidate it read.
    vi.spyOn(router, 'listAgentsFlat').mockResolvedValue([{ id: 'x1', name: 'orphan' }])
    route.mockImplementation(async (_text, agents) => {
      agents[0]!.recentSummary = 'y'.repeat(200)
      return { agentId: '', confidence: 0, reason: 'no agents in machine', needNewAgent: true }
    })
    expect(await fleet.routeTask('anything')).toEqual({
      agentId: '', machineId: '', name: '', confidence: 0, reason: 'no agents in machine', weighed: 1, machines: 0, via: 'model',
      candidates: [{ agentId: 'x1', name: 'orphan', machineId: '', machine: '', engine: '', recent: 'y'.repeat(120), confidence: 0 }],
    })
  })
})

describe('the fleet failing', () => {
  it('answers ⌘K with no agent picked and nothing sent, saying why', () => {
    expect(FLEET_FALLBACKS.routeSend).toEqual({ ok: false, machine: '', reason: 'the fleet service is unavailable' })
    expect(FLEET_FALLBACKS.stop).toBeUndefined()
    // No cards, and nothing to stop hearing.
    expect((FLEET_FALLBACKS.onEvent as () => void)()).toBeUndefined()
  })

  it('fails the dial\'s routing rather than making an answer up', () => {
    // The dial routes this computer by itself then (cable/cableHost.ts): a made-up answer read as the
    // fleet's would send a turn nowhere and say it went.
    for (const member of ['agentTotal', 'describe', 'machineOf', 'knows', 'isLocalAgent', 'sendTurn', 'hasLane', 'release'] as const) {
      expect(FLEET_FALLBACKS[member], member).toBe(FAIL)
    }
  })
})
