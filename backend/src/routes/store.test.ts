// The Harness Store's ratings and reviews. Pinned: one review per person per harness (a second
// write replaces, never stacks), the summary is computed from the rows, a review is `mine` only to
// its author, deleting what you never wrote is a 404, and the whole group sits behind the SSO gate.
//
// Prisma is an in-memory fake that honours the parts of the query API the routes use (where with
// `not`, select, orderBy, take, the compound unique key) so the tests assert what the routes ask
// the database for, not just what they do with a canned answer.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify'

const authenticateAccessToken = vi.hoisted(() => vi.fn())
vi.mock('../lib/ssoAuth.js', async (importActual) => ({
  ...(await importActual<typeof import('../lib/ssoAuth.js')>()),
  authenticateAccessToken,
}))

interface Row { id: string; harnessId: string; userId: string; authorName: string; rating: number; title: string | null; body: string | null; createdAt: Date; updatedAt: Date }
type Where = { harnessId?: string; userId?: string | { not: string } }

const db = vi.hoisted(() => {
  const state = {
    rows: [] as Row[],
    users: new Map<string, { name: string | null }>(),
    clock: 0,
    ids: 0,
    /** Deterministic time: every write is one second after the last. */
    tick: () => new Date(Date.UTC(2026, 8, 16, 0, 0, 0) + 1000 * state.clock++),
  }
  return state
})

const prisma = vi.hoisted(() => {
  const matches = (r: Row, where: Where = {}): boolean => {
    if (where.harnessId !== undefined && r.harnessId !== where.harnessId) return false
    if (typeof where.userId === 'string' && r.userId !== where.userId) return false
    if (typeof where.userId === 'object' && r.userId === where.userId.not) return false
    return true
  }
  const project = (r: Row, select?: Record<string, boolean>) =>
    select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, r[k as keyof Row]])) : { ...r }
  return {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const user = db.users.get(where.id)
        return user ? { ...user } : null
      }),
    },
    harnessReview: {
      findMany: vi.fn(async (args: { where?: Where; select?: Record<string, boolean>; orderBy?: { updatedAt: 'asc' | 'desc' }; take?: number } = {}) => {
        let rows = db.rows.filter((r) => matches(r, args.where))
        if (args.orderBy) {
          const sign = args.orderBy.updatedAt === 'desc' ? -1 : 1
          rows = [...rows].sort((a, b) => sign * (a.updatedAt.getTime() - b.updatedAt.getTime()))
        }
        if (args.take !== undefined) rows = rows.slice(0, args.take)
        return rows.map((r) => project(r, args.select))
      }),
      findUnique: vi.fn(async ({ where }: { where: { harnessId_userId: { harnessId: string; userId: string } } }) => {
        const found = db.rows.find((r) => r.harnessId === where.harnessId_userId.harnessId && r.userId === where.harnessId_userId.userId)
        return found ? { ...found } : null
      }),
      upsert: vi.fn(async ({ where, create, update }: { where: { harnessId_userId: { harnessId: string; userId: string } }; create: Omit<Row, 'id' | 'createdAt' | 'updatedAt'>; update: Partial<Row> }) => {
        const { harnessId, userId } = where.harnessId_userId
        const existing = db.rows.find((r) => r.harnessId === harnessId && r.userId === userId)
        if (existing) {
          Object.assign(existing, update, { updatedAt: db.tick() })
          return { ...existing }
        }
        const now = db.tick()
        const row: Row = { id: `r${++db.ids}`, ...create, createdAt: now, updatedAt: now }
        db.rows.push(row)
        return { ...row }
      }),
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        const before = db.rows.length
        db.rows = db.rows.filter((r) => !matches(r, where))
        return { count: before - db.rows.length }
      }),
    },
  }
})
vi.mock('../lib/prisma.js', () => ({ prisma }))

