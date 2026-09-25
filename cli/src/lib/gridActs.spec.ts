/**
 * A person's act wakes a grid, and nothing else does (grid-reads-without-waking issue 03) — against a fake
 * relay that records every request it receives and a fake `grid` first on PATH.
 *
 * What is asserted is what leaves the seam: the sections a picker is given, the note an agent frame
 * carries, and the requests that reached the relay (path, Authorization, User-Agent). The clock is the
 * service's injected `now`, and the explicit wake's 3 s pauses are the injected `sleep`, which moves that
 * clock — so 45 s of re-reads run in milliseconds and every time rule is exercised without waiting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFakeGrid, type FakeGrid, type FakeGridPlan } from './__fixtures__/fakeGrid.js'
import { startFakeRelay, type FakeRelay, type RelayAnswer, type RelayRequest } from './__fixtures__/fakeRelay.js'
import { agentFrame } from './agentFrame.js'
import { presentGridSections, resetGridModels, type GridModelsService, type GridSection } from './gridModels.js'
import type { RegisteredSession } from './registry.js'

const OWN = 'mine', OWN_ID = 'net-own', TEAM = 'team', TEAM_ID = 'net-team'
const EMAIL = 'me@example.com', TOKEN = 'grid-token-123'
const OVERVIEW = '/relay/v1/grid/overview', MODELS = '/relay/v1/models'
const HERE = 'computer-here'
const OWN_REF = { networkId: OWN_ID, gridName: OWN }, TEAM_REF = { networkId: TEAM_ID, gridName: TEAM }

let relay: FakeRelay, root: string, gridHome: string, grid: FakeGrid, service: GridModelsService, clock: number
/** What the service asked to be called back about later (an expiry), for a test to run when it likes. */
let later_: Array<{ ms: number; run: () => void }>

const at = (gridId: string, path: string): string => `/g/${gridId}${path}`
const answer = (gridId: string, path: string, value: RelayAnswer | (() => RelayAnswer)): void => relay.answer(at(gridId, path), value)
const node = (name: string, models: string[], extra: Record<string, unknown> = {}) =>
  ({ name, engine: 'llama.cpp', models, online: true, provider_email: EMAIL, ...extra })
const awake = (nodes: unknown[]): RelayAnswer => ({ status: 200, body: { nodes, models: [] } })
const asleep = (lastKnown?: unknown): RelayAnswer =>
  ({ status: 503, body: { detail: 'resting', code: 'grid_asleep', ...(lastKnown === undefined ? {} : { last_known: lastKnown }) } })
const record = (ageSeconds: number, nodes: Array<{ name: string; models: string[] }>) =>
  ({ age_seconds: ageSeconds, nodes: nodes.map((n) => ({ engine: 'llama.cpp', ...n })), ids: [] })

function plan(ownStatus: string | null = 'running'): FakeGridPlan {
  const env = (id: string) => ({ stdout: `export OPENAI_BASE_URL="${relay.base}/g/${id}/relay/v1"\nexport OPENAI_API_KEY="${TOKEN}"\n` })
  return {
    ls: { stdout: JSON.stringify([{ grid: OWN, id: OWN_ID, type: 'permissioned-public' }, { grid: TEAM, id: TEAM_ID, type: 'permissioned-providers' }]) },
    [`info ${OWN}`]: { stdout: JSON.stringify({ grid: OWN, status: ownStatus, grid_url: `${relay.base}/g/${OWN_ID}` }) },
    [`info ${TEAM}`]: { stdout: JSON.stringify({ grid: TEAM, status: null, grid_url: `${relay.base}/g/${TEAM_ID}` }) },
    [`info ${OWN} --env`]: env(OWN_ID),
    [`info ${TEAM} --env`]: env(TEAM_ID),
  }
}

const requests = (gridId: string, path: string): RelayRequest[] => relay.seen.filter((r) => r.path === at(gridId, path))
const section = (sections: GridSection[], name: string): GridSection => sections.find((s) => s.name === name)!

/** Ask as a picker does, let every read (and wake) it started land, then ask again for what they produced. */
async function look(opts: { wake?: string[] } = {}): Promise<GridSection[]> {
  await service.sections(OWN, opts)
  await service.settled()
  return service.sections(OWN, { refresh: false })
}

const later = (seconds = 125): void => { clock += seconds * 1000 }

/** The service a daemon starts with — a second call is the same daemon after a restart: nothing in memory,
 *  the pictures on disk. */
