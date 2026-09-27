import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
const mocks = vi.hoisted(() => ({
  prisma: { zoo: { findUnique: vi.fn(), updateMany: vi.fn(), create: vi.fn() }, machine: { findMany: vi.fn() }, daemonMint: { upsert: vi.fn() } },
  changed: vi.fn(), auth: vi.fn(),
}))
vi.mock('../lib/prisma.js', () => ({ prisma: mocks.prisma }))
vi.mock('../lib/bus.js', () => ({ publishZooChanged: mocks.changed }))
vi.mock('../lib/ssoAuth.js', async original => ({ ...await original<typeof import('../lib/ssoAuth.js')>(), authenticateAccessToken: mocks.auth }))
import { zooRoutes } from './zoo.js'
import { DAEMONS_EVERYONE, parseDaemonsSwitch, type DaemonsSwitch } from '../lib/daemonsSwitch.js'
import { emptyZoo, type Zoo } from '../lib/zoo.js'
import { DAEMON_ROSTER } from '../lib/daemonRoster.g.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'

const user = { sub: 'u1', email: 'd@example.com', role: 'user', autonomousEnv: 'prod' as const }
const withHabits = (habits: string[]): Zoo => ({ ...emptyZoo(), habits })
const egg = { id: 'e1', kind: 'first', grantedAt: '2026-09-26T00:00:00.000Z' }