import { storeRoutes, ratingSummaries, STORE_RATINGS_PATH, STORE_REVIEWS_PATH, STORE_REVIEW_PATH } from './store.js'
import { errorHandler } from '../middlewares/errorHandler.js'
import { registerAuthMiddleware, shouldSkipAuth } from '../middlewares/authMiddleware.js'

async function build(): Promise<FastifyInstance> {
  const app = Fastify()
  app.setErrorHandler(errorHandler)
  registerAuthMiddleware(app, authenticateAccessToken)
  await app.register(storeRoutes)
  await app.ready()
  return app
}

/** Four people: the token names who. Dee has written nothing. */
const people: Record<string, { sub: string; email: string; role: string; autonomousEnv: 'prod' }> = {
  'tok-ann': { sub: 'u-ann', email: 'ann@example.com', role: 'user', autonomousEnv: 'prod' },
  'tok-bo': { sub: 'u-bo', email: 'bo@example.com', role: 'user', autonomousEnv: 'prod' },
  'tok-cy': { sub: 'u-cy', email: 'cy@example.com', role: 'user', autonomousEnv: 'prod' },
  'tok-dee': { sub: 'u-dee', email: 'dee@example.com', role: 'user', autonomousEnv: 'prod' },
}

const reviewsUrl = (id: string) => STORE_REVIEWS_PATH.replace(':owner/:name', id)
const reviewUrl = (id: string) => STORE_REVIEW_PATH.replace(':owner/:name', id)
const MARP = 'autonomous/marp'

function call(app: FastifyInstance, method: InjectOptions['method'], url: string, token: string | null, payload?: unknown) {
  return app.inject({ method, url, payload: payload as InjectOptions['payload'], headers: token ? { authorization: `Bearer ${token}` } : {} })
}

/** A stored row, as another writer (or an older build) might have left it. */
function seed(over: Partial<Row> & Pick<Row, 'harnessId' | 'userId' | 'rating'>): Row {
  const at = db.tick()
  const row: Row = { id: `r${++db.ids}`, authorName: 'Someone', title: null, body: null, createdAt: at, updatedAt: at, ...over }
  db.rows.push(row)
  return row
}

const EMPTY = { average: 0, count: 0, histogram: [0, 0, 0, 0, 0] }

