import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify'

type Row = Record<string, unknown> & { id: string; createdAt: Date }
type Query = { where?: Record<string, unknown>; select?: Record<string, boolean>; take?: number; skip?: number; cursor?: { id: string }; orderBy?: unknown }
const db = vi.hoisted(() => {
  function matches(row: Row, where: Record<string, unknown> = {}): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (value && typeof value === 'object' && !(value instanceof Date)) {
        const filter = value as Record<string, unknown>
        if ('in' in filter) return (filter.in as unknown[]).includes(row[key])
        if ('gt' in filter) return (row[key] as Date) > (filter.gt as Date)
        return matches(row, filter)
      }
      return row[key] === value
    })
  }
  function table() {
    const rows: Row[] = []
    const find = (query: Query = {}) => {
      let result = rows.filter(row => matches(row, query.where)).slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      if (query.cursor) result = result.slice(result.findIndex(row => row.id === query.cursor!.id) + (query.skip || 0))
      if (query.take) result = result.slice(0, query.take)
      return result
    }
    return {
      rows,
      findMany: vi.fn(async (query: Query = {}) => find(query).map(row => query.select ? Object.fromEntries(Object.keys(query.select).map(key => [key, row[key]])) : { ...row })),
      findFirst: vi.fn(async (query: Query) => find(query)[0] || null),
      findUnique: vi.fn(async (query: Query) => find(query)[0] || null),
      count: vi.fn(async (query: Query) => find(query).length),
      groupBy: vi.fn(async (query: Query) => {
        const counts = new Map<string, number>()
        for (const row of find(query)) counts.set(row.harnessId as string, (counts.get(row.harnessId as string) || 0) + 1)
        return [...counts].map(([harnessId, count]) => ({ harnessId, _count: { _all: count } }))
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = { id: crypto.randomUUID(), createdAt: new Date(), ...data } as Row; rows.push(row); return row }),
      upsert: vi.fn(async ({ where, create, update }: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        let row = rows.find(row => matches(row, where));
        if (row) Object.assign(row, update)
        else { row = { id: crypto.randomUUID(), createdAt: new Date(), ...create } as Row; rows.push(row) }
        return row
      }),
      deleteMany: vi.fn(async ({ where }: Query) => { const removed = rows.filter(row => matches(row, where)); removed.forEach(row => rows.splice(rows.indexOf(row), 1)); return { count: removed.length } }),
      updateMany: vi.fn(async ({ where, data }: Query & { data: Record<string, unknown> }) => { const found = rows.filter(row => matches(row, where)); found.forEach(row => Object.assign(row, data)); return { count: found.length } }),
    }
  }
  return { communityHarness: table(), communityLike: table(), communityComment: table(), communityFollow: table(), user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ name: where.id === 'alice' ? 'Alice' : 'Bob' })) } }
})
vi.mock('../lib/prisma.js', () => ({ prisma: db }))
import { communityRoutes, publicationSchema } from './community.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'
import { isPublicCommunityRead } from '../lib/communityAccess.js'

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
  for (const model of [db.communityHarness, db.communityLike, db.communityComment, db.communityFollow]) model.rows.splice(0)
  vi.clearAllMocks()
  app = Fastify(); app.setErrorHandler(errorHandler)
  registerAuthMiddleware(app, async (token, autonomousEnv = 'prod') => {
    if (!['alice', 'bob'].includes(token)) throw new Error('Invalid token')
    return { sub: token, email: `${token}@example.com`, role: 'user', autonomousEnv }
  })
  await app.register(communityRoutes); await app.ready()
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
    expect(feed.stats[id]).toEqual({ likes: 1, comments: 2, liked: false })
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
    expect(isPublicCommunityRead('GET', '/api/community/harnesses/x/comments')).toBe(false)
    expect((await call('GET', 'harnesses?following=true')).statusCode).toBe(401)
    expect((await call('GET', 'harnesses', 'forged')).statusCode).toBe(401)
    expect((await call('GET', 'harnesses', undefined, undefined, 'invalid')).statusCode).toBe(400)
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
})
