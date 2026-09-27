import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

/**
 * Racing writers against the real route (routes/zoo.ts) over an in-memory store that behaves like the
 * database where it matters: `updateMany` is a compare-and-set on the revision, `create` trips a unique
 * index, and `daemonMint.upsert` is an atomic increment. A barrier on the first read makes every request of
 * a round read the same revision, so all but one lose the first compare-and-set and must replay.
 */
const store = vi.hoisted(() => {
  type Row = { revision: number; state: unknown }
  const db = { zoo: new Map<string, Row>(), mint: new Map<string, number>(), machines: new Map<string, string[]>() }
  const tick = () => new Promise<void>((r) => setImmediate(r))
  let waiting: Array<() => void> = []
  let party = 0
  /** The first `party` reads wait for each other, then everyone proceeds. */
  const barrier = async (): Promise<void> => {
    if (party <= 0) return tick()
    party--
    if (party === 0) { const go = waiting; waiting = []; go.forEach((f) => f()); return tick() }
    await new Promise<void>((r) => waiting.push(r))
  }
  const counts = { updates: 0, lost: 0, creates: 0, mints: 0 }
  const prisma = {
    zoo: {
      findUnique: async ({ where: { userId } }: { where: { userId: string } }) => {
        const row = db.zoo.get(userId)
        const snap = row ? { revision: row.revision, state: structuredClone(row.state) } : null
        await barrier()
        return snap
      },
      updateMany: async ({ where: { userId, revision }, data }: { where: { userId: string; revision: number }; data: Row }) => {
        await tick()
        counts.updates++
        const row = db.zoo.get(userId)
        if (!row || row.revision !== revision) { counts.lost++; return { count: 0 } }
        db.zoo.set(userId, { revision: data.revision, state: structuredClone(data.state) })
        return { count: 1 }
      },
      create: async ({ data }: { data: Row & { userId: string } }) => {
        await tick()
        if (db.zoo.has(data.userId)) {
          const { Prisma: P } = await import('@prisma/client')
          throw new P.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' })
        }
        counts.creates++
        db.zoo.set(data.userId, { revision: data.revision, state: structuredClone(data.state) })
        return {}
      },
    },
    machine: {
      findMany: async ({ where: { userId, machineId } }: { where: { userId: string; machineId: { in: string[] } } }) =>
        (db.machines.get(userId) ?? []).filter((id) => machineId.in.includes(id)).map((id) => ({ machineId: id })),
    },
    daemonMint: {
      upsert: async ({ where: { daemonId } }: { where: { daemonId: string } }) => {
        await tick()
        counts.mints++
        const count = (db.mint.get(daemonId) ?? 0) + 1
        db.mint.set(daemonId, count)
        return { count }
      },
    },
  }
  return {
    db, prisma, counts,
    arm: (n: number) => { party = n; waiting = [] },
    reset: () => { db.zoo.clear(); db.mint.clear(); db.machines.clear(); party = 0; waiting = []; Object.assign(counts, { updates: 0, lost: 0, creates: 0, mints: 0 }) },
  }
})
const mocks = vi.hoisted(() => ({
  changed: vi.fn(async () => 1),
  auth: vi.fn(async (token: string) => ({ sub: token, email: `${token}@example.com`, role: 'user', autonomousEnv: 'prod' as const })),
}))
vi.mock('../lib/prisma.js', () => ({ prisma: store.prisma }))
vi.mock('../lib/bus.js', () => ({ publishZooChanged: mocks.changed }))
vi.mock('../lib/ssoAuth.js', async (original) => ({ ...await original<typeof import('../lib/ssoAuth.js')>(), authenticateAccessToken: mocks.auth }))

import { zooRoutes } from './zoo.js'
import { DAEMONS_EVERYONE } from '../lib/daemonsSwitch.js'
import { emptyZoo, parseZoo, type Hatched, type Zoo, type ZooEgg, type ZooOp } from '../lib/zoo.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'

/** After drop 1's (init) release, so its daemons are drawable whatever day the suite runs. */
const NOW = new Date('2026-10-01T12:00:00.000Z')
const egg = (id: string, kind = 'turn'): ZooEgg => ({ id, kind, grantedAt: '2026-09-30T00:00:00.000Z' })
const hatch = (eggId: string): ZooOp => ({ op: 'zoo.hatch', eggId })

