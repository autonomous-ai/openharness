import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify'

type Row = Record<string, unknown> & { id: string; createdAt: Date }
type Query = { where?: Record<string, unknown>; select?: Record<string, boolean>; take?: number; skip?: number; cursor?: { id: string }; orderBy?: Record<string, 'asc' | 'desc'>[] | { _max: Record<string, 'asc' | 'desc'> }; by?: string[]; _max?: Record<string, boolean> }
const db = vi.hoisted(() => {
  function matches(row: Row, where: Record<string, unknown> = {}): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (key === 'OR') return (value as Record<string, unknown>[]).some(branch => matches(row, branch))
      if (key === 'AND') return (value as Record<string, unknown>[]).every(branch => matches(row, branch))
      if (value && typeof value === 'object' && !(value instanceof Date)) {
        const filter = value as Record<string, unknown>
        if ('startsWith' in filter) return typeof row[key] === 'string' && (row[key] as string).startsWith(filter.startsWith as string)
        if ('contains' in filter) return typeof row[key] === 'string' && (row[key] as string).toLowerCase().includes((filter.contains as string).toLowerCase())
        if ('in' in filter) return (filter.in as unknown[]).includes(row[key])
        if ('notIn' in filter) return !(filter.notIn as unknown[]).includes(row[key])
        if ('gt' in filter) return (row[key] as Date) > (filter.gt as Date)
        if ('lt' in filter) return (row[key] as number | Date) < (filter.lt as number | Date)
        if ('gte' in filter) return (row[key] as number | Date) >= (filter.gte as number | Date)
        if ('isSet' in filter || 'not' in filter) return (!filter.isSet || row[key] !== undefined) && (!('not' in filter) || row[key] !== filter.not)
        return matches(row, filter)
      }
      return value instanceof Date ? (row[key] as Date)?.getTime() === value.getTime() : row[key] === value
    })
  }
  const picked = (row: Row, select?: Record<string, boolean>) => select ? Object.fromEntries(Object.keys(select).map(key => [key, row[key]])) : { ...row }
  const compare = (a: unknown, b: unknown) => a instanceof Date ? a.getTime() - (b as Date).getTime() : typeof a === 'number' ? a - (b as number) : String(a).localeCompare(String(b))
  /** `defaults` stand in for Prisma's on rows a test pushes directly; `unique` refuses a second create, as the index does. */
  function table({ defaults = {}, unique }: { defaults?: Record<string, unknown>; unique?: string[] } = {}) {
    const rows: Row[] = []
    const find = (query: Query = {}) => {
      for (const row of rows) for (const [key, value] of Object.entries(defaults)) row[key] ??= value
      const order = Array.isArray(query.orderBy) ? query.orderBy : [{ createdAt: 'desc' as const }, { id: 'desc' as const }]
      let result = rows.filter(row => matches(row, query.where)).slice().sort((a, b) => {
        for (const [key, direction] of order.flatMap(Object.entries)) {
          const difference = compare(a[key], b[key])
          if (difference) return direction === 'desc' ? -difference : difference
        }
        return 0
      })
      if (query.cursor) result = result.slice(result.findIndex(row => row.id === query.cursor!.id) + (query.skip || 0))
      if (query.take) result = result.slice(0, query.take)
      return result
    }
    return {
      rows,
      findMany: vi.fn(async (query: Query = {}) => find(query).map(row => picked(row, query.select))),
      findFirst: vi.fn(async (query: Query) => { const row = find(query)[0]; return row ? picked(row, query.select) : null }),
      findUnique: vi.fn(async (query: Query) => find(query)[0] || null),
      count: vi.fn(async (query: Query) => find(query).length),
      groupBy: vi.fn(async (query: Query) => {
        const keys = query.by ?? ['harnessId'], groups = new Map<string, { row: Row; count: number; latest: Date }>()
        for (const row of find({ where: query.where })) {
          const id = keys.map(key => row[key]).join('|'), group = groups.get(id)
          if (group) { group.count++; if (row.createdAt > group.latest) group.latest = row.createdAt } else groups.set(id, { row, count: 1, latest: row.createdAt })
        }
        let result = [...groups.values()]
        if (query.orderBy && !Array.isArray(query.orderBy)) result = result.sort((a, b) => b.latest.getTime() - a.latest.getTime())
        if (query.take) result = result.slice(0, query.take)
        return result.map(({ row, count, latest }) => ({ ...Object.fromEntries(keys.map(key => [key, row[key]])), _count: { _all: count }, ...(query._max ? { _max: { createdAt: latest } } : {}) }))
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (unique && rows.some(row => unique.every(key => row[key] === data[key]))) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
        const row = { id: crypto.randomUUID(), createdAt: new Date(), ...defaults, ...data } as Row; rows.push(row); return row
      }),
      upsert: vi.fn(async ({ where, create, update }: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        let row = rows.find(row => matches(row, where));
        if (row) Object.assign(row, update)
        else { row = { id: crypto.randomUUID(), createdAt: new Date(), ...create } as Row; rows.push(row) }
        return row
      }),
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => { for (const row of data) rows.push({ id: crypto.randomUUID(), createdAt: new Date(), ...defaults, ...row } as Row); return { count: data.length } }),
      deleteMany: vi.fn(async ({ where }: Query) => { const removed = rows.filter(row => matches(row, where)); removed.forEach(row => rows.splice(rows.indexOf(row), 1)); return { count: removed.length } }),
      updateMany: vi.fn(async ({ where, data }: Query & { data: Record<string, unknown> }) => {
        const found = rows.filter(row => matches(row, where))
        for (const row of found) for (const [key, value] of Object.entries(data)) {
          row[key] = value && typeof value === 'object' && 'increment' in value ? ((row[key] as number) ?? 0) + (value.increment as number) : value
        }
        return { count: found.length }
      }),
    }
  }
  return { communityHarness: table({ defaults: { likeCount: 0 } }), communityLike: table({ unique: ['autonomousEnv', 'harnessId', 'userId'] }), communityComment: table(), communityFollow: table(),
    communityReport: table({ unique: ['autonomousEnv', 'targetType', 'targetId', 'userId'] }), communityHidden: table({ defaults: { restoredAt: null } }), communityNotification: table(), user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ name: where.id === 'alice' ? 'Alice' : 'Bob' })) } }
})
vi.mock('../lib/prisma.js', () => ({ prisma: db }))
import { communityRoutes, publicationSchema } from './community.js'
import { communityCommentRoutes } from './communityComments.js'
import { communityCreatorRoutes } from './communityCreators.js'
import { communityNotificationRoutes } from './communityNotifications.js'
import { communityReportRoutes, resetReportRateLimits } from './communityReports.js'
import { communityEditRoutes, resetEditRateLimits } from './communityEdit.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'
import { communityStarters, isPublicCommunityRead } from '../lib/communityAccess.js'

