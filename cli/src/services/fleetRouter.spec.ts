// The router across the owner's machines: which machine an agent is on, and a turn, a stop or an
// answer reaching it there. Every caller (⌘K, the voice route, the dial) goes through one of these.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FleetError, type FleetMachine, type MachineFleet } from '../cable/machineFleet.js'
import type { ReviewedAnswer } from '../cable/questionInbox.js'
import type { RegisteredSession } from '../lib/registry.js'
import { FleetRouter, type FleetLocal } from './fleetRouter.js'

const session = (agentId: string, registeredAt: number, engine?: string) =>
  ({ agentId, registeredAt, engine, sessionId: `s-${agentId}` }) as unknown as RegisteredSession

function localOf(over: Partial<FleetLocal> = {}, sessions: RegisteredSession[] = []): FleetLocal {
  return {
    machineName: () => 'MacbookPro.local',
    machineId: () => 'mine',
    computerId: () => 'abc-123',
    sessions: () => [...sessions],
    displayName: (s) => `name-${s.agentId}`,
    desk: () => [],
    sendTurn: vi.fn(),
    stopTurn: vi.fn(),
    answer: vi.fn(),
    recent: vi.fn(() => []),
    recentAsks: vi.fn(() => []),
    log: vi.fn(),
    ...over,
  }
}

const REMOTE: FleetMachine = { machineId: 'other', name: 'office-imac', state: 'ready', authMode: 'remote' }