function freshService(): GridModelsService {
  return resetGridModels({
    now: () => clock, dataDir: () => join(root, 'data'), gridHome: () => gridHome, email: () => EMAIL,
    sleep: async (ms) => { clock += ms },
    after: (ms, run) => { later_.push({ ms, run }); return () => {} },
  })
}

/** A body `GET /api/machines` answers, as this daemon proxies it. */
const machineList = (machines: Array<{ id: string; hostname: string; name?: string; status: string }>, guest = false) => ({
  success: true,
  data: {
    machines: machines.map((m) => ({ machineId: m.id, computerId: m.id, hostname: m.hostname, name: m.name ?? null, status: m.status })),
    ...(guest ? { guest: true } : {}),
  },
})

/** The account's computers as two lists 60 s apart say them — long enough for an offline one to be labelled. */
function studioOfflineTwice(): void {
  const list = machineList([{ id: HERE, hostname: 'here' }, { id: 'studio-id', hostname: 'studio', name: 'Studio' }].map((m) =>
    ({ ...m, status: m.id === HERE ? 'running' : 'offline' })))
  service.observeMachines(list, HERE)
  later(60)
  service.observeMachines(list, HERE)
}

beforeEach(async () => {
  relay = await startFakeRelay()
  root = mkdtempSync(join(tmpdir(), 'grid-acts-'))
  gridHome = join(root, 'grid-home')
  mkdirSync(gridHome, { recursive: true })
  clock = Date.parse('2026-09-25T10:00:00Z')
  later_ = []
  service = freshService()
  grid = installFakeGrid(plan())
  answer(OWN_ID, OVERVIEW, awake([]))
  answer(TEAM_ID, OVERVIEW, asleep())
  answer(OWN_ID, MODELS, { status: 200, body: { data: [] } })
  answer(TEAM_ID, MODELS, { status: 200, body: { data: [] } })
})

afterEach(async () => {
  await service.settled()
  grid.dispose()
  await relay.close()
  rmSync(root, { recursive: true, force: true })
})

