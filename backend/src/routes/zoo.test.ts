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
import { emptyZoo, legacyUid, type Zoo } from '../lib/zoo.js'
import { DAEMON_ROSTER } from '../lib/daemonRoster.g.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'

const user = { sub: 'u1', email: 'd@example.com', role: 'user', autonomousEnv: 'prod' as const }
const withHabits = (habits: string[]): Zoo => ({ ...emptyZoo(), habits })
const egg = { id: 'e1', kind: 'first', grantedAt: '2026-09-26T00:00:00.000Z' }
const UID = /^[0-9a-f]{24}$/
const uid = (label: string) => Buffer.from(label).toString('hex').padEnd(24, '0').slice(0, 24)
/** An individual as stored. */
const daemon = (id: string, extra: Record<string, unknown> = {}) =>
  ({ uid: uid(id), id, seed: 0, shiny: false, xp: 0, bond: 0, version: '0.1', hatched: '2026-09-01T00:00:00.000Z', egg: 'first', ...extra })
/** A daemon as stored before individuals: one record per species. */
const old = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, hatchedAt: '2026-09-01T00:00:00.000Z', egg: 'first', shiny: false, bond: 0, xp: 0, version: '0.1', ...extra })

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

  it('hatches on the server and answers the new individual, with its serial', async () => {
    mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 2, state: { ...emptyZoo(), eggs: [egg] } })
    mocks.prisma.zoo.updateMany.mockResolvedValue({ count: 1 })
    mocks.prisma.daemonMint.upsert.mockResolvedValue({ count: 42 })
    const res = await post([{ op: 'zoo.hatch', eggId: 'e1' }])
    const data = res.json().data
    expect(data.revision).toBe(3)
    const id = data.hatched[0].daemonId
    const individual = {
      uid: expect.stringMatching(UID), id, seed: expect.any(Number), shiny: expect.any(Boolean), xp: 0, bond: 0, version: '0.1',
      hatched: expect.any(String), egg: 'first', serial: 42,
    }
    expect(data.hatched).toEqual([{ eggId: 'e1', daemonId: id, ...individual }])
    expect(DAEMON_ROSTER.daemons.map((d) => d.id)).toContain(id)
    expect(data.hatched[0].seed).toBeGreaterThanOrEqual(1)
    expect(data.zoo).toMatchObject({ eggs: [], paired: data.hatched[0].uid, daemons: [individual] })
    const { eggId: _e, daemonId: _d, ...asHatched } = data.hatched[0]
    expect(data.zoo.daemons[0]).toEqual(asHatched)
    // One atomic increment of that daemon's counter, created at 1 the first time it hatches anywhere.
    expect(mocks.prisma.daemonMint.upsert).toHaveBeenCalledExactlyOnceWith({
      where: { daemonId: id }, create: { daemonId: id, count: 1 }, update: { count: { increment: 1 } }, select: { count: true },
    })
    expect(mocks.prisma.zoo.updateMany.mock.calls[0][0].data.state.daemons[0]).toMatchObject({ uid: data.hatched[0].uid, id, serial: 42 })
    expect(mocks.prisma.zoo.updateMany.mock.calls[0][0].data.state).not.toHaveProperty('pair')
  })

  describe('serials', () => {
    const regulars = DAEMON_ROSTER.daemons.filter((d) => d.drop === 'init' && d.rarity !== 'secret').map((d) => d.id)
    const turnEgg = { id: 'e1', kind: 'turn', grantedAt: '2026-09-26T00:00:00.000Z' }
    // Every regular but tim owned, eight hatches since a new species: a turn egg can only give tim, so every
    // attempt draws the same.
    const onlyTimLeft = () => ({ ...emptyZoo(), daemons: regulars.filter((id) => id !== 'tim').map((id) => daemon(id)), eggs: [turnEgg], sinceNew: 8 })

    it('mints the species\' next serial for a species you own too: every individual has its own', async () => {
      mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 2, state: { ...emptyZoo(), daemons: regulars.map((id) => daemon(id, { serial: 3 })), eggs: [turnEgg] } })
      mocks.prisma.zoo.updateMany.mockResolvedValue({ count: 1 })
      mocks.prisma.daemonMint.upsert.mockResolvedValue({ count: 17 })
      const res = await post([{ op: 'zoo.hatch', eggId: 'e1' }])
      const { hatched, zoo } = res.json().data
      const id = hatched[0].daemonId
      expect(regulars).toContain(id)
      expect(hatched).toEqual([expect.objectContaining({ eggId: 'e1', daemonId: id, id, serial: 17 })])
      expect(hatched[0]).not.toHaveProperty('duplicate')
      expect(zoo.daemons).toHaveLength(regulars.length + 1)
      expect(zoo.daemons.filter((d: { id: string }) => d.id === id).map((d: { serial: number }) => d.serial)).toEqual([3, 17])
      expect(mocks.prisma.daemonMint.upsert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ where: { daemonId: id } }))
    })

    it('keeps a serial minted for a write that lost the race for the retry\'s hatch', async () => {
      mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 4, state: onlyTimLeft() })
      mocks.prisma.zoo.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 })
      mocks.prisma.daemonMint.upsert.mockResolvedValueOnce({ count: 7 }).mockResolvedValueOnce({ count: 8 })
      const res = await post([{ op: 'zoo.hatch', eggId: 'e1' }])
      expect(res.json().data.hatched).toEqual([expect.objectContaining({ eggId: 'e1', daemonId: 'tim', serial: 7 })])
      expect(mocks.prisma.daemonMint.upsert).toHaveBeenCalledOnce()
      expect(mocks.prisma.zoo.updateMany).toHaveBeenCalledTimes(2)
      expect(mocks.prisma.zoo.updateMany.mock.calls[1][0].data.state.daemons.at(-1)).toMatchObject({ id: 'tim', serial: 7, uid: res.json().data.hatched[0].uid })
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

    it('mints none for a guest\'s individuals: they arrive local, without a serial', async () => {
      mocks.prisma.zoo.findUnique.mockResolvedValue(null)
      mocks.prisma.zoo.updateMany.mockResolvedValue({ count: 0 })
      mocks.prisma.zoo.create.mockResolvedValue({})
      const res = await post([{ op: 'zoo.seed', zoo: { daemons: [daemon('gnu', { serial: 3, seed: 9 }), old('yak', { serial: 4 })] } }])
      const { daemons } = res.json().data.zoo
      expect(daemons).toEqual([
        { ...daemon('gnu'), uid: expect.stringMatching(UID), origin: 'local' },
        { ...daemon('yak'), uid: expect.stringMatching(UID), origin: 'local' },
      ])
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

  it('refuses a malformed op, a name past 24 characters, a malformed uid, the old species-named ops, and a client-sent result', async () => {
    mocks.prisma.zoo.findUnique.mockResolvedValue(null)
    expect((await post([{ op: 'zoo.explode' }])).statusCode).toBe(400)
    expect((await post([{ op: 'zoo.nickname', uid: uid('tim'), name: 'x'.repeat(25) }])).statusCode).toBe(400)
    expect((await post([{ op: 'zoo.nickname', uid: 'tim', name: 'pip' }])).statusCode).toBe(400)
    expect((await post([{ op: 'zoo.nickname', id: 'tim', nickname: 'pip' }])).statusCode).toBe(400)
    expect((await post([{ op: 'zoo.pair', id: 'tim' }])).statusCode).toBe(400)
    expect((await post([{ op: 'zoo.pair', uid: uid('tim').toUpperCase() }])).statusCode).toBe(400)
    // One malformed op refuses the whole request, well-formed ops beside it included.
    expect((await post([{ op: 'zoo.habit', key: 'turn' }, { op: 'zoo.pair', uid: 'x' }])).statusCode).toBe(400)
    expect((await post([{ op: 'zoo.hatch', eggId: 'e1', daemonId: 'beastie' }])).statusCode).toBe(400)
    expect((await post([{ op: 'zoo.hatch', eggId: 'e1', seed: 1 }])).statusCode).toBe(400)
    expect((await post([])).statusCode).toBe(400)
    expect(mocks.prisma.zoo.findUnique).not.toHaveBeenCalled()
  })

  it('counts reported turns, asks which machines are the account\'s, and answers eggs and levels', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-26T12:00:00.000Z'))
    try {
      const tim = daemon('tim', { xp: 40 })
      const progress = { turns: 39, machines: ['mac-1'] }
      mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 5, state: { ...emptyZoo(), daemons: [tim], paired: tim.uid, progress } })
      mocks.prisma.zoo.updateMany.mockResolvedValue({ count: 1 })
      mocks.prisma.machine.findMany.mockResolvedValue([{ machineId: 'mac-1' }])
      const turn = (batchId: string, machineId: string) => ({ op: 'zoo.turn', batchId, n: 5, day: '2026-09-26', hour: 10, machineId })
      const res = await post([turn('b1', 'mac-1'), turn('b2', 'someone-elses')])
      expect(res.statusCode).toBe(200)
      expect(mocks.prisma.machine.findMany).toHaveBeenCalledWith({ where: { userId: 'u1', machineId: { in: ['mac-1', 'someone-elses'] } }, select: { machineId: true } })
      const data = res.json().data
      expect(data.grants).toEqual([{ kind: 'turn', eggId: expect.any(String) }])
      expect(data.levelUps).toEqual([{ uid: tim.uid, id: 'tim', level: 1, version: '0.1' }])      // 40 + 5 + 10
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
      const tim = daemon('tim', { xp: 5 })
      mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 5, state: { ...emptyZoo(), daemons: [tim], paired: tim.uid, progress: { turns: 3, days: { '2026-09-26': 3 } } } })
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
      mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 7, state: { ...emptyZoo(), daemons: [{ ...tim, xp: 45 }], paired: tim.uid } })
      const level = await post([{ op: 'zoo.turn', batchId: 'b2', n: 5, day: '2026-09-26', hour: 11, machineId: 'mac-1' }])
      expect(level.json().data.levelUps).toEqual([{ uid: tim.uid, id: 'tim', level: 1, version: '0.1' }])
      expect(mocks.changed).toHaveBeenCalledExactlyOnceWith('u1', { revision: 8 })
      // A habit, the dial, a name, the pair: all drawn, all published.
      mocks.changed.mockClear()
      const tim2 = daemon('tim', { uid: uid('tim2') })
      mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 8, state: { ...emptyZoo(), daemons: [tim, tim2], paired: tim.uid } })
      for (const op of [
        { op: 'zoo.habit', key: 'split' }, { op: 'zoo.autonomy', level: 'suggest' }, { op: 'zoo.nickname', uid: tim2.uid, name: 'timmy' }, { op: 'zoo.pair', uid: tim2.uid },
      ]) {
        await post([op])
      }
      expect(mocks.changed).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('credits an approved lesson once, to the daemon that found it, and answers its level', async () => {
    const tim = daemon('tim', { xp: 40 })
    mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 3, state: { ...emptyZoo(), daemons: [tim], paired: tim.uid } })
    mocks.prisma.zoo.updateMany.mockResolvedValue({ count: 1 })
    const res = await post([{ op: 'zoo.lesson', lessonId: '3f2a9c1b', daemonId: 'tim' }])
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.levelUps).toEqual([{ uid: tim.uid, id: 'tim', level: 1, version: '0.1' }])      // 40 + 25
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

  describe('a zoo stored before individuals', () => {
    const stored = { ...emptyZoo(), daemons: [old('tim', { xp: 60, nickname: 'pip', serial: 5, dupes: 2 }), old('yak')], pair: 'yak' } as Record<string, unknown>
    delete stored.paired

    it('serves it as individuals, with the same uids on every read', async () => {
      mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 9, state: stored })
      const one = (await app.inject({ method: 'GET', url: '/api/zoo', headers: auth })).json().data
      const two = (await app.inject({ method: 'GET', url: '/api/zoo', headers: auth })).json().data
      expect(one).toEqual(two)
      expect(one.zoo.daemons).toEqual([
        { uid: legacyUid('u1', 'tim'), id: 'tim', seed: 0, serial: 5, name: 'pip', shiny: false, xp: 60, bond: 1, version: '0.1', hatched: '2026-09-01T00:00:00.000Z', egg: 'first' },
        { uid: legacyUid('u1', 'yak'), id: 'yak', seed: 0, shiny: false, xp: 0, bond: 0, version: '0.1', hatched: '2026-09-01T00:00:00.000Z', egg: 'first' },
      ])
      expect(one.zoo.paired).toBe(legacyUid('u1', 'yak'))
      expect(one.zoo).not.toHaveProperty('pair')
      expect(mocks.prisma.zoo.updateMany).not.toHaveBeenCalled()             // reading never writes
    })

    it('takes an op by a uid it served, and writes the new shape with the same uids', async () => {
      mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 9, state: stored })
      mocks.prisma.zoo.updateMany.mockResolvedValue({ count: 1 })
      const res = await post([{ op: 'zoo.pair', uid: legacyUid('u1', 'tim') }, { op: 'zoo.nickname', uid: legacyUid('u1', 'yak'), name: 'yakko' }])
      expect(res.statusCode).toBe(200)
      const written = mocks.prisma.zoo.updateMany.mock.calls[0][0].data.state
      expect(written).not.toHaveProperty('pair')
      expect(written.paired).toBe(legacyUid('u1', 'tim'))
      expect(written.daemons.map((d: { uid: string; name?: string }) => [d.uid, d.name])).toEqual([[legacyUid('u1', 'tim'), 'pip'], [legacyUid('u1', 'yak'), 'yakko']])
      for (const d of written.daemons) expect(d).not.toHaveProperty('dupes')
      // Read back in the new shape: the same zoo, and the same ops again change nothing.
      mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 10, state: structuredClone(written) })
      const back = (await app.inject({ method: 'GET', url: '/api/zoo', headers: auth })).json().data
      expect(back.zoo).toEqual(res.json().data.zoo)
      mocks.prisma.zoo.updateMany.mockClear()
      const again = await post([{ op: 'zoo.pair', uid: legacyUid('u1', 'tim') }, { op: 'zoo.nickname', uid: legacyUid('u1', 'yak'), name: 'yakko' }])
      expect(again.json().data.revision).toBe(10)
      expect(mocks.prisma.zoo.updateMany).not.toHaveBeenCalled()
    })

    it('derives uids from the account: another account\'s old zoo names different ones', async () => {
      mocks.auth.mockResolvedValue({ ...user, sub: 'u2' })
      mocks.prisma.zoo.findUnique.mockResolvedValue({ revision: 9, state: stored })
      const data = (await app.inject({ method: 'GET', url: '/api/zoo', headers: auth })).json().data
      expect(data.zoo.daemons.map((d: { uid: string }) => d.uid)).toEqual([legacyUid('u2', 'tim'), legacyUid('u2', 'yak')])
      expect(legacyUid('u2', 'tim')).not.toBe(legacyUid('u1', 'tim'))
    })
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
    const env = process.env.HARNESS_DAEMONS
    delete process.env.HARNESS_DAEMONS
    const unset = parseDaemonsSwitch(process.env.HARNESS_DAEMONS, process.env.HARNESS_DAEMONS_USERS)
    if (env !== undefined) process.env.HARNESS_DAEMONS = env
    expect(unset.on).toBe(false)
    for (const app of [await build(), await build(unset), await build(parseDaemonsSwitch(undefined)), await build(parseDaemonsSwitch('false', 'u1'))]) {
      // Not one zoo route exists: the router has nothing under /api/zoo.
      expect(app.printRoutes()).not.toContain('zoo')
      const read = await ordinary404(app, 'GET', '/api/zoo')
      const ops = await ordinary404(app, 'POST', '/api/zoo/ops', { ops: [{ op: 'zoo.habit', key: 'turn' }] })
      const expected = await nowhere('GET', '/api/zoo')
      expect(read).toEqual({ status: 404, body: { ...expected.body, message: 'Route GET:/api/zoo not found' } })
      expect(ops.status).toBe(404)
      expect(ops.body).toEqual({ ...expected.body, message: 'Route POST:/api/zoo/ops not found' })
      // The individual ops too, well-formed or not: nothing is validated, read or minted.
      for (const op of [{ op: 'zoo.hatch', eggId: 'e1' }, { op: 'zoo.pair', uid: uid('tim') }, { op: 'zoo.nickname', uid: uid('tim'), name: 'pip' }, { op: 'zoo.pair', uid: 'bad' }]) {
        expect((await ordinary404(app, 'POST', '/api/zoo/ops', { ops: [op] })).status).toBe(404)
      }
    }
    expect(mocks.prisma.daemonMint.upsert).not.toHaveBeenCalled()
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