/** A fleet whose machines and agent lists are scripted. */
function fleetOf(machines: FleetMachine[], byMachine: Record<string, Array<{ id: string; name: string; engine?: string }>> = {}): MachineFleet {
  return {
    list: async () => ({ machines, source: 'backend' as const }),
    online: async () => {},
    select: async () => {},
    release: vi.fn(),
    listAgents: vi.fn(async (machineId: string) => (byMachine[machineId] ?? []) as never),
    sendTurn: vi.fn(), stopTurn: vi.fn(), answer: vi.fn(), updateAgent: vi.fn(),
    listModels: vi.fn(async () => ['m1']),
    recentSummaries: vi.fn(async () => []),
    recentAsks: vi.fn(async () => []),
    onEvent: () => () => {},
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Two reads: the first starts the background refresh, the second reads what it wrote. */
async function settled(router: FleetRouter) {
  await router.listAgentsFlat()
  await flush()
  return router.listAgentsFlat()
}

afterEach(() => { vi.restoreAllMocks() })

describe('this computer', () => {
  it('is named by its machine id, or by a placeholder that is not machine-id shaped', () => {
    expect(new FleetRouter(localOf()).localId()).toBe('mine')
    expect(new FleetRouter(localOf({ machineId: () => '' })).localId()).toBe('cable:abc-123')
  })

  it('is the only row with no fleet, and the first row with one — never twice', async () => {
    expect(await new FleetRouter(localOf()).listMachines()).toEqual({
      machines: [{ id: 'mine', name: 'MacbookPro.local', state: 'ready', local: true }], source: 'signed-out',
    })
    const dupe: FleetMachine = { machineId: 'mine', name: 'renamed', state: 'offline', authMode: 'remote' }
    const { machines, source } = await new FleetRouter(localOf(), fleetOf([dupe, REMOTE])).listMachines()
    expect(source).toBe('backend')
    expect(machines).toEqual([
      { id: 'mine', name: 'MacbookPro.local', state: 'ready', local: true },
      { id: 'other', name: 'office-imac', state: 'ready', local: false },
    ])
  })

  it('lists its agents oldest first, ties by id, with the chips their runtime profile names', async () => {
    const profiles: Record<string, string | null> = {
      b: 'runtime-v1:s-b:claude:opus@high', a: 'runtime-v1:s-a:claude:sonnet', c: 'runtime-v1:s-c:claude:@low',
      d: 'runtime-v1:s-d:claude', e: 'something-else', f: null,
    }
    const router = new FleetRouter(localOf({ runtimeProfile: (s) => profiles[s.agentId] ?? null },
      [session('f', 3, 'terminal'), session('b', 1, 'claude'), session('a', 1, 'claude'), session('c', 2), session('d', 2), session('e', 2)]))
    const agents = await router.listAgentsFlat()
    expect(agents.map((a) => a.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(agents[0]).toEqual({ id: 'a', name: 'name-a', engine: 'claude', machineId: 'mine', machine: 'MacbookPro.local', model: 'sonnet', effort: undefined })
    expect(agents[1]).toMatchObject({ model: 'opus', effort: 'high' })
    expect(agents[2]).toMatchObject({ engine: '', model: undefined, effort: 'low' })
    for (const plain of agents.slice(3)) expect(plain).not.toHaveProperty('model')
    // A shell is a tile, not an agent: the overview's number leaves it out.
    expect(router.agentTotal()).toBe(5)
    // No profile reader at all: no chips.
    const bare = new FleetRouter(localOf({}, [session('a', 1, 'claude')]))
    expect((await bare.listAgentsFlat())[0]).not.toHaveProperty('model')
  })
})

describe('which machine an agent is on', () => {
  it('reads each other machine’s list off to the side, and puts this computer first', async () => {
    const third: FleetMachine = { machineId: 'third', name: 'studio', state: 'ready', authMode: 'remote' }
    const fleet = fleetOf([REMOTE, third], { other: [{ id: 'r1', name: 'api' }], third: [{ id: 'r2', name: 'ui', engine: 'codex' }] })
    const log = vi.fn()
    const router = new FleetRouter(localOf({ log }, [session('local-1', 1, 'claude')]), fleet)
    const agents = await settled(router)
    expect(agents.map((a) => [a.id, a.machineId, a.machine])).toEqual([
      ['local-1', 'mine', 'MacbookPro.local'], ['r1', 'other', 'office-imac'], ['r2', 'third', 'studio'],
    ])
    expect(router.machineOf('r2')).toBe('third')
    expect(router.machineOf('local-1')).toBe('mine')
    expect(router.machineOf('ghost')).toBe('')
    expect(router.knows('r1')).toBe(true)
    expect(router.knows('ghost')).toBe(false)
    expect(router.isLocalAgent('local-1')).toBe(true)
    expect(router.isLocalAgent('ghost')).toBe(true)
    expect(router.isLocalAgent('r1')).toBe(false)
    expect(log).toHaveBeenCalledWith('cable: office-imac → 1 agents')
    // Asked once a round, not on every read: the list changes when a person starts an agent.
    await router.listAgentsFlat()
    expect(fleet.listAgents).toHaveBeenCalledTimes(2)
  })

  it('asks a slow machine once, and logs only when a machine’s count changes', async () => {
    let answer: (agents: never) => void = () => {}
    const fleet = fleetOf([REMOTE])
    fleet.listAgents = vi.fn(() => new Promise<never>((resolve) => { answer = resolve }))
    const log = vi.fn()
    const router = new FleetRouter(localOf({ log }), fleet)
    await router.listAgentsFlat()
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 6_000)
    await router.listAgentsFlat()   // past the cadence, but its first answer is still out
    expect(fleet.listAgents).toHaveBeenCalledTimes(1)
    answer([{ id: 'r1', name: 'api' }] as never)
    await flush()
    expect(log).toHaveBeenCalledWith('cable: office-imac → 1 agents')
    log.mockClear()
    vi.spyOn(Date, 'now').mockReturnValue(now + 12_000)
    await router.listAgentsFlat()
    answer([{ id: 'r1', name: 'api' }] as never)
    await flush()
    expect(fleet.listAgents).toHaveBeenCalledTimes(2)
    expect(log).not.toHaveBeenCalled()
  })

  it('keeps a machine’s last good list through a failure, and only past the grace drops it, saying so', async () => {
    const fleet = fleetOf([REMOTE], { other: [{ id: 'r1', name: 'api' }] })
    const log = vi.fn()
    const router = new FleetRouter(localOf({ log }), fleet)
    expect((await settled(router)).map((a) => a.id)).toEqual(['r1'])
    ;(fleet.listAgents as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('cloud blip'))
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 6_000)
    expect((await settled(router)).map((a) => a.id)).toEqual(['r1'])
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_000)
    await settled(router)
    expect(log).toHaveBeenCalledWith('cable: office-imac dropped off the carousel (cloud blip)')
    expect(await router.listAgentsFlat()).toEqual([])
    // Already empty: a later failure past the grace has nothing to drop and says nothing.
    log.mockClear()
    vi.spyOn(Date, 'now').mockReturnValue(now + 120_000)
    await settled(router)
    expect(log).not.toHaveBeenCalled()
  })

  it('keeps a machine’s agents while the backend cannot be asked, and drops them when the machine says offline', async () => {
    const machines: FleetMachine[] = [{ ...REMOTE }]
    const fleet = fleetOf(machines, { other: [{ id: 'r1', name: 'api' }] })
    const log = vi.fn()
    const router = new FleetRouter(localOf({ log }), fleet)
    expect((await settled(router)).map((a) => a.id)).toEqual(['r1'])
    machines[0].state = 'unknown'
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000)
    expect((await settled(router)).map((a) => a.id)).toEqual(['r1'])
    machines[0].state = 'offline'
    expect((await settled(router)).map((a) => a.id)).toEqual([])
    expect(log).toHaveBeenCalledWith('cable: office-imac is offline — its 1 agents left the carousel')
    // Already empty: nothing more to say.
    log.mockClear()
    await settled(router)
    expect(log).not.toHaveBeenCalled()
  })

  it('asks nothing of a machine that is not linked', async () => {
    const fleet = fleetOf([{ ...REMOTE, state: 'needs-link' }], { other: [{ id: 'r1', name: 'api' }] })
    const router = new FleetRouter(localOf(), fleet)
    expect(await settled(router)).toEqual([])
    expect(fleet.listAgents).not.toHaveBeenCalled()
  })

  it('holds a tile the window has open after its machine drops out, once, and never resurrects one without a tile', async () => {
    const machines: FleetMachine[] = [{ ...REMOTE }]
    const desk: string[] = []
    const log = vi.fn()
    const router = new FleetRouter(localOf({ log, desk: () => desk }), fleetOf(machines, { other: [{ id: 'r1', name: 'api' }, { id: 'r2', name: 'web' }] }))
    await settled(router)
    desk.push('r1', 'never-listed')
    machines[0].state = 'offline'
    const agents = await settled(router)
    expect(agents.map((a) => a.id)).toEqual(['r1'])
    expect(agents[0]).toMatchObject({ name: 'api', machineId: 'other', machine: 'office-imac' })
    expect(router.knows('r1')).toBe(true)
    expect(router.knows('r2')).toBe(false)
    // Still held on the next read, and said only the once.
    expect((await router.listAgentsFlat()).map((a) => a.id)).toEqual(['r1'])
    expect(log.mock.calls.filter(([line]) => String(line).startsWith('cable: holding'))).toEqual([['cable: holding r1 on the tab — the window has a tile for it']])
    // The tile closes: no longer held, and a later hold says so again.
    desk.splice(0)
    expect(await router.listAgentsFlat()).toEqual([])
    desk.push('r1')
    await router.listAgentsFlat()
    expect(log.mock.calls.filter(([line]) => String(line).startsWith('cable: holding'))).toHaveLength(2)
  })

  it('routes nothing for an agent listed without a machine, even when the window holds its tile', async () => {
    const nameless: FleetMachine = { machineId: '', name: 'ghost-row', state: 'ready', authMode: 'remote' }
    const machines = [nameless]
    const desk: string[] = []
    const router = new FleetRouter(localOf({ desk: () => desk }), fleetOf(machines, { '': [{ id: 'x1', name: 'orphan' }] }))
    expect((await settled(router)).map((a) => a.id)).toEqual(['x1'])
    expect(router.knows('x1')).toBe(false)
    desk.push('x1')
    nameless.state = 'offline'
    expect((await settled(router)).map((a) => a.id)).toEqual(['x1'])
    expect(router.knows('x1')).toBe(false)
  })

  it('describes an agent it has listed, one it has only heard from, and nothing it has never met', async () => {
    const unnamed = { ...REMOTE, name: undefined as unknown as string }
    const router = new FleetRouter(localOf({}, [session('a1', 1, 'codex')]), fleetOf([unnamed], { other: [{ id: 'r1', name: 'api' }] }))
    // Before any list: a local agent is still this computer's.
    expect(router.describe('a1')).toEqual({ name: 'name-a1', engine: 'codex', machine: 'MacbookPro.local' })
    await settled(router)
    expect(router.describe('r1')).toEqual({ name: 'api', engine: '', machine: '' })
    expect(router.describe('ghost')).toBeUndefined()
    router.noteAgent('other', 'r9')
    router.noteAgent('', 'r8')
    router.noteAgent('other', '')
    router.noteAgent('elsewhere', 'r7')
    expect(router.describe('r9')).toEqual({ name: '', engine: '', machine: '' })
    expect(router.describe('r8')).toBeUndefined()
    expect(router.describe('r7')).toEqual({ name: '', engine: '', machine: '' })
    expect(router.machineOf('r9')).toBe('other')
    const named = new FleetRouter(localOf(), fleetOf([REMOTE]))
    await named.listAgentsFlat()
    named.noteAgent('other', 'r9')
    expect(named.describe('r9')).toEqual({ name: '', engine: '', machine: 'office-imac' })
  })
})