describe('zoo routes', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    vi.resetAllMocks()
    mocks.auth.mockResolvedValue(user)
    mocks.changed.mockResolvedValue(1)
    app = Fastify(); app.setErrorHandler(errorHandler); registerAuthMiddleware(app, mocks.auth)
    // The server's daemons switch on for everyone (lib/daemonsSwitch.ts): what these tests are about.
    await app.register(zooRoutes, { daemons: DAEMONS_EVERYONE }); await app.ready()
  })
  afterEach(async () => { await app.close() })
  const auth = { authorization: 'Bearer fixture' }
  const post = (ops: unknown) => app.inject({ method: 'POST', url: '/api/zoo/ops', headers: auth, payload: { ops } as any })

  it('answers an empty zoo for a user who has none', async () => {
    mocks.prisma.zoo.findUnique.mockResolvedValue(null)
    const res = await app.inject({ method: 'GET', url: '/api/zoo', headers: auth })
    expect(res.json()).toEqual({ success: true, data: { revision: 0, zoo: emptyZoo() } })
    expect(mocks.prisma.zoo.findUnique).toHaveBeenCalledWith({ where: { userId: 'u1' } })
  })

  it('serves a stored zoo with its malformed entries dropped', async () => {
    mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 4, state: { ...withHabits(['turn', 'bogus key']), eggs: [egg, { id: 'x' }], pity: 'lots' } })
    const res = await app.inject({ method: 'GET', url: '/api/zoo', headers: auth })
    expect(res.json().data).toEqual({ revision: 4, zoo: { ...withHabits(['turn']), eggs: [egg] } })
  })

  it('refuses a caller with no session, like the desk', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/zoo' })
    expect(res.statusCode).toBe(401)
    expect(mocks.prisma.zoo.findUnique).not.toHaveBeenCalled()
  })

  it('creates the row on the first write and tells every adapter of the user', async () => {
    mocks.prisma.zoo.findUnique.mockResolvedValue(null)
    mocks.prisma.zoo.updateMany.mockResolvedValue({ count: 0 })
    mocks.prisma.zoo.create.mockResolvedValue({})
    const res = await post([{ op: 'zoo.habit', key: 'turn' }])
    expect(res.json().data).toEqual({ revision: 1, zoo: withHabits(['turn']), hatched: [], grants: [], levelUps: [] })
    expect(mocks.prisma.zoo.create).toHaveBeenCalledWith({ data: { userId: 'u1', revision: 1, state: withHabits(['turn']) } })
    expect(mocks.changed).toHaveBeenCalledWith('u1', { revision: 1 })
  })

  it('re-reads when another client created the row at the same moment', async () => {
    mocks.prisma.zoo.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ revision: 1, state: withHabits(['split']) })
    mocks.prisma.zoo.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
    mocks.prisma.zoo.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }))
    const res = await post([{ op: 'zoo.habit', key: 'turn' }])
    expect(res.json().data).toEqual({ revision: 2, zoo: withHabits(['split', 'turn']), hatched: [], grants: [], levelUps: [] })
    expect(mocks.prisma.zoo.updateMany).toHaveBeenLastCalledWith({ where: { userId: 'u1', revision: 1 }, data: { revision: 2, state: withHabits(['split', 'turn']) } })
  })

  it('bumps the revision with a compare-and-set, and replays on a lost race', async () => {
    // (No 'turn' among them: three habits with a finished turn would earn the first egg.)
    mocks.prisma.zoo.findUnique
      .mockResolvedValueOnce({ revision: 3, state: withHabits(['split']) })
      .mockResolvedValueOnce({ revision: 4, state: withHabits(['split', 'find']) })
    mocks.prisma.zoo.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
    const res = await post([{ op: 'zoo.habit', key: 'store' }])
    expect(res.json().data).toEqual({ revision: 5, zoo: withHabits(['split', 'find', 'store']), hatched: [], grants: [], levelUps: [] })
    expect(mocks.prisma.zoo.create).not.toHaveBeenCalled()
    expect(mocks.changed).toHaveBeenCalledOnce()
  })

  it('hatches on the server and answers what came out, with its serial', async () => {
    mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 2, state: { ...emptyZoo(), eggs: [egg] } })
    mocks.prisma.zoo.updateMany.mockResolvedValue({ count: 1 })
    mocks.prisma.daemonMint.upsert.mockResolvedValue({ count: 42 })
    const res = await post([{ op: 'zoo.hatch', eggId: 'e1' }])
    const data = res.json().data
    expect(data.revision).toBe(3)
    expect(data.hatched).toEqual([{ eggId: 'e1', daemonId: expect.any(String), shiny: expect.any(Boolean), serial: 42 }])
    const id = data.hatched[0].daemonId
    expect(DAEMON_ROSTER.daemons.map((d) => d.id)).toContain(id)
    expect(data.zoo).toMatchObject({ eggs: [], pair: id, daemons: [{ id, egg: 'first', bond: 0, version: '0.1', serial: 42 }] })
    // One atomic increment of that daemon's counter, created at 1 the first time it hatches anywhere.
    expect(mocks.prisma.daemonMint.upsert).toHaveBeenCalledExactlyOnceWith({
      where: { daemonId: id }, create: { daemonId: id, count: 1 }, update: { count: { increment: 1 } }, select: { count: true },
    })
    expect(mocks.prisma.zoo.updateMany.mock.calls[0][0].data.state.daemons[0]).toMatchObject({ id, serial: 42 })
  })

  describe('serials', () => {
    const regulars = DAEMON_ROSTER.daemons.filter((d) => d.rarity !== 'secret').map((d) => d.id)
    const daemon = (id: string) => ({ id, hatchedAt: '2026-09-01T00:00:00.000Z', egg: 'first', shiny: false, bond: 0, xp: 0, version: '0.1' })
    const turnEgg = { id: 'e1', kind: 'turn', grantedAt: '2026-09-26T00:00:00.000Z' }
    // Every regular but tim owned: a turn egg can only give tim, so every attempt draws the same.
    const onlyTimLeft = () => ({ ...emptyZoo(), daemons: regulars.filter((id) => id !== 'tim').map(daemon), eggs: [turnEgg] })

    it('mints none for a duplicate, which merges into the daemon you have', async () => {
      mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 2, state: { ...emptyZoo(), daemons: regulars.map(daemon), eggs: [turnEgg] } })
      mocks.prisma.zoo.updateMany.mockResolvedValue({ count: 1 })
      const res = await post([{ op: 'zoo.hatch', eggId: 'e1' }])
      const { hatched, zoo } = res.json().data
      expect(hatched).toEqual([{ eggId: 'e1', daemonId: expect.any(String), shiny: expect.any(Boolean), duplicate: true, xp: 150 }])
      expect(zoo.daemons).toHaveLength(regulars.length)
      expect(zoo.daemons.find((d: { id: string }) => d.id === hatched[0].daemonId)).toMatchObject({ dupes: 1, xp: 150 })
      expect(mocks.prisma.daemonMint.upsert).not.toHaveBeenCalled()
    })

    it('keeps a serial minted for a write that lost the race for the retry\'s hatch', async () => {
      mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 4, state: onlyTimLeft() })
      mocks.prisma.zoo.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 })
      mocks.prisma.daemonMint.upsert.mockResolvedValueOnce({ count: 7 }).mockResolvedValueOnce({ count: 8 })
      const res = await post([{ op: 'zoo.hatch', eggId: 'e1' }])
      expect(res.json().data.hatched).toEqual([{ eggId: 'e1', daemonId: 'tim', shiny: expect.any(Boolean), serial: 7 }])
      expect(mocks.prisma.daemonMint.upsert).toHaveBeenCalledOnce()
      expect(mocks.prisma.zoo.updateMany).toHaveBeenCalledTimes(2)
      expect(mocks.prisma.zoo.updateMany.mock.calls[1][0].data.state.daemons.at(-1)).toMatchObject({ id: 'tim', serial: 7 })
    })

    it('increments when two first hatches of a daemon both tried to create its counter', async () => {
      mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 4, state: onlyTimLeft() })
      mocks.prisma.zoo.updateMany.mockResolvedValue({ count: 1 })
      mocks.prisma.daemonMint.upsert
        .mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }))
        .mockResolvedValueOnce({ count: 2 })
      const res = await post([{ op: 'zoo.hatch', eggId: 'e1' }])
      expect(res.json().data.hatched[0]).toMatchObject({ daemonId: 'tim', serial: 2 })
      expect(mocks.prisma.daemonMint.upsert).toHaveBeenCalledTimes(2)
    })

    it('writes nothing when minting fails for another reason', async () => {
      mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 4, state: onlyTimLeft() })
      mocks.prisma.daemonMint.upsert.mockRejectedValue(new Error('mongo down'))
      const res = await post([{ op: 'zoo.hatch', eggId: 'e1' }])
      expect(res.statusCode).toBe(500)
      expect(mocks.prisma.zoo.updateMany).not.toHaveBeenCalled()
      expect(mocks.changed).not.toHaveBeenCalled()
    })

    it('mints none for a guest\'s daemons: they arrive local, without a serial', async () => {
      mocks.prisma.zoo.findUnique.mockResolvedValue(null)
      mocks.prisma.zoo.updateMany.mockResolvedValue({ count: 0 })
      mocks.prisma.zoo.create.mockResolvedValue({})
      const res = await post([{ op: 'zoo.seed', zoo: { daemons: [{ ...daemon('gnu'), serial: 3 }] } }])
      expect(res.json().data.zoo.daemons).toEqual([{ ...daemon('gnu'), origin: 'local' }])
      expect(mocks.prisma.daemonMint.upsert).not.toHaveBeenCalled()
    })
  })

  it('writes nothing, and says where the zoo is, when the ops change nothing', async () => {
    mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 7, state: withHabits(['turn']) })
    const res = await post([{ op: 'zoo.hatch', eggId: 'gone' }, { op: 'zoo.habit', key: 'turn' }, { op: 'zoo.easter', word: 'plugh' }])
    expect(res.json().data).toEqual({ revision: 7, zoo: withHabits(['turn']), hatched: [], grants: [], levelUps: [] })
    expect(mocks.prisma.zoo.updateMany).not.toHaveBeenCalled()
    expect(mocks.changed).not.toHaveBeenCalled()
  })

  it('refuses a malformed op, a nickname past 24 characters, and a client-sent result', async () => {
    mocks.prisma.zoo.findUnique.mockResolvedValue(null)
    expect((await post([{ op: 'zoo.explode' }])).statusCode).toBe(400)
    expect((await post([{ op: 'zoo.nickname', id: 'tim', nickname: 'x'.repeat(25) }])).statusCode).toBe(400)
    expect((await post([{ op: 'zoo.hatch', eggId: 'e1', daemonId: 'beastie' }])).statusCode).toBe(400)
    expect((await post([])).statusCode).toBe(400)
    expect(mocks.prisma.zoo.findUnique).not.toHaveBeenCalled()
  })

  it('counts reported turns, asks which machines are the account\'s, and answers eggs and levels', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-26T12:00:00.000Z'))
    try {
      const tim = { id: 'tim', hatchedAt: '2026-09-01T00:00:00.000Z', egg: 'first', shiny: false, bond: 0, xp: 40, version: '0.1' }
      const progress = { turns: 39, machines: ['mac-1'] }
      mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 5, state: { ...emptyZoo(), daemons: [tim], pair: 'tim', progress } })
      mocks.prisma.zoo.updateMany.mockResolvedValue({ count: 1 })
      mocks.prisma.machine.findMany.mockResolvedValue([{ machineId: 'mac-1' }])
      const turn = (batchId: string, machineId: string) => ({ op: 'zoo.turn', batchId, n: 5, day: '2026-09-26', hour: 10, machineId })
      const res = await post([turn('b1', 'mac-1'), turn('b2', 'someone-elses')])
      expect(res.statusCode).toBe(200)
      expect(mocks.prisma.machine.findMany).toHaveBeenCalledWith({ where: { userId: 'u1', machineId: { in: ['mac-1', 'someone-elses'] } }, select: { machineId: true } })
      const data = res.json().data
      expect(data.grants).toEqual([{ kind: 'turn', eggId: expect.any(String) }])
      expect(data.levelUps).toEqual([{ id: 'tim', level: 1, version: '0.1' }])      // 40 + 5 + 10
      expect(data.zoo.daemons[0]).toMatchObject({ xp: 55, bond: 1 })
      expect(data.zoo.progress).toMatchObject({ turns: 49, machines: ['mac-1'], marathon: [], batches: ['b1', 'b2'] })
      expect(mocks.changed).toHaveBeenCalledWith('u1', { revision: 6 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('tells the other clients only about what they draw: a report that only tallied publishes nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-26T12:00:00.000Z'))
    try {
      const tim = { id: 'tim', hatchedAt: '2026-09-01T00:00:00.000Z', egg: 'first', shiny: false, bond: 0, xp: 5, version: '0.1' }
      mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 5, state: { ...emptyZoo(), daemons: [tim], pair: 'tim', progress: { turns: 3, days: { '2026-09-26': 3 } } } })
      mocks.prisma.zoo.updateMany.mockResolvedValue({ count: 1 })
      mocks.prisma.machine.findMany.mockResolvedValue([{ machineId: 'mac-1' }])
      // Two turns: progress and xp move, no egg, no level. Written (the revision moves), not published.
      const tally = await post([{ op: 'zoo.turn', batchId: 'b1', n: 2, day: '2026-09-26', hour: 10, machineId: 'mac-1' }])
      expect(tally.statusCode).toBe(200)
      expect(tally.json().data).toMatchObject({ revision: 6, grants: [], levelUps: [] })
      expect(tally.json().data.zoo.daemons[0]).toMatchObject({ xp: 7, bond: 0 })
      expect(mocks.prisma.zoo.updateMany).toHaveBeenCalledOnce()
      expect(mocks.changed).not.toHaveBeenCalled()
      // An approved lesson short of a level: the same.
      const lesson = await post([{ op: 'zoo.lesson', lessonId: 'l1', daemonId: 'tim' }])
      expect(lesson.json().data.levelUps).toEqual([])
      expect(mocks.changed).not.toHaveBeenCalled()
      // Enough to level up: a client draws that (its bond), so it is published.
      mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 7, state: { ...emptyZoo(), daemons: [{ ...tim, xp: 45 }], pair: 'tim' } })
      const level = await post([{ op: 'zoo.turn', batchId: 'b2', n: 5, day: '2026-09-26', hour: 11, machineId: 'mac-1' }])
      expect(level.json().data.levelUps).toEqual([{ id: 'tim', level: 1, version: '0.1' }])
      expect(mocks.changed).toHaveBeenCalledExactlyOnceWith('u1', { revision: 8 })
      // A habit, the dial, a nickname: all drawn, all published.
      mocks.changed.mockClear()
      mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 8, state: { ...emptyZoo(), daemons: [tim], pair: 'tim' } })
      for (const op of [{ op: 'zoo.habit', key: 'split' }, { op: 'zoo.autonomy', level: 'suggest' }, { op: 'zoo.nickname', id: 'tim', nickname: 'timmy' }]) {
        await post([op])
      }
      expect(mocks.changed).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('credits an approved lesson once, to the daemon that found it, and answers its level', async () => {
    const tim = { id: 'tim', hatchedAt: '2026-09-01T00:00:00.000Z', egg: 'first', shiny: false, bond: 0, xp: 40, version: '0.1' }
    mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 3, state: { ...emptyZoo(), daemons: [tim], pair: 'tim' } })
    mocks.prisma.zoo.updateMany.mockResolvedValue({ count: 1 })
    const res = await post([{ op: 'zoo.lesson', lessonId: '3f2a9c1b', daemonId: 'tim' }])
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.levelUps).toEqual([{ id: 'tim', level: 1, version: '0.1' }])      // 40 + 25
    expect(data.zoo.daemons[0]).toMatchObject({ xp: 65, bond: 1 })
    expect(data.zoo.progress.lessons).toEqual(['3f2a9c1b'])
    expect(mocks.prisma.machine.findMany).not.toHaveBeenCalled()
    // The same lesson again (a retry whose answer was lost) writes nothing.
    mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 4, state: data.zoo })
    mocks.prisma.zoo.updateMany.mockClear()
    const again = await post([{ op: 'zoo.lesson', lessonId: '3f2a9c1b', daemonId: 'tim' }])
    expect(again.json().data).toMatchObject({ revision: 4, levelUps: [] })
    expect(mocks.prisma.zoo.updateMany).not.toHaveBeenCalled()
    expect((await post([{ op: 'zoo.lesson', lessonId: 'has space', daemonId: 'tim' }])).statusCode).toBe(400)
  })

  it('never asks about machines when no turn is reported, and refuses an absurd report', async () => {
    mocks.prisma.zoo.findUnique.mockResolvedValue(null)
    mocks.prisma.zoo.updateMany.mockResolvedValue({ count: 0 })
    mocks.prisma.zoo.create.mockResolvedValue({})
    await post([{ op: 'zoo.habit', key: 'turn' }])
    expect(mocks.prisma.machine.findMany).not.toHaveBeenCalled()
    for (const bad of [{ n: 500 }, { n: 0 }, { hour: 24 }, { day: '2026-02-30' }, { day: 'today' }, { machineId: '' }]) {
      const res = await post([{ op: 'zoo.turn', batchId: 'b1', n: 1, day: '2026-09-26', hour: 1, machineId: 'm', ...bad }])
      expect(res.statusCode, JSON.stringify(bad)).toBe(400)
    }
    expect(mocks.prisma.machine.findMany).not.toHaveBeenCalled()
  })

  it('gives up after five lost races rather than spinning', async () => {
    mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 2, state: emptyZoo() })
    mocks.prisma.zoo.updateMany.mockResolvedValue({ count: 0 })
    const res = await post([{ op: 'zoo.habit', key: 'turn' }])
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('ZOO_BUSY')
    expect(mocks.prisma.zoo.updateMany).toHaveBeenCalledTimes(5)
    expect(mocks.changed).not.toHaveBeenCalled()
  })
})