describe('an explicit wake', () => {
  it('answers "waking" at once, reads once WITH the credential, and re-reads without it until nodes are seen', async () => {
    await look()
    // The credentialed read is held the way the proxy holds one while a master boots.
    answer(TEAM_ID, MODELS, { status: 200, body: { data: [] }, delayMs: 1_500 })
    let overviews = 0
    answer(TEAM_ID, OVERVIEW, () => ++overviews < 3 ? asleep() : awake([node('rig', ['big-model'], { provider_email: 'mate@example.com' })]))

    const reply = await service.sections(OWN, { wake: [TEAM] })
    expect(section(reply, TEAM).state).toBe('waking')
    expect(requests(TEAM_ID, MODELS).length).toBeLessThanOrEqual(1)

    await service.settled()
    const after = await service.sections(OWN, { refresh: false })
    expect(section(after, TEAM)).toMatchObject({ state: 'awake', models: [{ id: 'big-model', node: 'rig' }] })
    expect(section(after, TEAM)).not.toHaveProperty('wakeOutcome')
    // Exactly one credentialed read, marked as a wake; the re-reads carry nothing and stop at nodes seen.
    const woken = requests(TEAM_ID, MODELS)
    expect(woken).toHaveLength(1)
    expect(woken[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(woken[0]!.headers['user-agent']).toMatch(/^autonomous-harness\/\S+ \(wake\)$/)
    expect(overviews).toBe(3)
    for (const read of relay.seen.filter((r) => r.path.endsWith(OVERVIEW))) {
      expect(read.headers.authorization).toBeUndefined()
      expect(read.headers['x-api-key']).toBeUndefined()
    }
  })

  it('ends "not started" when nothing comes up within 45 s, having re-read every 3 s', async () => {
    await look()
    const before = requests(TEAM_ID, OVERVIEW).length

    const sections = await look({ wake: [TEAM] })

    expect(section(sections, TEAM)).toMatchObject({ state: 'asleep', wakeOutcome: 'not_started' })
    expect(requests(TEAM_ID, OVERVIEW).length - before).toBe(15)
    expect(requests(TEAM_ID, MODELS)).toHaveLength(1)
  })

  it('ends "nobody serving" when it comes up with nobody on it', async () => {
    await look()
    answer(TEAM_ID, OVERVIEW, awake([node('router', ['auto'], { engine: 'grid-router' })]))

    expect(section(await look({ wake: [TEAM] }), TEAM)).toMatchObject({ state: 'awake', models: [], wakeOutcome: 'nobody_serving' })
  })

  it('a second ask while one is running joins it: one credentialed read', async () => {
    await look()
    await service.sections(OWN, { wake: [TEAM] })
    await service.sections(OWN, { wake: [TEAM] })
    await service.settled()

    expect(requests(TEAM_ID, MODELS)).toHaveLength(1)
  })

  it('its outcome stands 10 minutes, and goes once the section is read serving a model', async () => {
    await look()
    await look({ wake: [TEAM] })
    later(300)
    expect(section(await service.sections(OWN, { refresh: false }), TEAM).wakeOutcome).toBe('not_started')
    later(301)
    expect(section(await service.sections(OWN, { refresh: false }), TEAM)).not.toHaveProperty('wakeOutcome')

    await look({ wake: [TEAM] })
    answer(TEAM_ID, OVERVIEW, awake([node('rig', ['big-model'])]))
    later()
    expect(section(await look(), TEAM)).not.toHaveProperty('wakeOutcome')
  })

  it('re-reads the own grid through its asleep episode, where an automatic look reads it only once', async () => {
    grid.replan(plan('asleep'))
    answer(OWN_ID, OVERVIEW, asleep())
    await look()
    const before = requests(OWN_ID, OVERVIEW).length
    let overviews = 0
    answer(OWN_ID, OVERVIEW, () => ++overviews < 2 ? asleep() : awake([node('mac', ['small-q4'])]))

    expect(section(await look({ wake: [OWN] }), OWN)).toMatchObject({ state: 'awake', models: [{ id: 'small-q4', node: 'mac' }] })
    expect(requests(OWN_ID, OVERVIEW).length - before).toBe(2)
  })
})

describe('the retarget prewarm', () => {
  /** The team grid seen serving `big-model`, then asleep. */
  async function teamAsleepServing(): Promise<void> {
    answer(TEAM_ID, OVERVIEW, awake([node('rig', ['big-model'])]))
    await look()
    later()
    answer(TEAM_ID, OVERVIEW, asleep())
    await look()
  }

  it('fires one credentialed read marked (prewarm) for a sleeping grid, and the move never waits on it', async () => {
    await teamAsleepServing()
    answer(TEAM_ID, MODELS, { status: 200, body: { data: [] }, delayMs: 5_000 })

    const started = Date.now()
    expect(await service.retargetPrewarm(TEAM_REF, 'big-model')).toBe('fired')
    expect(Date.now() - started).toBeLessThan(2_000)

    await expectRequest(TEAM_ID, MODELS, 1)
    const [prewarm] = requests(TEAM_ID, MODELS)
    expect(prewarm!.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(prewarm!.headers['user-agent']).toMatch(/^autonomous-harness\/\S+ \(prewarm\)$/)
  })

  it('fires once per grid per 10 minutes', async () => {
    await teamAsleepServing()
    expect(await service.retargetPrewarm(TEAM_REF, 'big-model')).toBe('fired')
    later(599)
    expect(await service.retargetPrewarm(TEAM_REF, 'big-model')).toBe('debounced')
    later(1)
    expect(await service.retargetPrewarm(TEAM_REF, 'big-model')).toBe('fired')
    await expectRequest(TEAM_ID, MODELS, 2)
  })

  it('does not fire for a grid seen awake in the last 60 s, and does for one last seen longer ago', async () => {
    answer(TEAM_ID, OVERVIEW, awake([node('rig', ['big-model'])]))
    await look()
    later(59)
    expect(await service.retargetPrewarm(TEAM_REF, 'big-model')).toBe('awake')
    later(1)
    expect(await service.retargetPrewarm(TEAM_REF, 'big-model')).toBe('fired')
  })

  it('does not fire for a model the picture does not have', async () => {
    await teamAsleepServing()
    expect(await service.retargetPrewarm(TEAM_REF, 'other-model')).toBe('absent')
    expect(requests(TEAM_ID, MODELS)).toHaveLength(0)
  })

  it('does not fire when every computer serving the model seems offline', async () => {
    answer(OWN_ID, OVERVIEW, awake([node('studio', ['big-model'])]))
    await look()
    later()
    answer(OWN_ID, OVERVIEW, asleep())
    await look()
    studioOfflineTwice()

    expect(await service.retargetPrewarm(OWN_REF, 'big-model')).toBe('offline')
    expect(requests(OWN_ID, MODELS)).toHaveLength(0)
  })
})

describe('the keystroke prewarm', () => {
  const onTeam = (model: string | null) => ({ baseUrl: `${relay.base}/g/${TEAM_ID}/relay`, model })

  it('the first input for an agent on a sleeping grid fires one read marked (prewarm-key); more input within 10 min fires nothing', async () => {
    answer(TEAM_ID, OVERVIEW, awake([node('rig', ['big-model'])]))
    await look()
    later()
    answer(TEAM_ID, OVERVIEW, asleep())
    await look()

    expect(await service.keystrokePrewarm(onTeam('big-model'))).toBe('fired')
    expect(await service.keystrokePrewarm(onTeam('big-model'))).toBe('debounced')
    later(300)
    expect(await service.keystrokePrewarm(onTeam('big-model'))).toBe('debounced')

    await expectRequest(TEAM_ID, MODELS, 1)
    expect(requests(TEAM_ID, MODELS)[0]!.headers['user-agent']).toMatch(/^autonomous-harness\/\S+ \(prewarm-key\)$/)
  })

  it('fires nothing for an agent on its own login, on an awake grid, or on a grid this daemon does not know', async () => {
    answer(OWN_ID, OVERVIEW, awake([node('mac', ['small-q4'])]))
    await look()

    expect(await service.keystrokePrewarm(null)).toBe('untracked')
    expect(await service.keystrokePrewarm({ baseUrl: `${relay.base}/g/${OWN_ID}/relay`, model: 'small-q4' })).toBe('not-asleep')
    expect(await service.keystrokePrewarm({ baseUrl: `${relay.base}/g/net-elsewhere/relay`, model: null })).toBe('untracked')
    expect(relay.seen.some((r) => r.path.endsWith(MODELS))).toBe(false)
  })

  it('shares the 10 minutes with the retarget prewarm', async () => {
    answer(TEAM_ID, OVERVIEW, awake([node('rig', ['big-model'])]))
    await look()
    later()
    answer(TEAM_ID, OVERVIEW, asleep())
    await look()
    expect(await service.retargetPrewarm(TEAM_REF, 'big-model')).toBe('fired')
    expect(await service.keystrokePrewarm(onTeam('big-model'))).toBe('debounced')
  })
})

describe('computers of mine that seem offline', () => {
  /** The own grid seen with `studio` serving big-model and this computer (`here`) serving small-q4, then asleep. */
  async function ownAsleep(nodes: unknown[] = [node('studio', ['big-model']), node('here', ['small-q4'])]): Promise<void> {
    answer(OWN_ID, OVERVIEW, awake(nodes))
    await look()
    later()
    answer(OWN_ID, OVERVIEW, asleep())
    await look()
  }
  const own = async (rowState: boolean) =>
    section(presentGridSections(await service.sections(OWN, { refresh: false }), { rowState }), OWN).models

  it('labels a row whose computer read offline in two lists 60 s apart — never removes it', async () => {
    await ownAsleep()
    studioOfflineTwice()

    expect(await own(true)).toEqual([
      { id: 'big-model', node: 'studio', unavailable: { reason: 'offline', machine: 'Studio', since: new Date(clock - 60_000).toISOString() } },
      { id: 'small-q4', node: 'here' },
    ])
    // An old build, which asks for no row state, reads it in the node text.
    expect(await own(false)).toEqual([{ id: 'big-model', node: 'Studio · seems offline' }, { id: 'small-q4', node: 'here' }])
  })

  it.each<[string, () => Promise<void> | void]>([
    ['a single offline read', () => {
      service.observeMachines(machineList([{ id: 'studio-id', hostname: 'studio', status: 'offline' }]), HERE)
    }],
    ['two offline reads under 60 s apart', () => {
      const list = machineList([{ id: 'studio-id', hostname: 'studio', status: 'offline' }])
      service.observeMachines(list, HERE); later(59); service.observeMachines(list, HERE)
    }],
    ['a list gone stale', () => { studioOfflineTwice(); later(181) }],
    ['the signed-out guest list', () => {
      const list = machineList([{ id: 'studio-id', hostname: 'studio', status: 'offline' }], true)
      service.observeMachines(list, HERE); later(60); service.observeMachines(list, HERE)
    }],
    ['a name two computers share', () => {
      const list = machineList([{ id: 'a', hostname: 'studio', status: 'offline' }, { id: 'b', hostname: 'studio', status: 'offline' }])
      service.observeMachines(list, HERE); later(60); service.observeMachines(list, HERE)
    }],
    ['a presence the backend could not read (`unknown`)', () => {
      const list = machineList([{ id: 'studio-id', hostname: 'studio', status: 'unknown' }])
      service.observeMachines(list, HERE); later(60); service.observeMachines(list, HERE)
    }],
    ['an online read between two offline ones', () => {
      const offline = machineList([{ id: 'studio-id', hostname: 'studio', status: 'offline' }])
      service.observeMachines(offline, HERE); later(40)
      service.observeMachines(machineList([{ id: 'studio-id', hostname: 'studio', status: 'running' }]), HERE); later(40)
      service.observeMachines(offline, HERE)
    }],
  ])('labels nothing for %s', async (_name, arrange) => {
    await ownAsleep()
    await arrange()
    expect((await own(true)).some((row) => 'unavailable' in row)).toBe(false)
  })

  it('labels nothing while the grid is awake', async () => {
    answer(OWN_ID, OVERVIEW, awake([node('studio', ['big-model'])]))
    await look()
    studioOfflineTwice()
    expect(await own(true)).toEqual([{ id: 'big-model', node: 'studio' }])
  })

  it('labels nothing on a shared grid whose node is not marked the account\'s own', async () => {
    answer(TEAM_ID, OVERVIEW, awake([node('studio', ['big-model'], { provider_email: 'mate@example.com' })]))
    await look()
    later()
    answer(TEAM_ID, OVERVIEW, asleep())
    await look()
    studioOfflineTwice()
    const team = section(presentGridSections(await service.sections(OWN, { refresh: false }), { rowState: true }), TEAM)
    expect(team.models).toEqual([{ id: 'big-model', node: 'studio' }])
  })

  it('labels nothing for a model another, online computer also serves', async () => {
    await ownAsleep([node('studio', ['big-model']), node('here', ['big-model'])])
    studioOfflineTwice()
    expect((await own(true)).some((row) => 'unavailable' in row)).toBe(false)
  })
})

describe('the note on an agent already on a model', () => {
  const onOwn = (model: string | null) => ({ baseUrl: `${relay.base}/g/${OWN_ID}/relay`, model })

  it('says the computers serving its model seem offline', async () => {
    // The overview lower-cases a node's ids; the exact spelling comes from its curated list.
    answer(OWN_ID, OVERVIEW, { status: 200, body: { nodes: [node('studio', ['big-model'])], models: [{ id: 'Big-Model' }] } })
    await look()
    later()
    answer(OWN_ID, OVERVIEW, asleep())
    await look()
    studioOfflineTwice()
    await service.sections(OWN, { refresh: false })

    expect(service.annotation(onOwn('big-model'))).toEqual({
      state: 'asleep', note: { reason: 'offline', model: 'Big-Model', machine: 'Studio' },
    })
  })

  it('says the latest record no longer lists its model, and clears on a credential-less read that lists it', async () => {
    answer(OWN_ID, OVERVIEW, awake([node('mac', ['small-q4'])]))
    await look()
    later()
    answer(OWN_ID, OVERVIEW, asleep(record(30, [{ name: 'mac', models: ['other-model'] }])))
    await look()

    expect(service.annotation(onOwn('small-q4'))).toEqual({ state: 'asleep', note: { reason: 'not_served', model: 'small-q4' } })

    answer(OWN_ID, OVERVIEW, awake([node('mac', ['small-q4'])]))
    later()
    await look()
    expect(service.annotation(onOwn('small-q4'))).toEqual({ state: 'awake' })
    expect(relay.seen.every((r) => r.headers.authorization === undefined)).toBe(true)
  })

  it('rides on the agent frame every client rebuilds the agent from', async () => {
    answer(OWN_ID, OVERVIEW, asleep(record(30, [{ name: 'mac', models: ['other-model'] }])))
    await look()
    const agent = { agentId: 'a1', sessionId: 's1', engine: 'claude', active: true, cwd: '/tmp', runtimes: [], registeredAt: 1,
      grid: onOwn('small-q4') } as unknown as RegisteredSession

    const frame = await agentFrame(agent, { selectedModel: null, terminalAvailable: true })

    expect(frame.grid).toEqual({ ...onOwn('small-q4'), state: 'asleep', note: { reason: 'not_served', model: 'small-q4' } })
  })

  it('has no note for Auto, and no annotation for a grid this daemon does not know', async () => {
    answer(OWN_ID, OVERVIEW, asleep(record(30, [{ name: 'mac', models: ['other-model'] }])))
    await look()
    expect(service.annotation(onOwn(null))).toEqual({ state: 'asleep' })
    expect(service.annotation({ baseUrl: `${relay.base}/g/net-elsewhere/relay`, model: 'x' })).toBeNull()
  })
})

describe('no read on the app\'s own schedule carries a credential, with the acts above in place', () => {
  it('looks, a Model Manager inventory and a launch check send no Authorization and no x-api-key', async () => {
    answer(OWN_ID, OVERVIEW, awake([node('mac', ['small-q4'])]))
    studioOfflineTwice()
    await look()
    later(); await look()
    await service.inventory(OWN, true)
    await service.models(TEAM)

    expect(relay.seen.length).toBeGreaterThan(0)
    for (const request of relay.seen) {
      expect(request.path.endsWith(MODELS)).toBe(false)
      expect(request.headers.authorization).toBeUndefined()
      expect(request.headers['x-api-key']).toBeUndefined()
    }
  })
})

/** A detached read lands on its own time; wait (in real time) for the relay to have seen it. */
async function expectRequest(gridId: string, path: string, count: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (requests(gridId, path).length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  expect(requests(gridId, path)).toHaveLength(count)
}

describe('after the daemon restarts', () => {
  const onTeam = (model: string | null) => ({ baseUrl: `${relay.base}/g/${TEAM_ID}/relay`, model })

  it('a keystroke and an agent frame answer from the saved pictures before any window asks for the list', async () => {
    answer(TEAM_ID, OVERVIEW, awake([node('rig', ['big-model'])]))
    await look()
    later()
    answer(TEAM_ID, OVERVIEW, asleep())
    await look()
    // It updated itself: nothing in memory, and nobody has opened a picker since (a phone typing, say).
    service = freshService()
    const reads = relay.seen.length

    await service.warm()

    expect(service.annotation(onTeam('big-model'))).toEqual({ state: 'asleep' })
    expect(service.annotation(onTeam('other-model'))).toEqual({ state: 'asleep', note: { reason: 'not_served', model: 'other-model' } })
    // Warming read the pictures on disk, not the grid.
    expect(relay.seen.length).toBe(reads)
    expect(await service.keystrokePrewarm(onTeam('big-model'))).toBe('fired')
    await expectRequest(TEAM_ID, MODELS, 1)
  })
})

describe('a credentialed read\'s answer', () => {
  it('teaches the picture each model\'s context window, for the next move onto it', async () => {
    answer(TEAM_ID, OVERVIEW, asleep(record(60, [{ name: 'rig', models: ['big-model'] }])))
    await look()
    expect(await service.contextWindow(TEAM_REF, 'Big-Model')).toBeUndefined()
    answer(TEAM_ID, MODELS, { status: 200, body: { data: [{ id: 'Big-Model', context_window: 131072 }, { id: 'odd', context_window: 'x' }] } })

    expect(await service.retargetPrewarm(TEAM_REF, 'big-model')).toBe('fired')

    await vi.waitFor(async () => expect(await service.contextWindow(TEAM_REF, 'big-model')).toBe(131072))
    expect(await service.contextWindow(TEAM_REF, 'odd')).toBeUndefined()
  })
})

describe('what goes stale with no read to say so', () => {
  it('a wake\'s outcome running out, and the machine list going stale, are pushed', async () => {
    const pushed: number[] = []
    service.onChange(() => pushed.push(clock))
    await look()
    await look({ wake: [TEAM] })
    const outcome = later_.find((entry) => entry.ms >= 10 * 60_000)
    expect(outcome).toBeDefined()
    studioOfflineTwice()
    const stale = later_.find((entry) => entry.ms >= 3 * 60_000 && entry.ms < 10 * 60_000)
    expect(stale).toBeDefined()

    await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(0))
    pushed.length = 0
    later(601)
    outcome!.run()
    await vi.waitFor(() => expect(pushed.length).toBe(1))
    expect(section(await service.sections(OWN, { refresh: false }), TEAM)).not.toHaveProperty('wakeOutcome')
    stale!.run()
    await vi.waitFor(() => expect(pushed.length).toBe(2))
  })
})