describe('a turn, delivered and said so', () => {
  it('goes to the agent’s own machine, and is remembered as who the person is talking to', async () => {
    const fleet = fleetOf([REMOTE], { other: [{ id: 'r1', name: 'api' }] })
    const local = localOf({}, [session('local-1', 1, 'claude')])
    const router = new FleetRouter(local, fleet)
    await settled(router)
    expect(router.lastRouted()).toBeUndefined()
    expect(router.sendTurn('r1', 'ship it')).toEqual({ ok: true })
    expect(fleet.sendTurn).toHaveBeenCalledWith('other', 'r1', 'ship it')
    expect(router.lastRouted()).toMatchObject({ agentId: 'r1' })
    expect(router.sendTurn('local-1', 'hello')).toEqual({ ok: true })
    expect(local.sendTurn).toHaveBeenCalledWith('local-1', 'hello')
    expect(router.lastRouted()?.agentId).toBe('local-1')
    // Never guessed onto another machine: an id never listed goes to this computer's door.
    router.sendTurn('ghost', 'where does this go?')
    expect(local.sendTurn).toHaveBeenLastCalledWith('ghost', 'where does this go?')
    expect(fleet.sendTurn).toHaveBeenCalledTimes(1)
    // An empty id is delivered, but is not a conversation.
    router.sendTurn('', 'nobody')
    expect(router.lastRouted()?.agentId).toBe('ghost')
  })

  it('is refused for a machine whose last request did not come back, and never for one never asked', async () => {
    const fleet = fleetOf([REMOTE], { other: [{ id: 'r1', name: 'api' }] })
    const log = vi.fn()
    const router = new FleetRouter(localOf({ log }), fleet)
    await settled(router)
    fleet.reachable = () => null
    expect(router.sendTurn('r1', 'cold start')).toEqual({ ok: true })
    fleet.reachable = () => ({ ok: true, at: Date.now() })
    expect(router.sendTurn('r1', 'fine')).toEqual({ ok: true })
    fleet.reachable = () => ({ ok: false, at: Date.now() - 4_000 })
    expect(router.sendTurn('r1', 'deaf')).toEqual({ ok: false, machine: 'office-imac', reason: 'the last request to it did not come back' })
    expect(log).toHaveBeenCalledWith('cable: refused a turn for r1 — office-imac last failed 4s ago')
    expect(router.lastRouted()?.agentId).toBe('r1')
    expect(fleet.sendTurn).toHaveBeenCalledTimes(2)
    // Heard from but never listed: the refusal names the machine by its id.
    router.noteAgent('abcdef0123456789', 'r9')
    expect(router.sendTurn('r9', 'deaf too')).toMatchObject({ ok: false, machine: 'abcdef01' })
  })

  it('stops, answers and switches models on the agent’s own machine', async () => {
    const fleet = fleetOf([REMOTE], { other: [{ id: 'r1', name: 'api' }] })
    const updateAgent = vi.fn()
    const local = localOf({ updateAgent }, [session('a1', 1, 'claude')])
    const router = new FleetRouter(local, fleet)
    await settled(router)
    router.stopTurn('r1'); router.stopTurn('a1')
    expect(fleet.stopTurn).toHaveBeenCalledWith('other', 'r1')
    expect(local.stopTurn).toHaveBeenCalledWith('a1')
    router.answer('r1', 'q', { k: 'v' }); router.answer('a1', 'q', { k: 'v' })
    expect(fleet.answer).toHaveBeenCalledWith('other', 'r1', 'q', { k: 'v' })
    expect(local.answer).toHaveBeenCalledWith('a1', 'q', { k: 'v' })
    router.updateAgent('r1', 'opus', 'high'); router.updateAgent('a1', 'sonnet')
    expect(fleet.updateAgent).toHaveBeenCalledWith('other', 'r1', 'opus', 'high')
    expect(updateAgent).toHaveBeenCalledWith('a1', 'sonnet', undefined)
    // A daemon with no model switch: nothing happens.
    new FleetRouter(localOf()).updateAgent('a1', 'opus')
  })

  it('reads recaps, questions and models from the agent’s own machine, tidied', async () => {
    const fleet = fleetOf([REMOTE], { other: [{ id: 'r1', name: 'api' }] })
    fleet.recentSummaries = vi.fn(async () => [{ recap: 'Done.', text: 'Shipped the fix.', ask: 'ship it' }])
    fleet.recentAsks = vi.fn(async () => ['  ship\n it ', ''])
    const local = localOf({
      recent: vi.fn(() => [null, {}, { recap: 'Local recap', text: 'body' }, { ask: 'only a question' }] as never),
      recentAsks: vi.fn(() => ['what  next?', null] as never),
      listModels: vi.fn(async () => [{ id: 'opus' }, { id: '' }]),
    }, [session('a1', 1, 'claude')])
    const router = new FleetRouter(local, fleet)
    await settled(router)
    expect(await router.recentSummaries('r1')).toEqual([{ recap: expect.any(String), text: 'Shipped the fix.', ask: 'ship it' }])
    expect(fleet.recentSummaries).toHaveBeenCalledWith('other', 'r1')
    expect(await router.recentSummaries('a1')).toEqual([
      { recap: expect.any(String), text: 'body', ask: '' }, { recap: '', text: '', ask: 'only a question' },
    ])
    expect(local.recent).toHaveBeenCalledWith('a1', 3)
    expect(await router.recentAsks('r1')).toEqual(['ship it'])
    expect(await router.recentAsks('a1')).toEqual(['what next?'])
    expect(await router.listModels('r1')).toEqual(['m1'])
    expect(await router.listModels('a1')).toEqual(['opus'])
    expect(await new FleetRouter(localOf()).listModels('a1')).toEqual([])
  })
})

