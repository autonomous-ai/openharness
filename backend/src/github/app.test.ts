import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ACTIONS_READ_PERMISSIONS, CI_LOAD_TTL_MS, CI_MAX_CALLS, CI_MAX_RUNS, CI_READS_PER_HOUR, CI_STALE_MS, SERVER_PROCESSES_MAX, cacheSecret, githubAppConfig, GitHubAppError, PULL_READ_PERMISSIONS, PULL_WATCH_PERMISSIONS, readPrivateKey, TOKEN_PERMISSIONS } from './app.js'
import { FAKE_API, fakeApp, fakeGitHub, throwawayKey } from './fakeGitHub.js'
import { githubRepository } from './repository.js'
import { GitHubApp, HARNESS_CO_AUTHOR } from './app.js'

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

  // Scholes, task #2755 (Ken approved): an agent's token also pushes workflow files and writes issues, where the
  // installation has granted them. Asking for one it has not granted would refuse every token on it.
  const today = { contents: 'write', pull_requests: 'write', checks: 'read', actions: 'read', metadata: 'read' } as const
  const minted = (github: ReturnType<typeof fakeGitHub>) => github.calls.filter(c => c.path.endsWith('/access_tokens')).map(c => c.body)

  it('asks for workflows and issues on an agent\'s token, for its one repository, where the installation granted them', async () => {
    const { app, github } = setup()
    github.grants.set(77, { ...today, workflows: 'write', issues: 'write' })
    expect((await app.createToken(77, repo)).token).toBe('ghs_fixture_1')
    expect(minted(github)).toEqual([{ repositories: ['app'], permissions: { ...today, workflows: 'write', issues: 'write' } }])
    expect(github.calls.filter(c => c.path === '/app/installations/77')).toHaveLength(1)
  })

  it('asks for no more than each granted level, and only what is granted', async () => {
    const { app, github } = setup()
    github.grants.set(77, { ...today, issues: 'read', administration: 'write' })
    await app.createToken(77, repo)
    expect(minted(github)).toEqual([{ repositories: ['app'], permissions: { ...today, issues: 'read' } }])
  })

  it('asks for today\'s set where workflows and issues are not granted, and still gets its token', async () => {
    const { app, github } = setup()
    github.grants.set(77, { ...today })
    expect((await app.createToken(77, repo)).token).toBe('ghs_fixture_1')
    expect(minted(github)).toEqual([{ repositories: ['app'], permissions: today }])
  })

  it('asks for today\'s set when GitHub does not say what the installation granted', async () => {
    const { app, github } = setup()
    // The fake answers 404 for an installation it lists no grants for.
    expect((await app.createToken(77, repo)).token).toBe('ghs_fixture_1')
    expect(minted(github)).toEqual([{ repositories: ['app'], permissions: today }])
  })

  it('remembers an installation\'s grant ten minutes', async () => {
    const { app, github, time } = setup()
    github.grants.set(77, { ...today, workflows: 'write' })
    await app.createToken(77, repo)
    await app.createToken(77, repo)
    expect(github.calls.filter(c => c.path === '/app/installations/77')).toHaveLength(1)
    github.grants.set(77, { ...today, workflows: 'write', issues: 'write' })
    time.advance(10 * 60_000 + 1)
    await app.createToken(77, repo)
    expect(github.calls.filter(c => c.path === '/app/installations/77')).toHaveLength(2)
    expect(minted(github).at(-1)).toEqual({ repositories: ['app'], permissions: { ...today, workflows: 'write', issues: 'write' } })
  })

  it('reads the grant again after a permission refusal, and asks once more with what is granted now', async () => {
    const { app, github } = setup()
    github.grants.set(77, { ...today, workflows: 'write', issues: 'write' })
    await app.createToken(77, repo)
    // An owner takes workflows away inside the ten minutes: the remembered grant is wrong.
    github.grants.set(77, { ...today, issues: 'write' })
    expect((await app.createToken(77, repo)).token).toBe('ghs_fixture_2')
    expect(minted(github).slice(1)).toEqual([
      { repositories: ['app'], permissions: { ...today, workflows: 'write', issues: 'write' } },
      { repositories: ['app'], permissions: { ...today, issues: 'write' } }])
    expect(github.calls.filter(c => c.path === '/app/installations/77')).toHaveLength(2)
    // The fresh grant is remembered.
    await app.createToken(77, repo)
    expect(github.calls.filter(c => c.path === '/app/installations/77')).toHaveLength(2)
  })

  it('still refuses, asking once, when even today\'s set is not granted and the fresh grant changes nothing', async () => {
    const { app, github } = setup()
    github.grants.set(77, { contents: 'read', metadata: 'read' })
    await expect(app.createToken(77, repo)).rejects.toMatchObject({ code: 'GITHUB_APP_PERMISSIONS', status: 409 })
    expect(minted(github)).toHaveLength(1)
    expect(github.calls.filter(c => c.path === '/app/installations/77')).toHaveLength(2)
  })

  it('never widens a narrow token, whatever the installation granted', async () => {
    const { app, github } = setup()
    github.grants.set(77, { ...today, workflows: 'write', issues: 'write' })
    await app.createToken(77, repo, PULL_READ_PERMISSIONS)
    await app.createToken(77, repo, PULL_WATCH_PERMISSIONS)
    await app.createToken(77, repo, ACTIONS_READ_PERMISSIONS)
    expect(minted(github).map(b => (b as { permissions: unknown }).permissions)).toEqual([PULL_READ_PERMISSIONS, PULL_WATCH_PERMISSIONS, ACTIONS_READ_PERMISSIONS])
    expect(github.calls.filter(c => c.path === '/app/installations/77')).toHaveLength(0)
  })

  it('leaves the install link out when no app name is configured', async () => {
    const { app } = setup({ slug: null })
    expect(app.installUrl()).toBeNull()
    expect(app.notInstalled(repo).details).toBeUndefined()
    expect(app.notInstalled(repo).message).toBe('The Harness GitHub App is not installed on acme/app. Ask an owner of acme to install it.')
  })

  // Dee, task #2136: a commit reads as Claude's line does, and asks GitHub nothing.
  it('names Harness by Autonomous as its commit identity, with no call to GitHub', () => {
    const { app, github } = setup()
    expect(app.commitIdentity()).toEqual({ name: 'Harness by Autonomous', email: 'noreply@autonomous.ai' })
    expect(HARNESS_CO_AUTHOR).toBe('Co-authored-by: Harness by Autonomous <noreply@autonomous.ai>')
    expect(github.calls).toEqual([])
  })

  // A wrong name asks the log for a bot that never pushed: an empty answer that would read as clean (review 1 of #2600).
  it('takes its bot login from GitHub\'s answer, never its configured name, once, and says null while GitHub cannot say', async () => {
    const { app, github } = setup({ slug: 'a-wrong-name' })
    expect(await app.botLogin()).toBe('harness-fixture[bot]')
    expect(await app.botLogin()).toBe('harness-fixture[bot]')
    expect(github.calls.map(c => c.path)).toEqual(['/app'])
    const down = setup({ slug: 'harness-fixture' })
    down.github.control.down = true
    expect(await down.app.botLogin()).toBeNull()
    down.github.control.down = false
    expect(await down.app.botLogin()).toBe('harness-fixture[bot]')
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

  // #2602: another repository's number read here is no pull request of this one, and must not hold its task open forever.
  it('answers missing for a pull request GitHub does not know in that repository', async () => {
    const { app } = setup()
    const { token } = await app.createToken(77, repo, PULL_READ_PERMISSIONS)
    expect(await app.pullRequestState(repo, 9, token)).toBe('missing')
  })

  it('answers null, never a guess, when GitHub cannot say', async () => {
    const { app, github } = setup()
    const { token } = await app.createToken(77, repo, PULL_READ_PERMISSIONS)
    github.pulls.set('acme/app#9', { state: 'open', merged_at: null })
    github.control.pullsStatus = 502
    expect(await app.pullRequestState(repo, 9, token)).toBeNull()
    github.control.pullsStatus = 200
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
    // Per server process: every pod production may run, reading its full budget, stays about 5% of the installation's 5,000.
    expect(CI_MAX_CALLS * CI_READS_PER_HOUR * SERVER_PROCESSES_MAX).toBeLessThanOrEqual(5000 * 0.05)
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
  it('a read that fails after a newer one took its place leaves the newer one cached', async () => {
    const { github, time } = busy()
    let failFirst: (() => void) | undefined
    const fetch = github.fetch
    let held = true
    github.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      // The first read's run list waits, then GitHub fails it.
      if (held && url.pathname.endsWith('/actions/runs') && url.searchParams.get('status') === 'in_progress') {
        held = false
        await new Promise<void>(resolve => { failFirst = resolve })
        return new Response('{}', { status: 500 })
      }
      return fetch(input, init)
    }) as typeof globalThis.fetch
    const app = fakeApp(key.privateKey, github, { now: time.now })
    const slow = app.ciLoad(repo).catch(error => error)
    await new Promise(resolve => setTimeout(resolve, 10))
    time.advance(CI_LOAD_TTL_MS)
    const newer = await app.ciLoad(repo)
    failFirst!()
    expect(await slow).toMatchObject({ code: 'GITHUB_UNAVAILABLE' })
    await new Promise(resolve => setTimeout(resolve, 0))
    // The newer read is still the cached one: asking again reads nothing from GitHub.
    const tokens = github.calls.filter(c => c.path.endsWith('/access_tokens')).length
    expect(await app.ciLoad(repo)).toEqual(newer)
    expect(github.calls.filter(c => c.path.endsWith('/access_tokens')).length).toBe(tokens)
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

describe('who pushed a pull request, through the app', () => {
  const head = 'head-sha'
  const fixture = (first = { after: head, actor: { login: 'ken', type: 'User' }, timestamp: '2026-11-02T08:00:00Z' }) => {
    const { privateKey, publicKey } = throwawayKey()
    let now = Date.parse('2026-11-02T09:00:00Z')
    const github = fakeGitHub({ publicKey, appId: '7', now: () => now })
    github.installed.set('acme/app', 1)
    const paths: string[] = []
    let activity: 'answer' | 'fail' = 'answer'
    const sha = head
    const fetch: typeof github.fetch = async (input, init) => {
      const url = new URL(String(input))
      if (!/\/repos\/acme\/app\/pulls|\/activity$/.test(url.pathname)) return github.fetch(input, init)
      paths.push(url.pathname + url.search)
      const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers })
      if (url.pathname.endsWith('/commits')) return json([{ sha: head, commit: { author: { email: 'k@example.com' }, committer: { email: 'k@example.com' } } }])
      if (url.pathname.endsWith('/activity')) {
        if (activity === 'fail') return new Response('{}', { status: 502 })
        if (url.searchParams.get('actor')) return json([])
        return url.searchParams.get('after') ? json([first]) : json([], { link: `<https://api.github.com/repositories/1/activity?ref=fix&per_page=100&after=abc>; rel="next"` })
      }
      return json({ head: { sha, ref: 'fix', repo: { full_name: 'acme/app' } }, created_at: '2026-11-02T07:00:00Z' })
    }
    const app = new GitHubApp({ appId: '7', privateKey, slug: 'harness-fixture' }, { fetch, apiUrl: FAKE_API, now: () => now })
    return { app, paths, fail: (down: boolean) => { activity = down ? 'fail' : 'answer' }, pass: (ms: number) => { now += ms } }
  }
  const repository = githubRepository('https://github.com/acme/app')!

  it('asks for its own bot by login, follows the log\'s next link, and reads the pull request once, so a push in between files nothing under another commit', async () => {
    const f = fixture()
    expect(await f.app.pushOrigin(repository, 7)).toBe('clean')
    expect(f.paths.filter(p => /\/pulls\/7$/.test(p))).toHaveLength(1)
    expect(f.paths.some(p => p.includes(`actor=${encodeURIComponent('harness-fixture[bot]')}`))).toBe(true)
    expect(f.paths.some(p => p.includes('after=abc'))).toBe(true)
  })

  it('keeps an answer for a head, and asks again after a minute when GitHub could not say', async () => {
    const f = fixture()
    f.fail(true)
    expect(await f.app.pushOrigin(repository, 7)).toBe('unknown')
    const logReads = () => f.paths.filter(p => p.includes('/activity')).length, once = logReads()
    expect(await f.app.pushOrigin(repository, 7)).toBe('unknown')
    expect(logReads()).toBe(once)
    f.pass(61_000)
    f.fail(false)
    expect(await f.app.pushOrigin(repository, 7)).toBe('clean')
    expect(logReads()).toBeGreaterThan(once)
    const settled = logReads()
    f.pass(3_600_000)
    expect(await f.app.pushOrigin(repository, 7)).toBe('clean')
    expect(logReads()).toBe(settled)
  })
})

// Dee, #1891: a task's pull request is watched for its Engineer (superTabs/pullRequestEvents.ts), with what the app holds.
describe('watching a pull request', () => {
  const HEAD = 'abc1234def5678'
  const seed = (github: ReturnType<typeof fakeGitHub>) => {
    github.pulls.set('acme/app#12', { state: 'open', merged_at: null, draft: false, head: { sha: HEAD }, base: { ref: 'main' }, mergeable: false,
      html_url: 'https://github.com/acme/app/pull/12' })
    github.checkRuns.set(`acme/app@${HEAD}`, [{ name: 'build', status: 'completed', conclusion: 'failure', completed_at: '2026-10-24T11:59:00Z' },
      { name: 'lint', status: 'in_progress', conclusion: null, completed_at: null }])
    github.checkSuites.set(`acme/app@${HEAD}`, [{ status: 'in_progress', latest_check_runs_count: 2 }])
    github.reviews.set('acme/app#12', [{ id: 7, user: { login: 'huy' }, author_association: 'MEMBER', state: 'CHANGES_REQUESTED', body: 'Keep the arrow.', html_url: 'https://github.com/acme/app/pull/12#pullrequestreview-7' }])
    github.comments.set('acme/app#12', [{ id: 9, user: { login: 'dee' }, author_association: 'NONE', body: 'Looks good', html_url: 'https://github.com/acme/app/pull/12#issuecomment-9' }])
  }

  it('reads the pull, its head\'s check runs and suites, its reviews and comments, with a read-only token', async () => {
    const { app, github } = setup()
    const { token } = await app.createToken(77, repo, PULL_WATCH_PERMISSIONS)
    expect(github.calls.at(-1)!.body).toMatchObject({ permissions: { pull_requests: 'read', checks: 'read', metadata: 'read' } })
    expect(Object.keys(PULL_WATCH_PERMISSIONS).sort()).toEqual(['checks', 'metadata', 'pull_requests'])
    for (const name of Object.keys(PULL_WATCH_PERMISSIONS)) expect(TOKEN_PERMISSIONS[name as keyof typeof TOKEN_PERMISSIONS]).toBeDefined()
    seed(github)
    expect(await app.watchPullRequest(repo, 12, token)).toEqual({ url: 'https://github.com/acme/app/pull/12', number: 12, state: 'open', draft: false,
      head: HEAD, base: 'main', mergeable: false,
      checkRuns: [{ name: 'build', status: 'completed', conclusion: 'failure', completedAt: Date.parse('2026-10-24T11:59:00Z') },
        { name: 'lint', status: 'in_progress', conclusion: null, completedAt: null }],
      checkSuites: [{ status: 'in_progress', runs: 2 }],
      reviews: [{ id: 7, login: 'huy', association: 'MEMBER', state: 'CHANGES_REQUESTED', body: 'Keep the arrow.', url: 'https://github.com/acme/app/pull/12#pullrequestreview-7' }],
      comments: [{ id: 9, login: 'dee', association: 'NONE', body: 'Looks good', url: 'https://github.com/acme/app/pull/12#issuecomment-9' }] })
    expect(github.calls.slice(-5).map(c => c.path)).toEqual(['/repos/acme/app/pulls/12', `/repos/acme/app/commits/${HEAD}/check-runs`,
      `/repos/acme/app/commits/${HEAD}/check-suites`, '/repos/acme/app/pulls/12/reviews', '/repos/acme/app/issues/12/comments'])
  })

  it('asks again with If-None-Match and reuses the body of a 304', async () => {
    const { app, github } = setup()
    const { token } = await app.createToken(77, repo, PULL_WATCH_PERMISSIONS)
    seed(github)
    const first = await app.watchPullRequest(repo, 12, token)
    const again = await app.watchPullRequest(repo, 12, token)
    expect(again).toEqual(first)
    expect(github.calls.slice(-5).every(c => c.ifNoneMatch)).toBe(true)
    github.comments.set('acme/app#12', [])
    expect((await app.watchPullRequest(repo, 12, token))!.comments).toEqual([])
  })

  // Review of #2750, Important 2: GitHub lists reviews and comments oldest first, so the newest are on the last page.
  it('reads the newest reviews and comments from the last page', async () => {
    const { app, github } = setup()
    const { token } = await app.createToken(77, repo, PULL_WATCH_PERMISSIONS)
    seed(github)
    github.comments.set('acme/app#12', Array.from({ length: 250 }, (_, i) => ({ id: i + 1, user: { login: 'dee' }, author_association: 'MEMBER', body: `note ${i + 1}`,
      html_url: `https://github.com/acme/app/pull/12#issuecomment-${i + 1}` })))
    const ids = (await app.watchPullRequest(repo, 12, token))!.comments.map(c => c.id)
    expect(ids).toContain(250)
    expect(ids).toContain(201)
    // A new comment shows on the next read, even though the first page is unchanged.
    github.comments.get('acme/app#12')!.push({ id: 251, user: { login: 'dee' }, author_association: 'MEMBER', body: 'note 251', html_url: 'x' })
    expect((await app.watchPullRequest(repo, 12, token))!.comments.map(c => c.id)).toContain(251)
  })

  it('answers null when GitHub cannot say', async () => {
    const { app, github } = setup()
    const { token } = await app.createToken(77, repo, PULL_WATCH_PERMISSIONS)
    expect(await app.watchPullRequest(repo, 12, token)).toBeNull()
    seed(github)
    github.control.down = true
    expect(await app.watchPullRequest(repo, 12, token)).toBeNull()
  })
})