interface Answer { revision: number; zoo: Zoo; hatched: Hatched[]; grants: unknown[]; levelUps: unknown[] }

describe('zoo writes racing on one account', () => {
  let app: FastifyInstance
  beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW) })
  afterAll(() => { vi.useRealTimers() })
  beforeEach(async () => {
    store.reset()
    mocks.changed.mockClear()
    app = Fastify(); app.setErrorHandler(errorHandler); registerAuthMiddleware(app, mocks.auth as never)
    // The server's daemons switch on for everyone (lib/daemonsSwitch.ts): what these tests are about.
    await app.register(zooRoutes, { daemons: DAEMONS_EVERYONE }); await app.ready()
  })
  afterEach(async () => { await app.close() })

  const post = async (user: string, ops: ZooOp[]): Promise<Answer> => {
    const res = await app.inject({ method: 'POST', url: '/api/zoo/ops', headers: { authorization: `Bearer ${user}` }, payload: { ops } })
    expect(res.statusCode, res.body).toBe(200)
    return res.json().data as Answer
  }
  const seedZoo = (user: string, zoo: Zoo, revision = 3) => store.db.zoo.set(user, { revision, state: structuredClone(zoo) })
  const stored = (user: string): { revision: number; zoo: Zoo } => {
    const row = store.db.zoo.get(user)!
    return { revision: row.revision, zoo: parseZoo(row.state) }
  }

  it('two phones hatching different eggs: both land, one replayed, each answer is what was written', async () => {
    for (let trial = 0; trial < 60; trial++) {
      store.reset()
      seedZoo('u1', { ...emptyZoo(), eggs: [egg('a'), egg('b'), egg('c', 'night')] })
      store.arm(2)
      const [one, two] = await Promise.all([post('u1', [hatch('a')]), post('u1', [hatch('b'), hatch('c')])])
      const { revision, zoo } = stored('u1')
      expect(revision).toBe(5)                                            // two writes, one each
      expect(store.counts.lost).toBe(1)                                    // exactly one lost the first compare-and-set
      expect(zoo.eggs).toEqual([])
      const answered = [...one.hatched, ...two.hatched]
      expect(answered.map((h) => h.eggId).sort()).toEqual(['a', 'b', 'c'])
      // Every daemon in the zoo is one that was answered, with the serial that was answered.
      for (const h of answered.filter((x) => !x.duplicate)) {
        const d = zoo.daemons.find((x) => x.id === h.daemonId)!
        expect(d.serial).toBe(h.serial)
      }
      expect(zoo.daemons.length).toBe(answered.filter((h) => !h.duplicate).length)
      // The later answer carries the zoo as written; the earlier answer's revision is the one before it.
      const [first, last] = one.revision < two.revision ? [one, two] : [two, one]
      expect([first.revision, last.revision]).toEqual([4, 5])
      expect(last.zoo).toEqual(zoo)
      expect(mocks.changed).toHaveBeenCalledTimes(2 * (trial + 1))
    }
  })

  it('two phones hatching the SAME egg: it hatches once; the loser answers the zoo with nothing hatched', async () => {
    for (let trial = 0; trial < 60; trial++) {
      store.reset()
      seedZoo('u1', { ...emptyZoo(), eggs: [egg('a', 'first')] })
      store.arm(2)
      const answers = await Promise.all([post('u1', [hatch('a')]), post('u1', [hatch('a')])])
      const { revision, zoo } = stored('u1')
      expect(revision).toBe(4)
      const winners = answers.filter((a) => a.hatched.length)
      expect(winners.length).toBe(1)
      const loser = answers.find((a) => !a.hatched.length)!
      expect(loser).toEqual({ revision: 4, zoo, hatched: [], grants: [], levelUps: [] })
      expect(zoo.daemons.map((d) => d.id)).toEqual([winners[0].hatched[0].daemonId])
      expect(zoo.daemons[0].serial).toBe(winners[0].hatched[0].serial)
      // Both minted before writing; the loser's number is a gap, never a number given twice.
      expect(store.counts.mints).toBe(2)
    }
  })

  it('a turn batch sent by two machines at once counts once; distinct batches both count', async () => {
    for (let trial = 0; trial < 40; trial++) {
      store.reset()
      store.db.machines.set('u1', ['m1', 'm2'])
      seedZoo('u1', emptyZoo())
      const turn = (batchId: string, n: number, machineId: string): ZooOp => ({ op: 'zoo.turn', batchId, n, day: '2026-10-01', hour: 9, machineId })
      store.arm(3)
      await Promise.all([
        post('u1', [turn('same', 4, 'm1')]),
        post('u1', [turn('same', 4, 'm1')]),
        post('u1', [turn('other', 3, 'm2')]),
      ])
      const { zoo } = stored('u1')
      expect(zoo.progress.turns).toBe(7)
      expect(zoo.progress.days['2026-10-01']).toBe(7)
      expect([...zoo.progress.batches].sort()).toEqual(['other', 'same'])
      expect(zoo.progress.machines.sort()).toEqual(['m1', 'm2'])
      // The second machine earns the marathon egg exactly once, whichever write carried it. (10-01 is in the
      // week of the 09-27 history date: the first counted turn earns its egg, once, before the marathon.)
      expect(zoo.eggs.map((e) => e.kind)).toEqual(['history', 'marathon'])
    }
  })

  it('the first write of a new account, raced: one creates the row, the other replays onto it', async () => {
    for (let trial = 0; trial < 40; trial++) {
      store.reset()
      store.arm(2)
      await Promise.all([
        post('fresh', [{ op: 'zoo.habit', key: 'turn' }, { op: 'zoo.habit', key: 'split' }]),
        post('fresh', [{ op: 'zoo.habit', key: 'find' }]),
      ])
      const { revision, zoo } = stored('fresh')
      expect(revision).toBe(2)
      expect(store.counts.creates).toBe(1)
      expect([...zoo.habits].sort()).toEqual(['find', 'split', 'turn'])
      expect(zoo.eggs.map((e) => e.kind)).toEqual(['first'])            // three habits with a turn: once
      expect(zoo.firstEgg).toBe(true)
    }
  })

  it('answers an error and tells nobody when creating the row fails for a reason other than a race', async () => {
    const create = store.prisma.zoo.create
    store.prisma.zoo.create = async () => { throw new Error('disk full') }
    try {
      const res = await app.inject({ method: 'POST', url: '/api/zoo/ops', headers: { authorization: 'Bearer u9' }, payload: { ops: [{ op: 'zoo.habit', key: 'turn' }] } })
      expect(res.statusCode).toBe(500)
      expect(store.db.zoo.has('u9')).toBe(false)
      expect(mocks.changed).not.toHaveBeenCalled()
    } finally {
      store.prisma.zoo.create = create
    }
  })

  it('never gives one serial twice: many accounts hatching at once, with races inside each', async () => {
    const users = ['u1', 'u2', 'u3', 'u4']
    for (let round = 0; round < 15; round++) {
      store.reset()
      for (const u of users) seedZoo(u, { ...emptyZoo(), eggs: Array.from({ length: 6 }, (_, i) => egg(`${u}e${i}`)) })
      store.arm(users.length * 2)
      const answers = await Promise.all(users.flatMap((u) => [
        post(u, [hatch(`${u}e0`), hatch(`${u}e1`), hatch(`${u}e2`)]),
        post(u, [hatch(`${u}e3`), hatch(`${u}e4`), hatch(`${u}e5`)]),
      ]))
      expect(answers.every((a) => a.hatched.length === 3)).toBe(true)
      const serials = new Map<string, number[]>()
      for (const u of users) {
        const { zoo } = stored(u)
        expect(zoo.eggs).toEqual([])
        expect(zoo.daemons.length).toBe(6)                                // six regular hatches, no duplicate
        for (const d of zoo.daemons) {
          expect(d.serial).toBeGreaterThanOrEqual(1)
          serials.set(d.id, [...(serials.get(d.id) ?? []), d.serial!])
        }
      }
      for (const [id, list] of serials) {
        expect(new Set(list).size, `${id} serials ${list}`).toBe(list.length)
        expect(Math.max(...list)).toBeLessThanOrEqual(store.db.mint.get(id)!)
      }
    }
  })
})