describe('a fork, on the agent’s own machine', () => {
  it('forks a local agent through the daemon, notes the fork here, and says which machine was asked', async () => {
    const forkAgent = vi.fn(async () => ({ ok: true as const, agentId: 'a1-fork' }))
    const router = new FleetRouter(localOf({ forkAgent }, [session('a1', 1, 'claude')]))
    await router.listAgentsFlat()
    expect(await router.forkAgent('a1')).toEqual({ result: { ok: true, agentId: 'a1-fork' }, machineId: 'mine', asked: true })
    expect(router.machineOf('a1-fork')).toBe('mine')
    forkAgent.mockResolvedValueOnce({ ok: false, error: 'BUSY' } as never)
    expect(await router.forkAgent('a1')).toEqual({ result: { ok: false, error: 'BUSY' }, machineId: 'mine', asked: true })
  })

  it('refuses without asking anyone for an agent never listed, or a daemon that cannot fork', async () => {
    const router = new FleetRouter(localOf({}, [session('a1', 1, 'claude')]))
    await router.listAgentsFlat()
    expect(await router.forkAgent('ghost')).toMatchObject({ result: { ok: false, error: 'AGENT_NOT_FOUND' }, machineId: '', asked: false })
    expect(await router.forkAgent('a1')).toMatchObject({ result: { ok: false, error: 'UNSUPPORTED' }, machineId: 'mine', asked: false })
    // A remote agent heard from, with no fleet to fork it through.
    router.noteAgent('other', 'r1')
    expect(await router.forkAgent('r1')).toEqual({ result: { ok: false, error: 'UNSUPPORTED_ON_REMOTE' }, machineId: 'other', asked: false })
  })

  it('forks a remote agent on its machine, and reports the far end’s refusal', async () => {
    const fleet = fleetOf([REMOTE], { other: [{ id: 'r1', name: 'api' }, { id: 'r2', name: 'busy' }] })
    fleet.forkAgent = vi.fn(async (_m: string, id: string) => { if (id === 'r1') return 'r1-fork'; throw new Error('r2 is in the middle of a turn') })
    const router = new FleetRouter(localOf(), fleet)
    await settled(router)
    expect(await router.forkAgent('r1')).toEqual({ result: { ok: true, agentId: 'r1-fork' }, machineId: 'other', asked: true })
    expect(router.machineOf('r1-fork')).toBe('other')
    expect((await router.forkAgent('r2')).result).toEqual({ ok: false, error: 'FORK_FAILED', detail: 'r2 is in the middle of a turn' })
  })
})

