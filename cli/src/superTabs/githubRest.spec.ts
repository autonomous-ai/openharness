import { describe, expect, it, vi } from 'vitest'
import { GitHubReads, githubRest, type GitHubGet } from './githubRest.js'

describe('GitHub\'s REST API as this computer\'s gh login (githubRest.ts)', () => {
  it('reads the token from gh once, asks with the ETag, and reads the token again after GitHub refuses it', async () => {
    const run = vi.fn(async () => ({ stdout: 'gho_token\n' }))
    const request = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify([]), {
      status: (init?.headers as Record<string, string>)['If-None-Match'] ? 401 : 200, headers: { etag: '"v1"' } }))
    const { get } = githubRest(run, request as unknown as typeof fetch)
    expect(await get('/repos/acme/app/issues', null)).toMatchObject({ status: 200, etag: '"v1"', body: [] })
    expect(await get('/repos/acme/app/issues', '"v1"')).toMatchObject({ status: 401 })
    await get('/repos/acme/app/issues', null)
    expect(run).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0]![0]).toBe('https://api.github.com/repos/acme/app/issues')
    expect((request.mock.calls[1]![1]!.headers as Record<string, string>)['If-None-Match']).toBe('"v1"')
  })

  it('sends a body as JSON with its method, with the same token', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ merged: true }), { status: 200 }))
    const { send } = githubRest(async () => ({ stdout: 'gho_token' }), request as unknown as typeof fetch)
    expect(await send('PUT', '/repos/acme/app/pulls/4/merge', { merge_method: 'squash' })).toMatchObject({ status: 200, body: { merged: true } })
    const init = (request.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect([init.method, init.body, (init.headers as Record<string, string>)['Content-Type']]).toEqual(['PUT', '{"merge_method":"squash"}', 'application/json'])
  })

  it('names a rate limit with when it ends, and a missing or signed-out gh by its code', async () => {
    const limited = githubRest(async () => ({ stdout: 'gho_token' }), (async () => new Response('', { status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' } })) as unknown as typeof fetch)
    expect((await limited.get('/repos/acme/app/issues', null)).resetAt).toBe(1_800_000_000_000)
    const missing = githubRest(async () => { throw Object.assign(new Error('gh was not found'), { code: 'ENOENT', stderr: '' }) })
    await expect(missing.get('/repos/acme/app/issues', null)).rejects.toMatchObject({ code: 'GH_MISSING' })
    const out = githubRest(async () => ({ stdout: '' }))
    await expect(out.get('/repos/acme/app/issues', null)).rejects.toMatchObject({ code: 'GH_SIGNED_OUT' })
  })
})

describe('reads with their ETags kept (GitHubReads)', () => {
  /** GitHub answering each path with its body, and a 304 to its own ETag. */
  const answering = (bodies: Record<string, unknown>): GitHubGet => async (path, etag) => {
    const tag = `"${JSON.stringify(bodies[path])}"`
    return etag === tag ? { status: 304, etag, body: null, resetAt: null } : { status: 200, etag: tag, body: bodies[path], resetAt: null }
  }

  it('answers a feed\'s 304 with nothing new, and a list\'s or an object\'s 304 with its last answer', async () => {
    const reads = new GitHubReads(answering({ '/repos/acme/app/issues?since=x': [{ id: 1 }], '/repos/acme/app/pulls?state=open': [{ id: 2 }],
      '/repos/acme/app': { n: 3 } }))
    expect(await reads.changed('acme/app', '/repos/acme/app/issues?since=x')).toEqual([{ id: 1 }])
    expect(await reads.changed('acme/app', '/repos/acme/app/issues?since=x')).toEqual([])
    expect(await reads.current('acme/app', '/repos/acme/app/pulls?state=open')).toEqual([{ id: 2 }])
    expect(await reads.current('acme/app', '/repos/acme/app/pulls?state=open')).toEqual([{ id: 2 }])
    expect(await reads.one('acme/app', '/repos/acme/app')).toEqual({ n: 3 })
    expect(await reads.one('acme/app', '/repos/acme/app')).toEqual({ n: 3 })
  })

  it('stops one repository it cannot read and every repository while gh is signed out', async () => {
    const unreadable = new GitHubReads(async () => ({ status: 404, etag: null, body: null, resetAt: null }))
    await expect(unreadable.current('acme/secret', '/repos/acme/secret/pulls')).rejects.toMatchObject({ code: 'UNREADABLE', everywhere: false })
    const out = new GitHubReads(async () => { throw Object.assign(new Error('signed out'), { code: 'GH_SIGNED_OUT' }) })
    await expect(out.one('acme/app', '/repos/acme/app')).rejects.toMatchObject({ code: 'GH_SIGNED_OUT', everywhere: true })
  })
})