const sample = { title: 'A little idea', description: 'An editable project', category: 'Apps', engine: 'Codex', files: [{ path: 'index.html', content: '<h1>A little idea</h1>' }], viewerPath: 'index.html', conversation: [{ role: 'user', text: 'Make a little idea.' }], confirmed: true, license: 'MIT' }
const starter = 'starter-pocket-film'
let app: FastifyInstance
function call(method: InjectOptions['method'], path: string, token?: string, payload?: unknown, env = 'prod') {
  return app.inject({ method, url: `/api/community/${path}`, ...(payload ? { payload: payload as InjectOptions['payload'] } : {}), headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-autonomous-env': env } })
}
async function publish(token = 'alice', payload = sample, env = 'prod') {
  const response = await call('POST', 'harnesses', token, payload, env)
  expect(response.statusCode).toBe(201)
  return response.json().data.id as string
}
beforeEach(async () => {
  for (const model of [db.communityHarness, db.communityLike, db.communityComment, db.communityFollow, db.communityReport, db.communityHidden, db.communityNotification]) model.rows.splice(0)
  vi.clearAllMocks(); resetEditRateLimits(); resetReportRateLimits()
  app = Fastify(); app.setErrorHandler(errorHandler)
  registerAuthMiddleware(app, async (token, autonomousEnv = 'prod') => {
    if (!['alice', 'bob', 'carol', 'dave', 'admin'].includes(token)) throw new Error('Invalid token')
    return { sub: token, email: `${token}@example.com`, role: token === 'admin' ? 'admin' : 'user', autonomousEnv }
  })
  await app.register(communityRoutes); await app.register(communityEditRoutes); await app.register(communityCommentRoutes); await app.register(communityCreatorRoutes); await app.register(communityReportRoutes); await app.register(communityNotificationRoutes); await app.ready()
})
afterEach(async () => app.close())

describe('publications and access', () => {
  it('shows feed engagement and gives the creator a place to find and reply to comments', async () => {
    const id = await publish()
    await call('PUT', `harnesses/${id}/like`, 'bob', { liked: true })
    const comment = (await call('POST', `harnesses/${id}/comments`, 'bob', { body: 'How did you make this?', clientId: crypto.randomUUID() })).json().data.comment
    const reply = await call('POST', `harnesses/${id}/comments`, 'alice', { body: 'Start from the source and change the colors.', parentId: comment.id, clientId: crypto.randomUUID() })
    expect(reply.statusCode).toBe(200)
    expect(reply.json().data.comment).toMatchObject({ creator: true, parentId: comment.id, parentAuthorName: 'Bob' })
    const feed = (await call('GET', 'harnesses?mine=true', 'alice')).json().data
    expect(feed.harnesses.map((row: Row) => row.id)).toEqual([id])
    expect(feed.stats[id]).toEqual({ likes: 1, comments: 2, forks: 0, liked: false })
    expect((await call('GET', 'harnesses?mine=true', 'bob')).json().data.harnesses).toEqual([])
    expect((await call('GET', 'harnesses?mine=true')).statusCode).toBe(401)
  })
  it('keeps replies inside the same public harness and account environment', async () => {
    const id = await publish()
    const comment = (await call('POST', `harnesses/${id}/comments`, 'bob', { body: 'A question', clientId: crypto.randomUUID() })).json().data.comment
    const payload = { body: 'A reply', clientId: crypto.randomUUID(), parentId: comment.id }
    expect((await call('POST', `harnesses/${starter}/comments`, 'alice', payload)).statusCode).toBe(404)
    expect((await call('POST', `harnesses/${starter}/comments`, 'alice', payload, 'stag')).statusCode).toBe(404)
    await call('DELETE', `harnesses/${id}/comments/${comment.id}`, 'bob')
    expect((await call('POST', `harnesses/${id}/comments`, 'alice', payload)).statusCode).toBe(404)
  })
  it('reads a gzipped publication as the JSON it carries, and refuses one that is not', async () => {
    const game = { ...sample, files: [{ path: 'index.html', content: '<canvas></canvas><script>document.body.innerHTML = "go"</script>' }] }
    const send = (body: Buffer) => app.inject({ method: 'POST', url: '/api/community/harnesses', payload: body, headers: { authorization: 'Bearer alice', 'x-autonomous-env': 'prod', 'content-type': 'application/gzip' } })
    const response = await send(gzipSync(JSON.stringify(game)))
    expect(response.statusCode).toBe(201)
    expect(db.communityHarness.rows[0].files).toEqual(game.files)
    expect((await send(Buffer.from('not gzip'))).statusCode).toBe(400)
    // Bounded: a small body that would inflate past the snapshot is refused, not unpacked.
    expect((await send(gzipSync(Buffer.alloc(7_000_000, 32)))).statusCode).toBe(400)
  })
  it('finds a publication by its web address, the title and its id’s first characters, even after a retitle', async () => {
    const id = await publish('alice', { ...sample, title: 'PAC-MAN: Neon Maze Chase' })
    const short = id.slice(0, 8)
    const read = await call('GET', `harnesses/pac-man-neon-maze-chase-${short}?files=viewer`)
    expect(read.statusCode).toBe(200)
    expect(read.json().data.harness.id).toBe(id)
    expect((await call('GET', `harnesses/an-older-title-${short}`)).json().data.harness.id).toBe(id)
    expect((await call('GET', `harnesses/${short}`)).json().data.harness.id).toBe(id)
    expect((await call('GET', `harnesses/pac-man-neon-maze-chase-${short}`, undefined, undefined, 'stag')).statusCode).toBe(404)
    expect((await call('GET', 'harnesses/pac-man-neon-maze-chase-00000000')).statusCode).toBe(404)
  })
  it('lets the author edit a publication in place, keeping its address, likes, origin and cover', async () => {
    const cover = 'data:image/png;base64,' + Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')
    const original = await publish('bob', { ...sample, title: 'Original' })
    const id = await publish('alice', { ...sample, forkedFrom: original, cover } as typeof sample)
    await call('PUT', `harnesses/${id}/like`, 'bob', { liked: true })
    const { confirmed, license, ...rest } = sample
    const edit = { ...rest, title: 'TANK 1987', files: [{ path: 'tank/index.html', content: '<canvas></canvas><script>go()</script>' }], viewerPath: 'tank/index.html', confirmed, license }
    expect((await call('PUT', `harnesses/${id}`, 'alice', edit)).statusCode).toBe(200)
    const read = (await call('GET', `harnesses/${id}`, 'alice')).json().data
    expect(read.harness).toMatchObject({ id, title: 'TANK 1987', viewerPath: 'tank/index.html', forkedFrom: original })
    expect(read.harness.cover).toMatch(new RegExp(`^/api/community/harnesses/${id}/cover\\?v=\\d+$`))
    expect(read.social.likes).toBe(1)
    expect(db.communityHarness.rows).toHaveLength(2)
  })
  it('refuses an edit by anyone but the author, of a starter, or that changes where it came from', async () => {
    const id = await publish('alice')
    const { confirmed, license, ...rest } = sample
    const edit = { ...rest, title: 'Mine now', confirmed, license }
    expect((await call('PUT', `harnesses/${id}`, 'bob', edit)).statusCode).toBe(403)
    expect((await call('PUT', `harnesses/${id}`, undefined, edit)).statusCode).toBe(401)
    expect((await call('PUT', `harnesses/${starter}`, 'alice', edit)).statusCode).toBe(400)
    expect((await call('PUT', `harnesses/${id}`, 'alice', { ...edit, forkedFrom: starter })).statusCode).toBe(400)
    expect((await call('PUT', `harnesses/${id}`, 'alice', { ...edit, viewerPath: 'missing.html' })).statusCode).toBe(400)
    expect((await call('GET', `harnesses/${id}`)).json().data.harness.title).toBe(sample.title)
  })
  it('returns the same publication after a lost-response retry', async () => {
    const payload = { ...sample, clientId: crypto.randomUUID() }
    const first = await publish('alice', payload)
    expect(await publish('alice', payload)).toBe(first)
    expect(db.communityHarness.rows).toHaveLength(1)
  })
  it('retains a named harness and binary output through publishing and public reads', async () => {
    const payload = { ...sample, harnessId: 'autonomous/blender', files: [
      ...sample.files,
      { path: 'scenes/hello.py', content: 'print("editable source")' },
      { path: 'out/model.glb', content: 'Z2xURg==', encoding: 'base64' },
    ] };
    const response = await call('POST', 'harnesses', 'alice', payload);
    expect(response.statusCode).toBe(201);
    const id = response.json().data.id;
    const detail = (await call('GET', `harnesses/${id}`)).json().data.harness;
    expect(detail.harnessId).toBe('autonomous/blender');
    expect(detail.files).toEqual(payload.files);
    expect((await call('GET', 'harnesses')).json().data.harnesses[0].harnessId).toBe('autonomous/blender');
    expect(publicationSchema.safeParse({ ...payload, files: sample.files }).success).toBe(false);
    expect(publicationSchema.safeParse({ ...payload, files: [...payload.files, { path: 'invalid.glb', content: '?bad', encoding: 'base64' }] }).success).toBe(false);
  });
  it('allows only exact public GET routes before sign-in', async () => {
    expect((await call('GET', 'harnesses')).statusCode).toBe(200)
    expect((await call('GET', `harnesses/${starter}`)).json().data.social).toMatchObject({ likes: 0, comments: [], signedIn: false })
    for (const [method, path, payload] of [['POST', 'harnesses', sample], ['PUT', `harnesses/${starter}/like`, { liked: true }], ['POST', `harnesses/${starter}/comments`, { body: 'Hi', clientId: crypto.randomUUID() }], ['PUT', 'creators/harness/follow', { following: true }], ['DELETE', `harnesses/${starter}`, undefined]] as const)
      expect((await call(method, path, undefined, payload)).statusCode).toBe(401)
    expect(isPublicCommunityRead('POST', '/api/community/harnesses')).toBe(false)
    expect(isPublicCommunityRead('POST', '/api/community/harnesses/x/comments')).toBe(false)
    expect(isPublicCommunityRead('GET', '/api/community/harnesses/x/like')).toBe(false)
    expect((await call('GET', 'harnesses?following=true')).statusCode).toBe(401)
    expect((await call('GET', 'harnesses', 'forged')).statusCode).toBe(401)
    expect((await call('GET', 'harnesses', undefined, undefined, 'invalid')).statusCode).toBe(400)
  })
  it('gives readers a cover address and a social state without the project', async () => {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])
    const id = await publish('alice', { ...sample, cover: `data:image/png;base64,${bytes.toString('base64')}` } as typeof sample)
    const address = `/api/community/harnesses/${id}/cover`
    const bare = await publish('alice')
    const feed = (await call('GET', 'harnesses')).json().data.harnesses
    expect(feed.find((row: { id: string }) => row.id === id).cover).toBe(address)
    expect(feed.find((row: { id: string }) => row.id === bare)).not.toHaveProperty('cover')
    // The feed never reads a cover's bytes, only whether there is one.
    expect(db.communityHarness.findMany.mock.calls.every(([query]) => !query?.select?.cover)).toBe(true)
    expect((await call('GET', `harnesses/${id}`)).json().data.harness.cover).toBe(address)
    // An <img> sends no environment header, so the cover does not depend on it.
    const cover = await call('GET', `harnesses/${id}/cover`, undefined, undefined, 'stag')
    expect(cover.statusCode).toBe(200)
    expect(cover.headers['content-type']).toBe('image/png')
    expect(cover.rawPayload.equals(bytes)).toBe(true)
    const social = (await call('GET', `harnesses/${id}/social`, 'bob')).json().data
    expect(Object.keys(social)).toEqual(['social'])
    expect(social.social).toMatchObject({ likes: 0, signedIn: true, mine: false, comments: [] })
    expect((await call('GET', `harnesses/${starter}/social`)).statusCode).toBe(200)
    expect((await call('GET', `harnesses/${starter}/cover`)).statusCode).toBe(404)
    await call('DELETE', `harnesses/${id}`, 'alice')
    expect((await call('GET', `harnesses/${id}/cover`)).statusCode).toBe(404)
    expect((await call('GET', `harnesses/${id}/social`)).statusCode).toBe(404)
    expect(isPublicCommunityRead('GET', address)).toBe(true)
    expect(isPublicCommunityRead('GET', `/api/community/harnesses/${id}/files`)).toBe(false)
  })
  it('publishes an explicit snapshot, retains source attribution, and never exposes emails', async () => {
    const id = await publish('alice', { ...sample, forkedFrom: starter } as typeof sample)
    const result = (await call('GET', `harnesses/${id}`)).json().data
    expect(result.harness.files).toEqual(sample.files)
    expect(result.harness.credits).toEqual([{ id: starter, authorName: 'Harness' }])
    expect(result.harness.authorName).toBe('Alice')
    expect(JSON.stringify(result)).not.toContain('example.com')
    const fork = await publish('bob', { ...sample, forkedFrom: id } as typeof sample)
    expect((await call('GET', `harnesses/${fork}`)).json().data.harness.credits).toEqual([{ id: starter, authorName: 'Harness' }, { id, authorName: 'Alice' }])
    expect((await call('GET', 'harnesses')).json().data.harnesses[0]).not.toHaveProperty('files')
  })
  it('does not cross account environments or let another user unpublish', async () => {
    const id = await publish()
    expect((await call('GET', `harnesses/${id}`, 'bob', undefined, 'stag')).statusCode).toBe(404)
    expect((await call('DELETE', `harnesses/${id}`, 'bob')).statusCode).toBe(404)
    expect((await call('DELETE', `harnesses/${id}`, 'alice')).statusCode).toBe(200)
    expect((await call('GET', `harnesses/${id}`)).statusCode).toBe(404)
    expect((await call('GET', 'harnesses')).json().data.harnesses).toEqual([])
    expect((await call('PUT', `harnesses/${id}/like`, 'bob', { liked: true })).statusCode).toBe(404)
  })
  it('rejects a missing source and limits repeated publication', async () => {
    expect((await call('POST', 'harnesses', 'alice', { ...sample, forkedFrom: 'missing' })).statusCode).toBe(400)
    for (let i = 0; i < 5; i++) await publish()
    expect((await call('POST', 'harnesses', 'alice', sample)).statusCode).toBe(429)
  })
  it.each(['../secret', '/absolute', 'src/../secret', 'src//file', 'AGENTS.md', 'LICENSE', 'README.md', 'OPEN-HARNESS.json', 'src/CLAUDE.md', 'src/.env', 'src/AGENTS.md', 'CON'])('rejects unsafe or reserved file path %s', async path => {
    expect((await call('POST', 'harnesses', 'alice', { ...sample, files: [{ path, content: '' }] })).statusCode).toBe(400)
  })
  it('rejects missing confirmation, missing output, duplicate paths, active covers, and oversized snapshots', () => {
    for (const value of [
      { ...sample, confirmed: false }, { ...sample, viewerPath: 'missing.html' },
      { ...sample, files: [...sample.files, { path: 'INDEX.html', content: 'other' }] },
      { ...sample, cover: 'data:image/svg+xml,<svg onload="alert(1)">' },
      { ...sample, cover: 'data:image/png;base64,ZmFrZQ==' },
      { ...sample, files: [{ path: 'index.html', content: 'x'.repeat(3_000_000) }, { path: 'extra.txt', content: 'x'.repeat(3_000_000) }] },
    ]) expect(publicationSchema.safeParse(value).success).toBe(false)
  })
})