describe('the lane, held while a dial is plugged in', () => {
  it('is there only with a fleet, and comes online, selects and lets go through it', async () => {
    expect(new FleetRouter(localOf()).hasLane()).toBe(false)
    // Nothing to let go of without one.
    new FleetRouter(localOf()).release(true)
    const fleet = fleetOf([REMOTE])
    fleet.online = vi.fn(async () => {})
    fleet.select = vi.fn(async () => {})
    const router = new FleetRouter(localOf(), fleet)
    expect(router.hasLane()).toBe(true)
    expect(await router.online()).toEqual({ ok: true })
    expect(await router.select('other')).toEqual({ ok: true })
    expect(fleet.select).toHaveBeenCalledWith('other')
    router.release(true)
    router.release()
    expect((fleet.release as ReturnType<typeof vi.fn>).mock.calls).toEqual([[true], [undefined]])
  })

  it('answers a lane that will not open and a refused selection, rather than throwing them', async () => {
    const fleet = fleetOf([REMOTE])
    fleet.online = vi.fn(async () => { throw new Error('backend unreachable') })
    fleet.select = vi.fn(async (machineId: string) => {
      if (machineId === 'other') throw new FleetError('NEEDS_LINK', 'Link office-imac to this computer first')
      throw new Error('socket closed')
    })
    const router = new FleetRouter(localOf(), fleet)
    expect(await router.online()).toEqual({ ok: false, message: 'backend unreachable' })
    expect(await router.select('other')).toEqual({ ok: false, code: 'NEEDS_LINK', message: 'Link office-imac to this computer first' })
    expect(await router.select('third')).toEqual({ ok: false, code: 'UNREACHABLE', message: 'socket closed' })
  })
})

