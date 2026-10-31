import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ACTIONS_READ_PERMISSIONS, CI_LOAD_TTL_MS, CI_MAX_CALLS, CI_MAX_RUNS, CI_READS_PER_HOUR, CI_STALE_MS, cacheSecret, githubAppConfig, GitHubAppError, PULL_READ_PERMISSIONS, readPrivateKey, TOKEN_PERMISSIONS } from './app.js'
import { FAKE_API, fakeApp, fakeGitHub, throwawayKey } from './fakeGitHub.js'
import { githubRepository } from './repository.js'

const key = throwawayKey()
const repo = githubRepository('https://github.com/acme/app')!
const clock = () => { let t = Date.parse('2026-10-24T12:00:00Z'); return { now: () => t, advance: (ms: number) => { t += ms } } }
const setup = (options: { slug?: string | null } = {}) => {
  const time = clock()
  const github = fakeGitHub({ publicKey: key.publicKey, appId: '424242', now: time.now })
  return { time, github, app: fakeApp(key.privateKey, github, { now: time.now, ...options }) }
}
const env = (id: string, privateKey: string, slug = '') => ({ GITHUB_APP_ID: id, GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_APP_SLUG: slug })

describe('GitHub App configuration', () => {
  it('is off with nothing set and refuses half a configuration', () => {
    expect(githubAppConfig(env('', ''))).toBeNull()
    expect(githubAppConfig(env(' ', '\n'))).toBeNull()
    expect(() => githubAppConfig(env('424242', ''))).toThrow('Set both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY')
    expect(() => githubAppConfig(env('', key.pem))).toThrow('Set both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY')
    expect(() => githubAppConfig(env('my app', key.pem))).toThrow('numeric App ID or its Client ID')
    expect(() => githubAppConfig(env('424242', key.pem, 'Not A Slug'))).toThrow('github.com/apps/NAME')
  })

  it('reads the key as a PEM file, with escaped line breaks, or as base64, and takes a Client ID', () => {
    const escaped = key.pem.trim().replace(/\n/g, '\\n')
    for (const value of [key.pem, escaped, Buffer.from(key.pem).toString('base64')]) {
      const config = githubAppConfig(env('424242', value, 'harness-fixture'))!
      expect(config.privateKey.asymmetricKeyType).toBe('rsa')
      expect(config.slug).toBe('harness-fixture')
    }
    expect(githubAppConfig(env('Iv23liFixture0001', key.pem))!.appId).toBe('Iv23liFixture0001')
  })

  it('refuses a key it cannot use without repeating the value', () => {
    const secret = 'not-a-key-secret-material'
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const broken = key.pem.replace(/[A-Za-z]{20}/, 'secretsecretsecretse')
    for (const [value, message] of [[secret, /not a PEM private key/], [ec, /RSA key/], [broken, /could not be read/],
      [Buffer.from(secret).toString('base64'), /not a PEM private key/]] as const) {
      let error: unknown
      try { readPrivateKey(value) } catch (thrown) { error = thrown }
      expect((error as Error).message).toMatch(message)
      expect((error as Error).message).not.toContain('secret')
    }
  })

  it('derives a 32-byte cache key from the private key and app id', () => {
    const config = githubAppConfig(env('424242', key.pem))!
    expect(cacheSecret(config)).toHaveLength(32)
    expect(cacheSecret(config).equals(cacheSecret({ ...config, appId: '1' }))).toBe(false)
  })
})

describe('the app JWT', () => {
  it('is RS256, issued by the app a minute back, valid at most ten minutes, and reused until a minute before it ends', () => {
    const { app, time } = setup()
    const jwt = app.jwt()
    const [header, payload, signature] = jwt.split('.') as [string, string, string]
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
    const seconds = Math.floor(time.now() / 1000)
    expect(claims).toEqual({ iat: seconds - 60, exp: seconds + 540, iss: '424242' })
    expect(verify('sha256', Buffer.from(`${header}.${payload}`), createPublicKey(key.privateKey), Buffer.from(signature, 'base64url'))).toBe(true)
    time.advance(7 * 60_000)
    expect(app.jwt()).toBe(jwt)
    time.advance(60_000)
    expect(app.jwt()).not.toBe(jwt)
  })
})