describe('zoo routes behind the daemons switch', () => {
  const auth = { authorization: 'Bearer fixture' }
  const apps: FastifyInstance[] = []
  const build = async (daemons?: DaemonsSwitch): Promise<FastifyInstance> => {
    const app = Fastify(); app.setErrorHandler(errorHandler); registerAuthMiddleware(app, mocks.auth)
    await app.register(zooRoutes, daemons ? { daemons } : {}); await app.ready()
    apps.push(app)
    return app
  }
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.auth.mockResolvedValue(user)
    mocks.changed.mockResolvedValue(1)
    mocks.prisma.zoo.findUnique.mockResolvedValue(null)
    mocks.prisma.zoo.updateMany.mockResolvedValue({ count: 0 })
    mocks.prisma.zoo.create.mockResolvedValue({})
  })
  afterEach(async () => { for (const app of apps.splice(0)) await app.close() })

  /** What this server answers for a path it never registered: the 404 every client already knows. */
  const ordinary404 = async (app: FastifyInstance, method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, headers: auth, ...(payload !== undefined ? { payload: payload as any } : {}) })
    return { status: res.statusCode, body: res.json() }
  }
  const nowhere = async (method: 'GET' | 'POST', url: string, payload?: unknown) => ordinary404(await build(), method, url.replace('/api/zoo', '/api/nothing-here'), payload)

  it('registers nothing when the switch is off, which is the default: the ordinary 404, no read, no write, no push', async () => {
    for (const app of [await build(), await build(parseDaemonsSwitch(undefined)), await build(parseDaemonsSwitch('false', 'u1'))]) {
      const read = await ordinary404(app, 'GET', '/api/zoo')
      const ops = await ordinary404(app, 'POST', '/api/zoo/ops', { ops: [{ op: 'zoo.habit', key: 'turn' }] })
      const expected = await nowhere('GET', '/api/zoo')
      expect(read).toEqual({ status: 404, body: { ...expected.body, message: 'Route GET:/api/zoo not found' } })
      expect(ops.status).toBe(404)
      expect(ops.body).toEqual({ ...expected.body, message: 'Route POST:/api/zoo/ops not found' })
    }
    expect(mocks.prisma.zoo.findUnique).not.toHaveBeenCalled()
    expect(mocks.prisma.zoo.updateMany).not.toHaveBeenCalled()
    expect(mocks.prisma.zoo.create).not.toHaveBeenCalled()
    expect(mocks.changed).not.toHaveBeenCalled()
  })

  it('serves every account when on without an allowlist', async () => {
    const app = await build(parseDaemonsSwitch('true', ''))
    const res = await app.inject({ method: 'GET', url: '/api/zoo', headers: auth })
    expect(res.json()).toEqual({ success: true, data: { revision: 0, zoo: emptyZoo() } })
    const ops = await app.inject({ method: 'POST', url: '/api/zoo/ops', headers: auth, payload: { ops: [{ op: 'zoo.habit', key: 'turn' }] } })
    expect(ops.statusCode).toBe(200)
    expect(mocks.changed).toHaveBeenCalledWith('u1', { revision: 1 })
  })

  it('serves an allowlisted account, by id or by email in any case', async () => {
    for (const users of ['u1', 'someone-else, D@Example.com']) {
      const app = await build(parseDaemonsSwitch('true', users))
      const res = await app.inject({ method: 'GET', url: '/api/zoo', headers: auth })
      expect(res.statusCode).toBe(200)
      expect(res.json().data).toEqual({ revision: 0, zoo: emptyZoo() })
    }
  })

  it('answers any other account exactly as if the switch were off, before reading, validating or publishing anything', async () => {
    const app = await build(parseDaemonsSwitch('1', 'founder-id,founder@example.com'))
    const read = await ordinary404(app, 'GET', '/api/zoo')
    const ops = await ordinary404(app, 'POST', '/api/zoo/ops', { ops: [{ op: 'zoo.habit', key: 'turn' }] })
    const malformed = await ordinary404(app, 'POST', '/api/zoo/ops', { ops: 'not a list' })
    const expected = await nowhere('GET', '/api/zoo')
    expect(read).toEqual({ status: 404, body: { ...expected.body, message: 'Route GET:/api/zoo not found' } })
    expect(ops).toEqual({ status: 404, body: { ...expected.body, message: 'Route POST:/api/zoo/ops not found' } })
    expect(malformed.status).toBe(404)
    expect(mocks.prisma.zoo.findUnique).not.toHaveBeenCalled()
    expect(mocks.changed).not.toHaveBeenCalled()
  })

  it('still asks for a session first, like every other route', async () => {
    const app = await build(parseDaemonsSwitch('true', 'u1'))
    const res = await app.inject({ method: 'GET', url: '/api/zoo' })
    expect(res.statusCode).toBe(401)
  })
})