describe('persistent social actions', () => {
  it('makes likes idempotent and removes only the current user’s like', async () => {
    for (let i = 0; i < 2; i++) expect((await call('PUT', `harnesses/${starter}/like`, 'alice', { liked: true })).json().data.likes).toBe(1)
    await call('PUT', `harnesses/${starter}/like`, 'bob', { liked: true })
    expect((await call('PUT', `harnesses/${starter}/like`, 'alice', { liked: false })).json().data).toEqual({ liked: false, likes: 1 })
    expect((await call('GET', `harnesses/${starter}`, 'bob')).json().data.social.liked).toBe(true)
    expect((await call('GET', `harnesses/${starter}`, 'bob', undefined, 'stag')).json().data.social.likes).toBe(0)
  })
  it('deduplicates comment retries and enforces authorship and owner moderation', async () => {
    const id = await publish(), payload = { body: 'A useful starting point.', clientId: crypto.randomUUID() }
    const first = await call('POST', `harnesses/${id}/comments`, 'bob', payload)
    const second = await call('POST', `harnesses/${id}/comments`, 'bob', { ...payload, body: 'Retry content must not replace the comment' })
    expect(second.json()).toEqual(first.json())
    expect(db.communityComment.rows).toHaveLength(1)
    const commentId = first.json().data.comment.id
    expect((await call('DELETE', `harnesses/${id}/comments/${commentId}`, 'bob', undefined, 'stag')).statusCode).toBe(404)
    expect((await call('DELETE', `harnesses/${id}/comments/${commentId}`, 'alice')).statusCode).toBe(200)
    const seedComment = (await call('POST', `harnesses/${starter}/comments`, 'alice', payload)).json().data.comment.id
    expect((await call('DELETE', `harnesses/${starter}/comments/${seedComment}`, 'bob')).statusCode).toBe(404)
    expect((await call('DELETE', `harnesses/${starter}/comments/${seedComment}`, 'alice')).statusCode).toBe(200)
  })
  it('bounds comments and keeps retries possible at the rate limit', async () => {
    const payload = { body: 'Hello', clientId: crypto.randomUUID() }
    await call('POST', `harnesses/${starter}/comments`, 'alice', payload)
    for (let i = 0; i < 9; i++) await call('POST', `harnesses/${starter}/comments`, 'alice', { body: 'Hello', clientId: crypto.randomUUID() })
    expect((await call('POST', `harnesses/${starter}/comments`, 'alice', { body: 'Hello', clientId: crypto.randomUUID() })).statusCode).toBe(429)
    expect((await call('POST', `harnesses/${starter}/comments`, 'alice', payload)).statusCode).toBe(200)
    expect((await call('POST', `harnesses/${starter}/comments`, 'alice', { ...payload, body: ' ' })).statusCode).toBe(400)
  })
  it('searches publications on the server, case-insensitively, within the feed filters', async () => {
    await publish('alice', { ...sample, title: 'Lantern room' }); await publish('bob', { ...sample, title: 'Orbit study', description: 'Planets in a lantern light' })
    const search = async (query: string, token?: string) => (await call('GET', `harnesses?${query}`, token)).json().data.harnesses.map((row: { title: string }) => row.title)
    expect(await search('q=LANTERN')).toEqual(expect.arrayContaining(['Lantern room', 'Orbit study']))
    expect(await search('q=lantern')).toHaveLength(2)
    expect(await search('q=lantern&mine=true', 'alice')).toEqual(['Lantern room'])
    expect(await search('q=nothing-like-this')).toEqual([])
    expect((await call('GET', 'harnesses?q=')).statusCode).toBe(400)
    expect((await call('GET', `harnesses?q=${'x'.repeat(81)}`)).statusCode).toBe(400)
  })
  it('follows real creators and filters the following feed', async () => {
    await publish('alice'); await publish('bob')
    expect((await call('PUT', 'creators/alice/follow', 'bob', { following: true })).statusCode).toBe(200)
    const feed = (await call('GET', 'harnesses?following=true', 'bob')).json().data
    expect(feed.harnesses).toHaveLength(1); expect(feed.harnesses[0].authorId).toBe('alice')
    expect(feed.following).toEqual(['alice'])
    await call('PUT', 'creators/alice/follow', 'bob', { following: false })
    expect((await call('GET', 'harnesses?following=true', 'bob')).json().data.harnesses).toEqual([])
    expect((await call('PUT', 'creators/bob/follow', 'bob', { following: true })).statusCode).toBe(400)
    expect((await call('PUT', 'creators/nobody/follow', 'bob', { following: true })).statusCode).toBe(404)
  })
  it('narrows the feed to one category, rejecting one the Hub does not offer', async () => {
    await publish('alice', { ...sample, title: 'A game', category: 'Games' }); await publish('alice', { ...sample, title: 'An app' })
    const titles = async (query: string) => (await call('GET', `harnesses?${query}`)).json().data.harnesses.map((row: { title: string }) => row.title)
    expect(await titles('category=Games')).toEqual(['A game'])
    expect(await titles('category=Games&q=app')).toEqual([])
    expect((await call('GET', 'harnesses?category=Spam')).statusCode).toBe(400)
    expect((await call('GET', 'harnesses?sort=oldest')).statusCode).toBe(400)
  })
  it('orders the feed by likes, newest first among equals, and pages in that order', async () => {
    const quiet = await publish('alice', { ...sample, title: 'Quiet' })
    const liked = await publish('alice', { ...sample, title: 'Liked' })
    const loved = await publish('bob', { ...sample, title: 'Loved' })
    const newest = await publish('bob', { ...sample, title: 'Newest' })
    // Published within one millisecond, they would tie: give each its own second, in publishing order.
    db.communityHarness.rows.forEach((row, index) => { row.createdAt = new Date(Date.now() + index * 1000) })
    await call('PUT', `harnesses/${liked}/like`, 'bob', { liked: true })
    for (const token of ['alice', 'bob']) await call('PUT', `harnesses/${loved}/like`, token, { liked: true })
    const first = (await call('GET', 'harnesses?sort=popular')).json().data
    expect(first.harnesses.map((row: Row) => row.id)).toEqual([loved, liked, newest, quiet])
    expect(first.nextCursor).toBeNull()
    expect(first.harnesses[0]).not.toHaveProperty('files')
    expect(first.stats[loved]).toMatchObject({ likes: 2 })
    // A page after a harness that has gone ends the feed rather than starting it over.
    await call('DELETE', `harnesses/${liked}`, 'alice')
    expect((await call('GET', `harnesses?sort=popular&cursor=${liked}`)).json().data.harnesses).toEqual([])
  })
  it('ranks the starters among publications in a popular feed, and names them in its order', async () => {
    const quiet = await publish('alice', { ...sample, title: 'Quiet' })
    const liked = await publish('alice', { ...sample, title: 'Liked' })
    await call('PUT', `harnesses/${liked}/like`, 'bob', { liked: true })
    for (const token of ['alice', 'bob']) await call('PUT', 'harnesses/starter-blue-hour/like', token, { liked: true })
    const popular = (await call('GET', 'harnesses?sort=popular')).json().data
    // Most liked first; publications before starters with as many likes; starters in the Hub's order.
    const rest = [...communityStarters].filter(id => id !== 'starter-blue-hour')
    expect(popular.order).toEqual(['starter-blue-hour', liked, quiet, ...rest])
    expect(popular.harnesses.map((row: Row) => row.id)).toEqual([liked, quiet])
    expect(popular.stats['starter-blue-hour']).toMatchObject({ likes: 2 })
    // The newest feed keeps the starters to the website, as before.
    expect((await call('GET', 'harnesses')).json().data).not.toHaveProperty('order')
  })
  it('ranks starters only where the Hub shows them', async () => {
    const id = await publish('alice')
    const order = async (query: string, token?: string) => (await call('GET', `harnesses?sort=popular&${query}`, token)).json().data.order
    expect(await order('mine=true', 'alice')).toEqual([id])
    expect(await order(`forkedFrom=${id}`)).toEqual([])
    expect(await order('following=true', 'bob')).toEqual([])
    await call('PUT', 'creators/harness/follow', 'bob', { following: true })
    expect(await order('following=true', 'bob')).toEqual([...communityStarters])
  })
  it('pages a popular feed past a starter, and only a popular one', async () => {
    for (let i = 0; i < 20; i++) db.communityHarness.rows.push({ ...sample, id: crypto.randomUUID(), createdAt: new Date(Date.now() - i * 1000), autonomousEnv: 'prod', authorId: 'alice', authorName: 'Alice', deletedAt: null, credits: [] })
    const first = (await call('GET', 'harnesses?sort=popular')).json().data
    expect(first.order).toHaveLength(30); expect(first.harnesses).toHaveLength(20)
    expect(first.nextCursor).toBe(first.order[29])
    const second = (await call('GET', `harnesses?sort=popular&cursor=${first.nextCursor}`)).json().data
    expect(second.order).toEqual([...communityStarters].slice(10)); expect(second.nextCursor).toBeNull()
    expect((await call('GET', `harnesses?cursor=${first.nextCursor}`)).statusCode).toBe(400)
  })
  it('pages a popular feed past thirty publications without repeating one', async () => {
    for (let i = 0; i < 31; i++) db.communityHarness.rows.push({ ...sample, id: crypto.randomUUID(), createdAt: new Date(Date.now() - i * 1000), autonomousEnv: 'prod', authorId: 'alice', authorName: 'Alice', deletedAt: null, credits: [] })
    const first = (await call('GET', 'harnesses?sort=popular')).json().data
    expect(first.harnesses).toHaveLength(30)
    const second = (await call('GET', `harnesses?sort=popular&cursor=${first.nextCursor}`)).json().data
    expect(second.harnesses).toHaveLength(1); expect(second.nextCursor).toBeNull()
    expect(first.harnesses.map((row: Row) => row.id)).not.toContain(second.harnesses[0].id)
  })
  it('keeps a publication’s like count exact across repeats and requests at once', async () => {
    const id = await publish('alice')
    const count = () => db.communityHarness.rows.find(row => row.id === id)?.likeCount
    await Promise.all([call('PUT', `harnesses/${id}/like`, 'bob', { liked: true }), call('PUT', `harnesses/${id}/like`, 'bob', { liked: true })])
    expect(count()).toBe(1)
    expect((await call('PUT', `harnesses/${id}/like`, 'alice', { liked: true })).json().data).toEqual({ liked: true, likes: 2 })
    await call('PUT', `harnesses/${id}/like`, 'bob', { liked: false })
    await call('PUT', `harnesses/${id}/like`, 'bob', { liked: false })
    expect(count()).toBe(1)
  })
  it('pages a popular feed by its like counts, every publication and starter once, most liked first', async () => {
    const likes = (index: number) => index % 4
    for (let i = 0; i < 45; i++) db.communityHarness.rows.push({ ...sample, id: crypto.randomUUID(), createdAt: new Date(Date.now() - i * 1000), autonomousEnv: 'prod', authorId: 'alice', authorName: 'Alice', deletedAt: null, credits: [], likeCount: likes(i) })
    for (const token of ['alice', 'bob']) await call('PUT', 'harnesses/starter-orbit/like', token, { liked: true })
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page: { order: string[]; nextCursor: string | null } = (await call('GET', `harnesses?sort=popular${cursor ? `&cursor=${cursor}` : ''}`)).json().data
      seen.push(...page.order); cursor = page.nextCursor
    } while (cursor)
    expect(new Set(seen).size).toBe(45 + communityStarters.size)
    expect(seen).toHaveLength(45 + communityStarters.size)
    const count = (id: string) => id === 'starter-orbit' ? 2 : communityStarters.has(id) ? 0 : db.communityHarness.rows.find(row => row.id === id)!.likeCount as number
    expect(seen.map(count)).toEqual(seen.map(count).slice().sort((a, b) => b - a))
    // Among equal likes the publications come first: the starter with two follows every publication with two.
    expect(seen.indexOf('starter-orbit')).toBe(seen.filter(id => count(id) >= 2).length - 1)
  })
  it('trends by this week’s likes, then every other publication newest first, then the unliked starters', async () => {
    const [old, quiet, liked, likedMore] = [await publish('alice', { ...sample, title: 'Old favourite' }), await publish('alice', { ...sample, title: 'Quiet' }), await publish('bob', { ...sample, title: 'Liked' }), await publish('bob', { ...sample, title: 'Liked more' })]
    db.communityHarness.rows.forEach((row, index) => { row.createdAt = new Date(Date.now() + index * 1000) })
    const like = (harnessId: string, userId: string, daysAgo = 0) => db.communityLike.rows.push({ id: crypto.randomUUID(), autonomousEnv: 'prod', harnessId, userId, createdAt: new Date(Date.now() - daysAgo * 86_400_000) })
    for (const user of ['a', 'b', 'c', 'd']) like(old, user, 30)
    like(liked, 'a'); like(likedMore, 'a'); like(likedMore, 'b'); like('starter-orbit', 'a')
    const cold = [...communityStarters].filter(id => id !== 'starter-orbit')
    const first = (await call('GET', 'harnesses?sort=trending')).json().data
    expect(first.order).toEqual([likedMore, liked, 'starter-orbit', quiet, old, ...cold])
    expect(first.harnesses.map((row: Row) => row.id)).toEqual([likedMore, liked, quiet, old])
    expect((await call('GET', `harnesses?sort=trending&cursor=${cold[3]}`)).json().data.order).toEqual(cold.slice(4))
  })
  it('pages a trending feed with every publication and starter once', async () => {
    for (let i = 0; i < 45; i++) db.communityHarness.rows.push({ ...sample, id: crypto.randomUUID(), createdAt: new Date(Date.now() - i * 1000), autonomousEnv: 'prod', authorId: 'alice', authorName: 'Alice', deletedAt: null, credits: [] })
    for (const row of db.communityHarness.rows.slice(10, 13)) db.communityLike.rows.push({ id: crypto.randomUUID(), autonomousEnv: 'prod', harnessId: row.id, userId: 'bob', createdAt: new Date() })
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page: { order: string[]; nextCursor: string | null } = (await call('GET', `harnesses?sort=trending${cursor ? `&cursor=${cursor}` : ''}`)).json().data
      seen.push(...page.order); cursor = page.nextCursor
    } while (cursor)
    expect(seen).toHaveLength(45 + communityStarters.size)
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.slice(0, 3)).toEqual(db.communityHarness.rows.slice(10, 13).map(row => row.id))
  })
  it('counts and lists a harness’s public forks, and every comment beyond the latest hundred', async () => {
    const id = await publish('alice')
    const fork = await publish('bob', { ...sample, title: 'My version', forkedFrom: id } as typeof sample)
    await publish('bob', { ...sample, title: 'Gone', forkedFrom: id } as typeof sample).then(gone => call('DELETE', `harnesses/${gone}`, 'bob'))
    expect((await call('GET', 'harnesses')).json().data.stats[id]).toMatchObject({ forks: 1 })
    const forks = (await call('GET', `harnesses?forkedFrom=${id}`)).json().data.harnesses
    expect(forks.map((row: Row) => row.id)).toEqual([fork])
    for (let i = 0; i < 101; i++) db.communityComment.rows.push({ id: crypto.randomUUID(), createdAt: new Date(Date.now() + i), autonomousEnv: 'prod', harnessId: id, userId: 'bob', authorName: 'Bob', body: `${i}`, clientId: crypto.randomUUID() })
    const social = (await call('GET', `harnesses/${id}/social`)).json().data.social
    expect(social).toMatchObject({ forks: 1, commentCount: 101 })
    expect(social.comments).toHaveLength(100)
  })
  it('names the publication a fork came from, and says when it is gone', async () => {
    const id = await publish('alice', { ...sample, title: 'The original' })
    const fork = await publish('bob', { ...sample, title: 'My version', forkedFrom: id } as typeof sample)
    const ofStarter = await publish('bob', { ...sample, forkedFrom: starter } as typeof sample)
    expect((await call('GET', `harnesses/${fork}?files=viewer`)).json().data.harness.origin).toEqual({ title: 'The original', authorName: 'Alice' })
    expect((await call('GET', `harnesses/${ofStarter}`)).json().data.harness).not.toHaveProperty('origin')
    expect((await call('GET', `harnesses/${id}`)).json().data.harness).not.toHaveProperty('origin')
    await call('DELETE', `harnesses/${id}`, 'alice')
    expect((await call('GET', `harnesses/${fork}`)).json().data.harness.origin).toBeNull()
  })
  it('says when its author last edited a publication, for a page drawn before then', async () => {
    const id = await publish('alice')
    expect((await call('GET', `harnesses/${id}/social`)).json().data.social.updatedAt).toBeNull()
    expect((await call('PUT', `harnesses/${id}`, 'alice', { ...sample, title: 'Edited' })).statusCode).toBe(200)
    const { updatedAt } = (await call('GET', `harnesses/${id}/social`)).json().data.social
    expect(updatedAt).toBe((await call('GET', `harnesses/${id}`)).json().data.harness.updatedAt)
    expect(updatedAt).toEqual(expect.any(String))
    expect((await call('GET', `harnesses/${starter}/social`)).json().data.social.updatedAt).toBeNull()
  })
  it('reads further back than the latest hundred comments, a page at a time, to anyone', async () => {
    const id = await publish('alice')
    for (let i = 0; i < 250; i++) db.communityComment.rows.push({ id: crypto.randomUUID(), createdAt: new Date(Date.now() + i * 1000), autonomousEnv: 'prod', harnessId: id, userId: i % 2 ? 'bob' : 'carol', authorName: 'Someone', body: `${i}`, clientId: crypto.randomUUID() })
    const latest = (await call('GET', `harnesses/${id}/social`, 'bob')).json().data.social.comments
    expect(latest.map((comment: { body: string }) => comment.body)).toEqual(Array.from({ length: 100 }, (_, i) => `${150 + i}`))
    const earlier = (await call('GET', `harnesses/${id}/comments?before=${latest[0].id}`, 'bob')).json().data
    expect(earlier.comments.map((comment: { body: string }) => comment.body)).toEqual(Array.from({ length: 100 }, (_, i) => `${50 + i}`))
    expect(earlier.more).toBe(true)
    expect(earlier.comments.find((comment: { body: string }) => comment.body === '51')).toMatchObject({ mine: true, creator: false })
    expect(earlier.comments.find((comment: { body: string }) => comment.body === '50')).toMatchObject({ mine: false })
    expect(isPublicCommunityRead('GET', `/api/community/harnesses/${id}/comments?before=${earlier.comments[0].id}`)).toBe(true)
    const first = await call('GET', `harnesses/${id}/comments?before=${earlier.comments[0].id}`)
    expect(first.json().data.comments).toHaveLength(50); expect(first.json().data.more).toBe(false)
    expect(first.headers['cache-control']).toBe('no-store')
    expect((await call('GET', `harnesses/${id}/comments?before=${crypto.randomUUID()}`)).json().data).toEqual({ comments: [], more: false })
    expect((await call('GET', `harnesses/${id}/comments`)).statusCode).toBe(400)
  })
  it('gives a creator a page: their name, followers and harnesses, and the reader’s follow', async () => {
    const first = await publish('alice', { ...sample, title: 'First' })
    await publish('alice', { ...sample, title: 'Second' })
    await publish('bob', { ...sample, title: 'Not hers' })
    db.communityHarness.rows.forEach((row, index) => { row.createdAt = new Date(Date.now() + index * 1000) })
    await call('PUT', 'creators/alice/follow', 'bob', { following: true })
    expect((await call('GET', 'creators/alice')).json().data.creator).toEqual({ id: 'alice', name: 'Alice', followers: 1, following: false, mine: false, signedIn: false })
    expect((await call('GET', 'creators/alice', 'bob')).json().data.creator).toMatchObject({ following: true, signedIn: true })
    expect((await call('GET', 'creators/alice', 'alice')).json().data.creator).toMatchObject({ mine: true })
    const feed = (await call('GET', 'harnesses?author=alice')).json().data
    expect(feed.harnesses.map((row: Row) => row.title)).toEqual(['Second', 'First'])
    expect((await call('GET', 'harnesses?author=alice&sort=popular')).json().data.order).toHaveLength(2)
    expect((await call('GET', 'harnesses?author=harness&sort=popular')).json().data.order).toEqual([...communityStarters])
    expect((await call('GET', 'harnesses?author=alice&mine=true', 'alice')).statusCode).toBe(400)
    expect((await call('GET', 'creators/harness')).json().data.creator).toMatchObject({ name: 'Harness' })
    // Nothing published, no page: an account's id names no one who has not chosen to publish.
    expect((await call('GET', 'creators/carol')).statusCode).toBe(404)
    await call('DELETE', `harnesses/${first}`, 'alice')
    expect(isPublicCommunityRead('GET', '/api/community/creators/alice')).toBe(true)
    expect(isPublicCommunityRead('GET', '/api/community/creators/alice/follow')).toBe(false)
  })
  it('hides a reported harness from its reporter at once, and from everyone after three readers', async () => {
    const id = await publish('alice', { ...sample, title: 'Reported' })
    const report = (token: string, targetId = id, targetType = 'harness') => call('POST', 'reports', token, { targetType, targetId, reason: 'spam' })
    const titles = async (token?: string) => (await call('GET', 'harnesses', token)).json().data.harnesses.map((row: Row) => row.title)
    expect((await report('alice')).statusCode).toBe(400)
    expect((await call('POST', 'reports', undefined, { targetType: 'harness', targetId: id, reason: 'spam' })).statusCode).toBe(401)
    expect((await report('bob')).json().data).toEqual({ reported: true })
    expect(await titles('bob')).toEqual([])
    expect((await call('GET', `harnesses/${id}`, 'bob')).statusCode).toBe(404)
    expect(await titles()).toEqual(['Reported'])
    await report('bob'); await report('carol')
    expect(await titles()).toEqual(['Reported'])
    await report('dave')
    expect(await titles()).toEqual([])
    expect((await call('GET', `harnesses/${id}`)).statusCode).toBe(404)
    expect((await call('PUT', `harnesses/${id}/like`, 'admin', { liked: true })).statusCode).toBe(404)
    // Its author still has it, among their own.
    expect((await call('GET', `harnesses/${id}`, 'alice')).statusCode).toBe(200)
    expect((await call('GET', 'harnesses?mine=true', 'alice')).json().data.harnesses).toHaveLength(1)
    expect((await report('bob', 'starter-orbit')).statusCode).toBe(404)
  })
  // #1026: a harness hidden by reports (a sexual or violent cover) was 404 everywhere but its cover, served for a day.
  it('cover of a report-hidden harness is 404', async () => {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])
    const id = await publish('alice', { ...sample, cover: `data:image/png;base64,${bytes.toString('base64')}` } as typeof sample)
    expect((await call('GET', `harnesses/${id}/cover`)).statusCode).toBe(200)
    for (const token of ['bob', 'carol', 'dave']) await call('POST', 'reports', token, { targetType: 'harness', targetId: id, reason: 'other' })
    expect((await call('GET', `harnesses/${id}`)).statusCode).toBe(404)
    // An <img> sends no environment header: the hidden row is found in the publication's own environment.
    expect((await call('GET', `harnesses/${id}/cover`, undefined, undefined, 'stag')).statusCode).toBe(404)
    expect((await call('GET', `harnesses/${id}/cover`, 'bob')).statusCode).toBe(404)
    // Its author still has it, as they still have its page; a reviewer's restore brings it back for everyone.
    expect((await call('GET', `harnesses/${id}/cover`, 'alice')).statusCode).toBe(200)
    await call('POST', 'reports/review', 'admin', { targetType: 'harness', targetId: id, decision: 'restore' })
    expect((await call('GET', `harnesses/${id}/cover`)).statusCode).toBe(200)
  })
  it('lets a reviewer see reports and restore or remove what they hid', async () => {
    const id = await publish('alice', { ...sample, title: 'Reported' })
    const comment = (await call('POST', `harnesses/${id}/comments`, 'bob', { body: 'Buy now', clientId: crypto.randomUUID() })).json().data.comment
    for (const token of ['carol', 'dave', 'admin']) {
      await call('POST', 'reports', token, { targetType: 'harness', targetId: id, reason: 'spam' })
      await call('POST', 'reports', token, { targetType: 'comment', targetId: comment.id, reason: 'harassment' })
    }
    expect((await call('GET', `harnesses/${id}/social`, 'alice')).json().data.social.comments).toEqual([])
    expect((await call('GET', 'reports', 'bob')).statusCode).toBe(403)
    const queue = (await call('GET', 'reports', 'admin')).json().data.reports
    expect(queue).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetType: 'harness', targetId: id, reports: 3, reasons: { spam: 3 }, state: 'hidden', text: 'Reported', authorName: 'Alice' }),
      expect.objectContaining({ targetType: 'comment', targetId: comment.id, reports: 3, state: 'hidden', text: 'Buy now' }),
    ]))
    const review = (targetType: string, targetId: string, decision: string, token = 'admin') => call('POST', 'reports/review', token, { targetType, targetId, decision })
    expect((await review('harness', id, 'restore', 'bob')).statusCode).toBe(403)
    await review('harness', id, 'restore')
    expect((await call('GET', 'harnesses')).json().data.harnesses).toHaveLength(1)
    // One more report after a review does not hide it again: three new ones would.
    await call('POST', 'reports', 'bob', { targetType: 'harness', targetId: id, reason: 'other' })
    expect((await call('GET', 'harnesses')).json().data.harnesses).toHaveLength(1)
    await review('comment', comment.id, 'remove')
    expect(db.communityComment.rows).toHaveLength(0)
    await review('harness', id, 'remove')
    expect((await call('GET', `harnesses/${id}`, 'alice')).statusCode).toBe(404)
    expect((await call('GET', 'reports', 'admin')).json().data.reports.find((row: { targetId: string }) => row.targetId === id).state).toBe('removed')
  })
  it('tells a creator of comments, replies and forks on their work, never of their own', async () => {
    const id = await publish('alice', { ...sample, title: 'Orbit' })
    const post = (token: string, body: string, parentId?: string) => call('POST', `harnesses/${id}/comments`, token, { body, clientId: crypto.randomUUID(), ...(parentId ? { parentId } : {}) })
    const question = (await post('bob', 'How?')).json().data.comment
    await post('alice', 'Like this.', question.id)
    await post('alice', 'Talking to myself.')
    const fork = await publish('bob', { ...sample, title: 'My orbit', forkedFrom: id } as typeof sample)
    await publish('bob', { ...sample, forkedFrom: starter } as typeof sample)
    const bell = async (token: string) => (await call('GET', 'notifications', token)).json().data
    const alice = await bell('alice'), bob = await bell('bob')
    expect(alice.unread).toBe(2)
    expect(alice.notifications.map((row: { kind: string; actorName: string; harnessTitle: string }) => [row.kind, row.actorName, row.harnessTitle]).sort())
      .toEqual([['comment', 'Bob', 'Orbit'], ['fork', 'Bob', 'Orbit']])
    expect(alice.notifications.find((row: { kind: string }) => row.kind === 'fork').targetId).toBe(fork)
    expect(bob.notifications).toEqual([expect.objectContaining({ kind: 'reply', actorName: 'Alice', harnessId: id, read: false })])
    expect(JSON.stringify(alice)).not.toContain('How?')
    expect((await call('GET', 'notifications/unread', 'alice')).json().data).toEqual({ unread: 2 })
    expect((await call('POST', 'notifications/read', 'alice')).json().data).toEqual({ read: 2 })
    expect((await call('GET', 'notifications/unread', 'alice')).json().data).toEqual({ unread: 0 })
    expect((await call('GET', 'notifications')).statusCode).toBe(401)
  })
  it('tells a comment writer of a reply on their own harness once, as a reply', async () => {
    const id = await publish('alice')
    const mine = (await call('POST', `harnesses/${id}/comments`, 'alice', { body: 'Ask me anything', clientId: crypto.randomUUID() })).json().data.comment
    await call('POST', `harnesses/${id}/comments`, 'bob', { body: 'Why?', clientId: crypto.randomUUID(), parentId: mine.id })
    expect((await call('GET', 'notifications', 'alice')).json().data.notifications.map((row: { kind: string }) => row.kind)).toEqual(['reply'])
  })
  it('sends a harness page only its output when asked', async () => {
    const payload = { ...sample, files: [...sample.files, { path: 'src/app.js', content: 'console.log(1)' }] }
    const id = await publish('alice', payload)
    expect((await call('GET', `harnesses/${id}?files=viewer`)).json().data.harness.files).toEqual(sample.files)
    expect((await call('GET', `harnesses/${id}`)).json().data.harness.files).toEqual(payload.files)
    expect(isPublicCommunityRead('GET', `/api/community/harnesses/${id}?files=viewer`)).toBe(true)
    expect((await call('GET', `harnesses/${id}?files=all`)).statusCode).toBe(400)
  })
})