describe('an answer reviewed on a device', () => {
  const answer: ReviewedAnswer = {
    agentId: 'a1', requestId: 'question-1',
    questions: [{ key: 'scope', q: 'Which scope?', options: ['File', 'Project'], multi: false }],
    answers: { scope: 'File' }, selections: { scope: ['File'] },
  }

  it('is confirmed by the local terminal, or says it could not be', async () => {
    const answerReviewed = vi.fn(async () => true)
    const router = new FleetRouter(localOf({ answerReviewed }, [session('a1', 1, 'claude')]))
    expect(await router.answerReviewed(answer)).toEqual({ ok: true })
    answerReviewed.mockResolvedValue(false)
    expect(await router.answerReviewed(answer)).toEqual({ ok: false, error: 'Could not confirm the answer. Check the terminal.' })
    expect(await new FleetRouter(localOf()).answerReviewed(answer)).toEqual({ ok: false, error: 'Update Harness to answer this question.' })
  })

  it('takes spoken free text only for a known local agent that can confirm it', async () => {
    const answerReviewed = vi.fn(async () => true)
    const fleet = fleetOf([REMOTE], { other: [{ id: 'r1', name: 'api' }] })
    const router = new FleetRouter(localOf({ answerReviewed }, [session('a1', 1, 'claude')]), fleet)
    await settled(router)
    expect(router.canSpeakQuestion('a1')).toBe(true)
    expect(router.canSpeakQuestion('r1')).toBe(false)
    expect(router.canSpeakQuestion('ghost')).toBe(false)
    // A known local agent on a daemon that cannot confirm a reviewed answer.
    const unconfirmed = new FleetRouter(localOf({}, [session('a1', 1)]))
    await unconfirmed.listAgentsFlat()
    expect(unconfirmed.canSpeakQuestion('a1')).toBe(false)
    const spoken = { ...answer, freeTextKeys: ['scope'] }
    expect(await router.answerReviewed(spoken)).toEqual({ ok: true })
    expect(await router.answerReviewed({ ...spoken, agentId: 'r1' })).toEqual({ ok: false, error: 'Use the terminal to type this answer.' })
    expect(await router.answerReviewed({ ...answer, freeTextKeys: [] })).toEqual({ ok: true })
  })

  it('is handed to a remote machine, never to one that is unreachable, and never as a comma-split multi-select', async () => {
    const fleet = fleetOf([REMOTE])
    const router = new FleetRouter(localOf(), fleet)
    router.noteAgent('other', 'r1')
    const remote = { ...answer, agentId: 'r1' }
    // An older fleet that has only the plain answer.
    expect(await router.answerReviewed(remote)).toEqual({ ok: true, pending: true })
    expect(fleet.answer).toHaveBeenCalledWith('other', 'r1', 'question-1', { scope: 'File' })
    fleet.answerReviewed = vi.fn()
    expect(await router.answerReviewed(remote)).toEqual({ ok: true, pending: true })
    expect(fleet.answerReviewed).toHaveBeenCalledWith('other', remote)
    fleet.reachable = () => ({ ok: false, at: Date.now() })
    expect(await router.answerReviewed(remote)).toEqual({ ok: false, error: 'That machine is unavailable. Check its connection.' })
    fleet.reachable = () => ({ ok: true, at: Date.now() })
    const multi = { ...remote, questions: [{ ...remote.questions[0], multi: true }] }
    expect(await router.answerReviewed({ ...multi, selections: { scope: ['CSV, UTF-8'] } })).toEqual({ ok: false, error: 'Use the terminal for this multi-select answer.' })
    expect(await router.answerReviewed({ ...multi, selections: {} })).toEqual({ ok: true, pending: true })
    expect(await router.answerReviewed({ ...multi, selections: { scope: ['CSV'] } })).toEqual({ ok: true, pending: true })
    // No fleet at all: a remote agent heard from cannot be answered.
    const alone = new FleetRouter(localOf())
    alone.noteAgent('other', 'r1')
    expect(await alone.answerReviewed(remote)).toEqual({ ok: false, error: 'That machine is unavailable. Check its connection.' })
  })
})