describe('the Harness Store', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    db.rows = []; db.clock = 0; db.ids = 0
    db.users = new Map([['u-ann', { name: 'Ann Lee' }], ['u-bo', { name: null }], ['u-cy', { name: 'Cy' }]])
    for (const fn of [prisma.user.findUnique, ...Object.values(prisma.harnessReview)]) fn.mockClear()
    authenticateAccessToken.mockReset()
    authenticateAccessToken.mockImplementation(async (token: string) => {
      const who = people[token]
      if (!who) throw new Error('bad token')
      return who
    })
    app = await build()
  })

  describe('the SSO gate', () => {
    const routes: Array<[InjectOptions['method'], string, unknown?]> = [
      ['GET', STORE_RATINGS_PATH],
      ['GET', reviewsUrl(MARP)],
      ['PUT', reviewUrl(MARP), { rating: 5 }],
      ['DELETE', reviewUrl(MARP)],
    ]

    it.each(routes)('%s %s needs a token, and a valid one, before it touches the database', async (method, url, payload) => {
      seed({ harnessId: MARP, userId: 'u-ann', rating: 5 })
      for (const token of [null, 'tok-forged']) {
        const res = await call(app, method, url, token, payload)
        expect(res.statusCode).toBe(401)
        expect(res.json()).toEqual({ success: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })
      }
      expect(authenticateAccessToken).toHaveBeenCalledTimes(1) // only the forged token got as far as SSO
      for (const fn of [prisma.user.findUnique, ...Object.values(prisma.harnessReview)]) expect(fn).not.toHaveBeenCalled()
      expect(db.rows).toHaveLength(1)
    })

    it('is not on the public skip list', () => {
      for (const path of [STORE_RATINGS_PATH, reviewsUrl(MARP), reviewUrl(MARP)]) expect(shouldSkipAuth(path)).toBe(false)
    })
  })

  describe('GET ratings', () => {
    it('is an empty list when nobody has reviewed anything', async () => {
      const res = await call(app, 'GET', STORE_RATINGS_PATH, 'tok-ann')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ success: true, data: { ratings: [] } })
    })

    it('is one summary per reviewed harness, sorted by id, with the average rounded to two places', async () => {
      seed({ harnessId: 'zeta/last', userId: 'u-ann', rating: 1 })
      seed({ harnessId: MARP, userId: 'u-ann', rating: 5 })
      seed({ harnessId: MARP, userId: 'u-bo', rating: 4 })
      seed({ harnessId: MARP, userId: 'u-cy', rating: 4 })
      seed({ harnessId: 'autonomous/blender', userId: 'u-bo', rating: 2 })
      seed({ harnessId: 'autonomous/blender', userId: 'u-cy', rating: 1 })

      const res = await call(app, 'GET', STORE_RATINGS_PATH, 'tok-cy')
      expect(res.statusCode).toBe(200)
      expect(res.json().data.ratings).toEqual([
        { harnessId: 'autonomous/blender', average: 1.5, count: 2, histogram: [1, 1, 0, 0, 0] },
        { harnessId: MARP, average: 4.33, count: 3, histogram: [0, 0, 0, 2, 1] },
        { harnessId: 'zeta/last', average: 1, count: 1, histogram: [1, 0, 0, 0, 0] },
      ])
      // Only the two columns a summary needs are read.
      expect(prisma.harnessReview.findMany).toHaveBeenCalledWith({ select: { harnessId: true, rating: true } })
    })

    it('rounds two-place averages half up and keeps exact ones exact', async () => {
      // 5+5+4 = 14/3 = 4.666… → 4.67; 1+2+2+2+2+2 = 11/6 = 1.8333… → 1.83; 3+4 = 3.5
      for (const [i, r] of [5, 5, 4].entries()) seed({ harnessId: 'a/high', userId: `u${i}`, rating: r })
      for (const [i, r] of [1, 2, 2, 2, 2, 2].entries()) seed({ harnessId: 'b/low', userId: `u${i}`, rating: r })
      for (const [i, r] of [3, 4].entries()) seed({ harnessId: 'c/half', userId: `u${i}`, rating: r })
      const summaries = await ratingSummaries()
      expect(summaries.map((s) => [s.harnessId, s.average, s.count])).toEqual([['a/high', 4.67, 3], ['b/low', 1.83, 6], ['c/half', 3.5, 2]])
      for (const s of summaries) expect(s.histogram.reduce((a, b) => a + b, 0)).toBe(s.count)
    })

    it('does not count a stored rating outside 1..5, so the count, the histogram and the average agree', async () => {
      // The database cannot forbid a 0 or a 7 (Mongo has no CHECK); a row written by anything but this
      // route must not drag the average down or leave the histogram short of the count.
      seed({ harnessId: MARP, userId: 'u-ann', rating: 5 })
      seed({ harnessId: MARP, userId: 'u-bo', rating: 0 })
      seed({ harnessId: MARP, userId: 'u-cy', rating: 7 })
      seed({ harnessId: 'autonomous/broken', userId: 'u-ann', rating: -1 })

      const ratings = (await call(app, 'GET', STORE_RATINGS_PATH, 'tok-ann')).json().data.ratings
      // A harness with no valid rating has no summary at all.
      expect(ratings).toEqual([{ harnessId: MARP, average: 5, count: 1, histogram: [0, 0, 0, 0, 1] }])
    })
  })

  describe('GET reviews for a package', () => {
    it('answers an empty summary, no reviews and no `mine` for a harness nobody reviewed', async () => {
      seed({ harnessId: 'autonomous/other', userId: 'u-ann', rating: 5 })
      const res = await call(app, 'GET', reviewsUrl(MARP), 'tok-ann')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ success: true, data: { rating: { harnessId: MARP, ...EMPTY }, reviews: [], mine: null } })
    })

    it('lists this harness only, newest first, with the reader\'s own review first and flagged', async () => {
      seed({ harnessId: MARP, userId: 'u-bo', rating: 3, authorName: 'Harness user' })
      const ann = seed({ harnessId: MARP, userId: 'u-ann', rating: 5, authorName: 'Ann Lee', title: 'Keynote in a minute', body: 'The pane is the deck.' })
      seed({ harnessId: MARP, userId: 'u-cy', rating: 2, authorName: 'Cy' })
      seed({ harnessId: 'autonomous/other', userId: 'u-cy', rating: 1, authorName: 'Cy' })

      const asBo = (await call(app, 'GET', reviewsUrl(MARP), 'tok-bo')).json().data
      expect(asBo.reviews.map((r: { authorName: string; mine: boolean }) => [r.authorName, r.mine]))
        .toEqual([['Harness user', true], ['Cy', false], ['Ann Lee', false]])
      expect(asBo.mine).toEqual(asBo.reviews[0])
      expect(asBo.rating).toEqual({ harnessId: MARP, average: 3.33, count: 3, histogram: [0, 1, 1, 0, 1] })

      // A reader with no review of their own: pure newest-first, `mine` null.
      const asDee = (await call(app, 'GET', reviewsUrl(MARP), 'tok-dee')).json().data
      expect(asDee.reviews.map((r: { authorName: string }) => r.authorName)).toEqual(['Cy', 'Ann Lee', 'Harness user'])
      expect(asDee.mine).toBeNull()

      // The wire shape of a row: ISO dates, the author's display name, and nothing that names the user.
      const annRow = asBo.reviews[2]
      expect(annRow).toEqual({
        id: ann.id, harnessId: MARP, rating: 5, title: 'Keynote in a minute', body: 'The pane is the deck.',
        authorName: 'Ann Lee', mine: false, createdAt: ann.createdAt.toISOString(), updatedAt: ann.updatedAt.toISOString(),
      })
      expect(JSON.stringify(asBo)).not.toMatch(/u-ann|u-cy|@example\.com/)
    })

    it('caps the list at 200 but still summarizes every rating and still finds the reader\'s older review', async () => {
      // Ann reviewed first; 250 people reviewed after her, so hers is not among the 200 newest.
      seed({ harnessId: MARP, userId: 'u-ann', rating: 1, authorName: 'Ann Lee' })
      for (let i = 0; i < 250; i++) seed({ harnessId: MARP, userId: `u-${i}`, rating: 5 })

      const asAnn = (await call(app, 'GET', reviewsUrl(MARP), 'tok-ann')).json().data
      expect(asAnn.rating).toEqual({ harnessId: MARP, average: 4.98, count: 251, histogram: [1, 0, 0, 0, 250] })
      expect(asAnn.reviews).toHaveLength(200)
      expect(asAnn.mine).toMatchObject({ authorName: 'Ann Lee', rating: 1, mine: true })
      expect(asAnn.reviews[0]).toEqual(asAnn.mine)
      // After hers, the 199 newest of everyone else's.
      const newest = [...db.rows].filter((r) => r.userId !== 'u-ann').sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, 199)
      expect(asAnn.reviews.slice(1).map((r: { id: string }) => r.id)).toEqual(newest.map((r) => r.id))

      // Someone without a review sees exactly the 200 newest, and the same summary as the ratings list.
      const asCy = (await call(app, 'GET', reviewsUrl(MARP), 'tok-cy')).json().data
      expect(asCy.reviews).toHaveLength(200)
      expect(asCy.mine).toBeNull()
      expect(asCy.reviews.every((r: { rating: number }) => r.rating === 5)).toBe(true)
      const [summary] = (await call(app, 'GET', STORE_RATINGS_PATH, 'tok-cy')).json().data.ratings
      expect({ harnessId: MARP, ...asCy.rating }).toEqual(summary)
    })
  })

  describe('PUT the signed-in user\'s review', () => {
    it('creates the review and answers it as a `mine` row', async () => {
      const res = await call(app, 'PUT', reviewUrl(MARP), 'tok-ann', { rating: 5, title: '  Keynote in a minute  ', body: '\nThe pane is the deck.\n' })
      expect(res.statusCode).toBe(200)
      const { review } = res.json().data
      expect(review).toEqual({
        id: 'r1', harnessId: MARP, rating: 5, title: 'Keynote in a minute', body: 'The pane is the deck.',
        authorName: 'Ann Lee', mine: true, createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z',
      })
      expect(prisma.harnessReview.upsert).toHaveBeenCalledWith({
        where: { harnessId_userId: { harnessId: MARP, userId: 'u-ann' } },
        create: { harnessId: MARP, userId: 'u-ann', rating: 5, title: 'Keynote in a minute', body: 'The pane is the deck.', authorName: 'Ann Lee' },
        update: { rating: 5, title: 'Keynote in a minute', body: 'The pane is the deck.', authorName: 'Ann Lee' },
      })
    })

    it('replaces the same person\'s review on a second write: one row, same id and createdAt, fields not sent are cleared', async () => {
      const first = (await call(app, 'PUT', reviewUrl(MARP), 'tok-ann', { rating: 5, title: 'Great', body: 'Loved it.' })).json().data.review
      db.users.set('u-ann', { name: 'Ann Lee-Park' })
      const second = (await call(app, 'PUT', reviewUrl(MARP), 'tok-ann', { rating: 2, body: 'Art generation is slow.' })).json().data.review

      expect(db.rows).toHaveLength(1)
      expect(second).toMatchObject({ id: first.id, createdAt: first.createdAt, rating: 2, title: null, body: 'Art generation is slow.', authorName: 'Ann Lee-Park', mine: true })
      expect(Date.parse(second.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt))
      expect((await call(app, 'GET', STORE_RATINGS_PATH, 'tok-ann')).json().data.ratings)
        .toEqual([{ harnessId: MARP, average: 2, count: 1, histogram: [0, 1, 0, 0, 0] }])
    })

    it('keeps one row per person per harness: other people and other harnesses are separate rows', async () => {
      await call(app, 'PUT', reviewUrl(MARP), 'tok-ann', { rating: 5 })
      await call(app, 'PUT', reviewUrl(MARP), 'tok-bo', { rating: 3 })
      await call(app, 'PUT', reviewUrl('autonomous/blender'), 'tok-ann', { rating: 4 })
      await call(app, 'PUT', reviewUrl(MARP), 'tok-ann', { rating: 4 })
      expect(db.rows.map((r) => [r.harnessId, r.userId, r.rating])).toEqual([[MARP, 'u-ann', 4], [MARP, 'u-bo', 3], ['autonomous/blender', 'u-ann', 4]])
      expect((await call(app, 'GET', STORE_RATINGS_PATH, 'tok-bo')).json().data.ratings).toEqual([
        { harnessId: 'autonomous/blender', average: 4, count: 1, histogram: [0, 0, 0, 1, 0] },
        { harnessId: MARP, average: 3.5, count: 2, histogram: [0, 0, 1, 1, 0] },
      ])
    })

    it('stores an empty or whitespace-only title and body as null, and accepts null for either', async () => {
      const blank = (await call(app, 'PUT', reviewUrl(MARP), 'tok-ann', { rating: 4, title: '   ', body: '' })).json().data.review
      expect([blank.title, blank.body]).toEqual([null, null])
      // What a GET hands back can be written back as-is: title and body arrive as null.
      const res = await call(app, 'PUT', reviewUrl(MARP), 'tok-ann', { rating: 3, title: null, body: null })
      expect(res.statusCode).toBe(200)
      expect(res.json().data.review).toMatchObject({ rating: 3, title: null, body: null })
    })

    it('ignores fields a client may not set: nobody writes as someone else or under another name or harness', async () => {
      const res = await call(app, 'PUT', reviewUrl(MARP), 'tok-bo', { rating: 1, userId: 'u-ann', authorName: 'Ann Lee', harnessId: 'autonomous/blender', id: 'r99', mine: false })
      expect(res.statusCode).toBe(200)
      expect(db.rows).toEqual([expect.objectContaining({ id: 'r1', harnessId: MARP, userId: 'u-bo', authorName: 'Harness user', rating: 1 })])
    })

    it.each([
      ['a trimmed name', '  Ann Lee  ', 'Ann Lee'],
      ['no name', null, 'Harness user'],
      ['a blank name', '   ', 'Harness user'],
      ['an 81+ character name, cut to 80', 'N'.repeat(120), 'N'.repeat(80)],
    ])('signs the review with %s', async (_label, name, authorName) => {
      db.users.set('u-ann', { name })
      const res = await call(app, 'PUT', reviewUrl(MARP), 'tok-ann', { rating: 5 })
      expect(res.json().data.review.authorName).toBe(authorName)
    })

    it('signs the review "Harness user" when the account has no user row', async () => {
      db.users.delete('u-ann')
      const res = await call(app, 'PUT', reviewUrl(MARP), 'tok-ann', { rating: 5 })
      expect(res.statusCode).toBe(200)
      expect(res.json().data.review.authorName).toBe('Harness user')
      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'u-ann' }, select: { name: true } })
    })

    it('accepts every whole rating from 1 to 5 and titles and bodies right at their limits (after trimming)', async () => {
      for (const rating of [1, 2, 3, 4, 5]) {
        expect((await call(app, 'PUT', reviewUrl(MARP), 'tok-ann', { rating })).statusCode).toBe(200)
      }
      const res = await call(app, 'PUT', reviewUrl(MARP), 'tok-ann', { rating: 5, title: ` ${'t'.repeat(80)} `, body: `\n${'b'.repeat(2000)}\n` })
      expect(res.statusCode).toBe(200)
      expect(res.json().data.review.title).toHaveLength(80)
      expect(res.json().data.review.body).toHaveLength(2000)
    })

    it.each([
      ['a rating of 0', { rating: 0 }],
      ['a rating of 6', { rating: 6 }],
      ['a fractional rating', { rating: 4.5 }],
      ['a rating sent as a string', { rating: '5' }],
      ['a null rating', { rating: null }],
      ['no rating', { title: 'Nice' }],
      ['an 81-character title', { rating: 5, title: 't'.repeat(81) }],
      ['a 2001-character body', { rating: 5, body: 'b'.repeat(2001) }],
      ['a title that is not a string', { rating: 5, title: 42 }],
      ['a body that is not a string', { rating: 5, body: ['x'] }],
      ['a request body that is a list', [{ rating: 5 }]],
    ])('refuses %s with a 400 and writes nothing', async (_label, payload) => {
      const res = await call(app, 'PUT', reviewUrl(MARP), 'tok-ann', payload)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } })
      expect(prisma.harnessReview.upsert).not.toHaveBeenCalled()
      expect(db.rows).toEqual([])
    })

    it('refuses a request with no body at all', async () => {
      const res = await call(app, 'PUT', reviewUrl(MARP), 'tok-ann')
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid input: expected object, received undefined' } })
      expect(db.rows).toEqual([])
    })
  })

  describe('DELETE the signed-in user\'s review', () => {
    it('deletes only the caller\'s own review of that harness', async () => {
      seed({ harnessId: MARP, userId: 'u-ann', rating: 5 })
      seed({ harnessId: MARP, userId: 'u-bo', rating: 3 })
      seed({ harnessId: 'autonomous/blender', userId: 'u-ann', rating: 4 })

      const res = await call(app, 'DELETE', reviewUrl(MARP), 'tok-ann')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ success: true, data: { deleted: true } })
      expect(prisma.harnessReview.deleteMany).toHaveBeenCalledWith({ where: { harnessId: MARP, userId: 'u-ann' } })
      expect(db.rows.map((r) => [r.harnessId, r.userId])).toEqual([[MARP, 'u-bo'], ['autonomous/blender', 'u-ann']])
    })

    it('is a 404 when the caller has no review of that harness, even if others do, and a second delete is too', async () => {
      seed({ harnessId: MARP, userId: 'u-ann', rating: 5 })
      const notYours = await call(app, 'DELETE', reviewUrl(MARP), 'tok-bo')
      expect(notYours.statusCode).toBe(404)
      expect(notYours.json()).toEqual({ success: false, error: { code: 'NO_REVIEW', message: 'You have not reviewed this harness' } })
      expect(db.rows).toHaveLength(1)

      expect((await call(app, 'DELETE', reviewUrl(MARP), 'tok-ann')).statusCode).toBe(200)
      expect((await call(app, 'DELETE', reviewUrl(MARP), 'tok-ann')).statusCode).toBe(404)
      expect((await call(app, 'GET', STORE_RATINGS_PATH, 'tok-ann')).json().data.ratings).toEqual([])
    })
  })

  describe('the harness id in the path', () => {
    const at64 = 'a'.repeat(64)
    // The same shape as the CLI's DSH_ID_RE and the spec's `id` pattern: lowercase letters, digits and
    // hyphens, 1..64 per half, not starting with a hyphen.
    const valid = ['a/b', '0/9', 'autonomous/text-to-cad', `${at64}/${at64}`, 'owner-/name-', 'a--b/c--d']
    const invalid = [
      'Autonomous/marp', // uppercase: the same harness under another spelling would get a second review
      'autonomous/Marp',
      `${at64}a/marp`, // 65 characters
      `autonomous/${at64}a`,
      '-autonomous/marp',
      'autonomous/-marp',
      'auto_nomous/marp',
      'autonomous/marp.v2',
      'auto%20nomous/marp',
      'autonomous/m%C3%A4rp',
    ]

    it.each(valid)('accepts %s on every route', async (id) => {
      expect((await call(app, 'PUT', reviewUrl(id), 'tok-ann', { rating: 4 })).json().data.review.harnessId).toBe(id)
      expect((await call(app, 'GET', reviewsUrl(id), 'tok-ann')).json().data.mine.harnessId).toBe(id)
      expect((await call(app, 'DELETE', reviewUrl(id), 'tok-ann')).statusCode).toBe(200)
    })

    it.each(invalid)('refuses %s with a 400 on every route, before the database', async (id) => {
      for (const [method, url, payload] of [['GET', reviewsUrl(id)], ['PUT', reviewUrl(id), { rating: 5 }], ['DELETE', reviewUrl(id)]] as const) {
        const res = await call(app, method, url, 'tok-ann', payload)
        expect(res.statusCode, `${method} ${url}`).toBe(400)
        expect(res.json()).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } })
      }
      for (const fn of [prisma.user.findUnique, ...Object.values(prisma.harnessReview)]) expect(fn).not.toHaveBeenCalled()
    })

    it('does not treat a case variant as another harness to review twice', async () => {
      await call(app, 'PUT', reviewUrl(MARP), 'tok-ann', { rating: 5 })
      await call(app, 'PUT', reviewUrl('Autonomous/MARP'), 'tok-ann', { rating: 1 })
      expect(db.rows.map((r) => [r.harnessId, r.rating])).toEqual([[MARP, 5]])
    })
  })
})