describe('installation lookup', () => {
  it('finds the installation with the app JWT and remembers it for ten minutes', async () => {
    const { app, github, time } = setup()
    github.installed.set('acme/app', 77)
    expect(await app.installation(repo)).toBe(77)
    expect(github.calls[0]).toMatchObject({ method: 'GET', path: '/repos/acme/app/installation' })
    expect(github.calls[0]!.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    expect(await app.installation(repo)).toBe(77)
    expect(github.calls).toHaveLength(1)
    time.advance(10 * 60_000 + 1)
    expect(await app.installation(repo)).toBe(77)
    expect(github.calls).toHaveLength(2)
  })

  it('remembers a missing installation for one minute only', async () => {
    const { app, github, time } = setup()
    expect(await app.installation(repo)).toBeNull()
    github.installed.set('acme/app', 78)
    expect(await app.installation(repo)).toBeNull()
    time.advance(60_001)
    expect(await app.installation(repo)).toBe(78)
  })

  it('says the credentials are wrong when GitHub refuses the JWT, and that GitHub is away when it does not answer', async () => {
    const time = clock()
    const other = throwawayKey()
    const github = fakeGitHub({ publicKey: other.publicKey, appId: '424242', now: time.now })
    const app = fakeApp(key.privateKey, github, { now: time.now })
    await expect(app.installation(repo)).rejects.toMatchObject({ code: 'GITHUB_APP_MISCONFIGURED', status: 503 })
    github.control.down = true
    await expect(app.installation(repo)).rejects.toMatchObject({ code: 'GITHUB_UNAVAILABLE', status: 503 })
  })

  it('treats an answer without an id as GitHub being unavailable', async () => {
    const app = fakeApp(key.privateKey, { fetch: (async () => new Response('{}', { status: 200 })) as typeof fetch } as never)
    await expect(app.installation(repo)).rejects.toMatchObject({ code: 'GITHUB_UNAVAILABLE', status: 502 })
  })
})

describe('installation tokens', () => {
  it('asks for exactly the one repository and the minimum permissions', async () => {
    const { app, github } = setup()
    const minted = await app.createToken(77, repo)
    expect(minted.token).toBe('ghs_fixture_1')
    expect(Date.parse(minted.expiresAt)).toBeGreaterThan(Date.parse('2026-10-24T12:59:00Z'))
    const call = github.calls.at(-1)!
    expect(call).toMatchObject({ method: 'POST', path: '/app/installations/77/access_tokens' })
    expect(call.body).toEqual({ repositories: ['app'],
      permissions: { contents: 'write', pull_requests: 'write', checks: 'read', actions: 'read', metadata: 'read' } })
    expect(TOKEN_PERMISSIONS).toEqual((call.body as { permissions: unknown }).permissions)
  })

  it('names a repository the installation does not cover as not installed, with the install link, and a missing permission apart', async () => {
    const { app, github } = setup()
    github.installed.set('acme/app', 77)
    await app.installation(repo)
    github.control.tokenStatus = 422
    github.control.tokenMessage = 'There is at least one repository that does not exist or is not accessible to the parent installation.'
    const refusal = await app.createToken(77, repo).then(() => { throw new Error('expected a refusal') }, (error: unknown) => error as GitHubAppError)
    expect(refusal).toMatchObject({ code: 'GITHUB_APP_NOT_INSTALLED', status: 409,
      details: { installUrl: 'https://github.com/apps/harness-fixture/installations/new' } })
    expect(refusal.message).toContain('acme/app')
    // The installation is looked up again next time.
    const calls = github.calls.length
    await app.installation(repo)
    expect(github.calls.length).toBe(calls + 1)
    github.control.tokenMessage = 'The permissions requested are not granted to this installation.'
    await expect(app.createToken(77, repo)).rejects.toMatchObject({ code: 'GITHUB_APP_PERMISSIONS', status: 409 })
    github.control.tokenStatus = 500
    await expect(app.createToken(77, repo)).rejects.toMatchObject({ code: 'GITHUB_UNAVAILABLE', status: 502 })
  })

  it('leaves the install link out when no app name is configured', async () => {
    const { app } = setup({ slug: null })
    expect(app.installUrl()).toBeNull()
    expect(app.notInstalled(repo).details).toBeUndefined()
    expect(app.notInstalled(repo).message).toBe('The Harness GitHub App is not installed on acme/app. Ask an owner of acme to install it.')
  })

  // A Harness Team account's commits are the app's (PR #1934): its bot account, as GitHub names it.
  it('names the app\'s bot account as its commit identity, reading the bot\'s id once', async () => {
    const { app, github } = setup()
    expect(await app.commitIdentity()).toEqual({ name: 'harness-fixture[bot]', email: '4242+harness-fixture[bot]@users.noreply.github.com' })
    expect(await app.commitIdentity()).toEqual({ name: 'harness-fixture[bot]', email: '4242+harness-fixture[bot]@users.noreply.github.com' })
    const asked = github.calls.filter(c => c.path.startsWith('/users/'))
    expect(asked).toEqual([expect.objectContaining({ method: 'GET', path: '/users/harness-fixture%5Bbot%5D', auth: '' })])
    // With no app name configured, the app's own answer names it.
    // With a token, asked with it: unsigned requests from a server's shared address can be refused (PR #1948).
    const signed = setup()
    await signed.app.commitIdentity('ghs_issued')
    expect(signed.github.calls.find(c => c.path.startsWith('/users/'))?.auth).toBe('Bearer ghs_issued')
    const unnamed = setup({ slug: null })
    expect(await unnamed.app.commitIdentity()).toMatchObject({ name: 'harness-fixture[bot]' })
    expect(unnamed.github.calls.map(c => c.path)).toEqual(['/app', '/users/harness-fixture%5Bbot%5D'])
  })

  it('has no commit identity while GitHub cannot say, and asks again ten minutes later', async () => {
    const { app, github, time } = setup()
    github.control.botId = null
    expect(await app.commitIdentity()).toBeNull()
    github.control.botId = 4242
    expect(await app.commitIdentity()).toBeNull()
    time.advance(10 * 60_000)
    github.control.down = true
    expect(await app.commitIdentity()).toBeNull()
    github.control.down = false
    time.advance(10 * 60_000)
    expect(await app.commitIdentity()).toMatchObject({ email: '4242+harness-fixture[bot]@users.noreply.github.com' })
  })

  it('revokes a token with the token itself, takes one already ended as done, and reports any other failure', async () => {
    const { app, github } = setup()
    const { token } = await app.createToken(77, repo)
    await app.revoke(token)
    expect(github.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/installation/token', auth: `Bearer ${token}` })
    expect(github.revoked).toEqual([token])
    await app.revoke(token)
    const second = await app.createToken(77, repo)
    github.control.revokeStatus = 500
    await expect(app.revoke(second.token)).rejects.toMatchObject({ code: 'GITHUB_UNAVAILABLE' })
  })
})

describe('default branch protection', () => {
  it('reads a ruleset that requires a pull request with the agent token', async () => {
    const { app, github } = setup()
    const { token } = await app.createToken(77, repo)
    github.protection.set('acme/app', { rules: [{ type: 'deletion' }, { type: 'pull_request', parameters: {} }] })
    expect(await app.defaultBranch(repo, token)).toEqual({ branch: 'main', protection: 'pull_request' })
    expect(github.calls.slice(-2).map(c => c.path)).toEqual(['/repos/acme/app', '/repos/acme/app/rules/branches/main'])
    expect(github.calls.slice(-2).every(c => c.auth === `Bearer ${token}`)).toBe(true)
  })

  it('falls back to classic protection, which it cannot read further, or none, and remembers the answer ten minutes', async () => {
    const { app, github, time } = setup()
    const { token } = await app.createToken(77, repo)
    github.protection.set('acme/app', { branch: 'trunk', protected: true })
    expect(await app.defaultBranch(repo, token)).toEqual({ branch: 'trunk', protection: 'classic' })
    github.protection.set('acme/app', { branch: 'trunk', protected: false })
    expect(await app.defaultBranch(repo, token)).toEqual({ branch: 'trunk', protection: 'classic' })
    time.advance(10 * 60_000 + 1)
    expect(await app.defaultBranch(repo, token)).toEqual({ branch: 'trunk', protection: 'none' })
  })

  it('answers unknown, and asks again next time, when GitHub cannot say', async () => {
    const { app, github } = setup()
    const { token } = await app.createToken(77, repo)
    github.protection.set('acme/app', { fail: true })
    expect(await app.defaultBranch(repo, token)).toEqual({ branch: null, protection: 'unknown' })
    github.control.down = true
    expect(await app.defaultBranch(repo, token)).toEqual({ branch: null, protection: 'unknown' })
    github.control.down = false
    github.protection.set('acme/app', {})
    expect(await app.defaultBranch(repo, token)).toEqual({ branch: 'main', protection: 'none' })
  })

  it('reads whether a pull request is open, merged or closed, with a token for its repository alone', async () => {
    const { app, github } = setup()
    const { token } = await app.createToken(77, repo, PULL_READ_PERMISSIONS)
    expect(github.calls.at(-1)!.body).toMatchObject({ repositories: ['app'], permissions: { pull_requests: 'read', metadata: 'read' } })
    github.pulls.set('acme/app#1', { state: 'open', merged_at: null })
    github.pulls.set('acme/app#2', { state: 'closed', merged_at: '2026-10-27T08:00:00Z' })
    github.pulls.set('acme/app#3', { state: 'closed', merged_at: null })
    expect(await app.pullRequestState(repo, 1, token)).toBe('open')
    expect(await app.pullRequestState(repo, 2, token)).toBe('merged')
    expect(await app.pullRequestState(repo, 3, token)).toBe('closed')
    expect(github.calls.at(-1)).toMatchObject({ method: 'GET', path: '/repos/acme/app/pulls/3', auth: `Bearer ${token}` })
  })

  it('answers null, never a guess, when GitHub cannot say', async () => {
    const { app, github } = setup()
    const { token } = await app.createToken(77, repo, PULL_READ_PERMISSIONS)
    expect(await app.pullRequestState(repo, 9, token)).toBeNull()
    github.pulls.set('acme/app#9', { state: 'open', merged_at: null })
    expect(await app.pullRequestState(repo, 9, 'ghs_not_issued')).toBeNull()
    github.control.down = true
    expect(await app.pullRequestState(repo, 9, token)).toBeNull()
  })

  it('never talks to the real GitHub in these tests', () => {
    expect(FAKE_API).not.toContain('api.github.com')
  })
})

describe('the CI load', () => {
  const job = (status: string, ...labels: string[]) => ({ status, labels: labels.length ? labels : ['ubuntu-latest'] })
  const busy = () => {
    const env = setup()
    env.github.installed.set('acme/app', 77)
    env.github.actions.set('acme/app', [
      { id: 1, status: 'in_progress', jobs: [job('in_progress'), job('in_progress', 'macos-15'), job('completed'), job('queued', 'macos-15')] },
      { id: 2, status: 'queued', jobs: [job('waiting'), job('pending'), job('requested'), job('queued', 'self-hosted', 'macOS', 'arm64')] },
      { id: 3, status: 'completed', jobs: [job('in_progress')] },
    ])
    return env
  }
  it('counts the running and waiting jobs, in all and on macOS, of runs in progress or queued', async () => {
    const { app } = busy()
    expect(await app.ciLoad(repo)).toEqual({ running: 2, queued: 5, macosRunning: 1, macosQueued: 2 })
  })
  it('reads with a token that only reads workflow runs, for that repository alone, revoked at once', async () => {
    const { app, github } = busy()
    await app.ciLoad(repo)
    const minted = github.calls.filter(c => c.path.endsWith('/access_tokens'))
    expect(minted).toHaveLength(1)
    expect(minted[0]!.body).toEqual({ repositories: ['app'], permissions: ACTIONS_READ_PERMISSIONS })
    expect(ACTIONS_READ_PERMISSIONS).toEqual({ actions: 'read', metadata: 'read' })
    expect(github.revoked).toHaveLength(1)
    expect(github.issued.size).toBe(0)
  })
  it('keeps a load for its time, routes asking at once share one read, and a later route reads again', async () => {
    const { app, github, time } = busy()
    const [x, y] = await Promise.all([app.ciLoad(repo), app.ciLoad(repo)])
    expect(x).toEqual(y)
    await app.ciLoad(githubRepository('https://github.com/ACME/App')!)
    const runReads = () => github.calls.filter(c => c.path.endsWith('/actions/runs')).length
    expect(runReads()).toBe(2)
    time.advance(CI_LOAD_TTL_MS)
    github.actions.set('acme/app', [])
    expect(await app.ciLoad(repo)).toEqual({ running: 0, queued: 0, macosRunning: 0, macosQueued: 0 })
    expect(runReads()).toBe(4)
  })
  it('reads at most its limit of runs, and counts every run beyond it as one waiting job', async () => {
    const { app, github } = busy()
    github.actions.set('acme/app', [...Array.from({ length: 30 }, (_, i) => ({ id: i + 1, status: 'in_progress', jobs: [job('in_progress')] })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: 100 + i, status: 'queued', jobs: [job('queued', 'macos-15')] }))])
    expect(await app.ciLoad(repo)).toEqual({ running: CI_MAX_RUNS, queued: 34 - CI_MAX_RUNS, macosRunning: 0, macosQueued: 0 })
    expect(github.calls.filter(c => c.path.endsWith('/jobs'))).toHaveLength(CI_MAX_RUNS)
  })
  // Lead, 10-31: a read's GitHub calls are counted and capped.
  it('makes at most its limit of GitHub calls in one read, from the token to its revoke', async () => {
    const { app, github } = busy()
    github.actions.set('acme/app', Array.from({ length: 40 }, (_, i) => ({ id: i + 1, status: i % 2 ? 'queued' : 'in_progress', jobs: [job('in_progress')] })))
    await app.ciLoad(repo)
    const first = github.calls.findIndex(c => c.path.endsWith('/access_tokens'))
    const read = github.calls.slice(first)
    expect(read.at(-1)).toMatchObject({ method: 'DELETE', path: '/installation/token' })
    expect(read.length).toBeLessThanOrEqual(CI_MAX_CALLS)
    expect(CI_MAX_CALLS * CI_READS_PER_HOUR).toBeLessThanOrEqual(5000 * 0.05)
  })
  it('reads one repository at most its hourly number of times, then answers the last load for a few minutes, then none', async () => {
    const { app, github, time } = busy()
    for (let i = 0; i < CI_READS_PER_HOUR; i++) { await app.ciLoad(repo); time.advance(CI_LOAD_TTL_MS) }
    const reads = () => github.calls.filter(c => c.path.endsWith('/access_tokens')).length
    expect(reads()).toBe(CI_READS_PER_HOUR)
    github.actions.set('acme/app', [])
    // Spent: the last load read, while it is recent, and no call to GitHub.
    expect(await app.ciLoad(repo)).toMatchObject({ running: 2 })
    expect(reads()).toBe(CI_READS_PER_HOUR)
    time.advance(CI_STALE_MS)
    await expect(app.ciLoad(repo)).rejects.toMatchObject({ code: 'GITHUB_CI_BUDGET', status: 429 })
    expect(reads()).toBe(CI_READS_PER_HOUR)
    // An hour after the first read, reads come back.
    time.advance(3_600_000 - CI_READS_PER_HOUR * CI_LOAD_TTL_MS - CI_STALE_MS)
    expect(await app.ciLoad(repo)).toEqual({ running: 0, queued: 0, macosRunning: 0, macosQueued: 0 })
    expect(reads()).toBe(CI_READS_PER_HOUR + 1)
  })
  it('reads the same run listed under both statuses once', async () => {
    const { github, time } = busy()
    github.actions.set('acme/app', [{ id: 9, status: 'in_progress', jobs: [job('in_progress')] }])
    const fetch = github.fetch
    let second = false
    // A run that moved from queued to in progress between the two reads is listed by both.
    github.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/actions/runs') && url.searchParams.get('status') === 'queued') return new Response(JSON.stringify({ total_count: 1, workflow_runs: [{ id: 9 }, { id: 'x' }, null] }), { status: 200 })
      // An answer without its list or count reads as none.
      if (url.pathname.endsWith('/actions/runs') && url.searchParams.get('status') === 'in_progress' && second) return new Response('{}', { status: 200 })
      return fetch(input, init)
    }) as typeof globalThis.fetch
    const twice = fakeApp(key.privateKey, github, { now: time.now })
    expect(await twice.ciLoad(repo)).toEqual({ running: 1, queued: 0, macosRunning: 0, macosQueued: 0 })
    second = true
    time.advance(CI_LOAD_TTL_MS)
    expect(await twice.ciLoad(repo)).toEqual({ running: 1, queued: 0, macosRunning: 0, macosQueued: 0 })
  })
  it('is null where the app is not installed, minting nothing', async () => {
    const { app, github } = setup()
    expect(await app.ciLoad(repo)).toBeNull()
    expect(github.calls.some(c => c.path.endsWith('/access_tokens'))).toBe(false)
  })
  it('says GitHub could not say, still revokes the token, and keeps no failed read', async () => {
    for (const fault of ['actionsStatus', 'jobsStatus'] as const) {
      const { app, github } = busy()
      github.control[fault] = 500
      await expect(app.ciLoad(repo)).rejects.toMatchObject({ code: 'GITHUB_UNAVAILABLE', status: 502 })
      expect(github.revoked).toHaveLength(1)
      github.control[fault] = 200
      expect(await app.ciLoad(repo)).toMatchObject({ running: 2 })
    }
  })
  it('a token GitHub would not revoke is said without the token, and the counts still come back', async () => {
    const { app, github } = busy()
    github.control.revokeStatus = 500
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await app.ciLoad(repo)).toMatchObject({ running: 2 })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).not.toContain('ghs_')
    } finally { warn.mockRestore() }
  })
  it('leaves the expired loads of many repositories behind', async () => {
    const { app, github, time } = busy()
    for (let i = 0; i < 199; i++) await app.ciLoad(githubRepository(`https://github.com/acme/r${i}`)!)
    // Past the hour too, so their read counts go as well.
    time.advance(3_600_000)
    await app.ciLoad(repo)
    github.installed.set('acme/fresh', 78)
    expect(await app.ciLoad(githubRepository('https://github.com/acme/fresh')!)).toEqual({ running: 0, queued: 0, macosRunning: 0, macosQueued: 0 })
    // The fresh one stays beside the new one; the 199 expired ones are gone.
    expect([...(app as unknown as { ciLoads: Map<string, unknown> }).ciLoads.keys()]).toEqual(['acme/app', 'acme/fresh'])
    expect([...(app as unknown as { ciReads: Map<string, unknown> }).ciReads.keys()]).toEqual(['acme/app', 'acme/fresh'])
  })
})
