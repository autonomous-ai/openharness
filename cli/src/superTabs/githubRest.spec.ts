import { describe, expect, it, vi } from 'vitest'
import { currentNames, GitHubReads, githubRest, NAME_KEPT_MS, retryIn, waitWords, type GitHubGet } from './githubRest.js'

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

  it('asks outright what is large and asked for once, and keeps nothing of it', async () => {
    const path = '/repos/acme/app/commits/abc/check-runs', body = { check_runs: [{ id: 1 }] }, etags: Array<string | null> = []
    const get = answering({ [path]: body })
    const reads = new GitHubReads(async (asked, etag) => { etags.push(etag); return get(asked, etag) })
    expect(await reads.fresh('acme/app', path)).toEqual(body)
    // Nothing was kept of it: the same address read as an object is asked with no ETag.
    expect(await reads.one('acme/app', path)).toEqual(body)
    // And what that read kept is not offered: the answer is the body, never a 304's nothing.
    expect(await reads.fresh('acme/app', path)).toEqual(body)
    expect(etags).toEqual([null, null, null])
  })

  it('stops one repository it cannot read and every repository while gh is signed out', async () => {
    const unreadable = new GitHubReads(async () => ({ status: 404, etag: null, body: null, resetAt: null }))
    await expect(unreadable.current('acme/secret', '/repos/acme/secret/pulls')).rejects.toMatchObject({ code: 'UNREADABLE', everywhere: false })
    const out = new GitHubReads(async () => { throw Object.assign(new Error('signed out'), { code: 'GH_SIGNED_OUT' }) })
    await expect(out.one('acme/app', '/repos/acme/app')).rejects.toMatchObject({ code: 'GH_SIGNED_OUT', everywhere: true })
  })
})

describe('a file of a repository (GitHubReads.file)', () => {
  it('reads a file as text, again by its ETag, and a missing file as nothing without stopping its repository', async () => {
    let now = 0
    const asked: string[] = []
    const get: GitHubGet = async (path, etag) => {
      asked.push(path)
      if (path.endsWith('/Pip.md')) return etag === '"p"' ? { status: 304, etag: '"p"', body: null, resetAt: null }
        : { status: 200, etag: '"p"', body: { encoding: 'base64', content: Buffer.from('Works on: mobile\n').toString('base64') }, resetAt: null }
      if (path === '/repos/acme/app/issues?state=open') return { status: 200, etag: null, body: [{ number: 1 }], resetAt: null }
      return { status: 404, etag: null, body: null, resetAt: null }
    }
    const reads = new GitHubReads(get, () => now)
    expect(await reads.file('acme/app', 'agents/Pip.md')).toBe('Works on: mobile\n')
    expect(await reads.file('acme/app', 'agents/Pip.md')).toBe('Works on: mobile\n')
    expect(await reads.file('acme/app', 'agents/First builder.md')).toBeNull()
    expect(asked.at(-1)).toBe('/repos/acme/app/contents/agents/First%20builder.md')
    // The repository still reads.
    expect(await reads.current('acme/app', '/repos/acme/app/issues?state=open', 1)).toEqual([{ number: 1 }])
    // A missing file is not asked for again for five minutes.
    const before = asked.length
    expect(await reads.file('acme/app', 'agents/First builder.md')).toBeNull()
    expect(asked.length).toBe(before)
    now += 5 * 60_000
    await reads.file('acme/app', 'agents/First builder.md')
    expect(asked.length).toBe(before + 1)
  })
})

// autonomous-harness, renamed openharness (2026-11-11): GitHub answers a repository's old name with what it is called now.
describe('what GitHub names a repository now (currentNames)', () => {
  it('reads it from GitHub, keeps it an hour, and gives the name asked when GitHub does not say, asking again the next time', async () => {
    let clock = 0
    const answers: Array<Awaited<ReturnType<GitHubGet>> | Error> = [{ status: 200, etag: null, body: { full_name: 'Acme/App' }, resetAt: null },
      { status: 200, etag: null, body: { full_name: 'acme/app2' }, resetAt: null }, { status: 404, etag: null, body: null, resetAt: null },
      new Error('gh is not signed in.'), { status: 200, etag: null, body: {}, resetAt: null }]
    const get = vi.fn<GitHubGet>(async () => { const next = answers.shift()!; if (next instanceof Error) throw next; return next })
    const current = currentNames(get, () => clock)
    expect(await current('acme/old')).toBe('acme/app')
    expect(get).toHaveBeenCalledExactlyOnceWith('/repos/acme/old', null)
    expect(await current('acme/old')).toBe('acme/app')
    clock += NAME_KEPT_MS
    expect(await current('acme/old')).toBe('acme/app2')
    for (const repo of ['b/one', 'b/one', 'b/one']) expect(await current(repo)).toBe(repo)
    expect(get).toHaveBeenCalledTimes(5)
    // By this computer's clock when given none.
    const fresh = currentNames(async () => ({ status: 200, etag: null, body: { full_name: 'c/new' }, resetAt: null }))
    expect(await fresh('c/old')).toBe('c/new')
  })
})

describe('how long a failing GitHub or server is left alone', () => {
  it('waits 30 seconds, doubling to 15 minutes, and says the wait in words', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(retryIn)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000])
    expect([0, 400, 30_000, 59_700, 90_000, 120_000, 900_000].map(waitWords)).toEqual(['1 s', '1 s', '30 s', '60 s', '2 min', '2 min', '15 min'])
  })
})
