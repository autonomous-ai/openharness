import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { cacheSecret, GitHubApp, githubAppConfig, GitHubAppError, HARNESS_CO_AUTHOR, PULL_READ_PERMISSIONS, PUSH_ORIGIN_PERMISSIONS, readPrivateKey,
  TOKEN_PERMISSIONS } from './app.js'
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

  it('says so, with the installation and why, each time the grant cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { app, github, time } = setup()
      await app.createToken(77, repo)
      expect(warn).toHaveBeenCalledWith("[github] installation 77's permissions unreadable (HTTP 404); agent tokens ask for today's set alone")
      time.advance(60_001)
      github.control.down = true
      await expect(app.createToken(77, repo)).rejects.toMatchObject({ code: 'GITHUB_UNAVAILABLE' })
      expect(warn).toHaveBeenLastCalledWith("[github] installation 77's permissions unreadable (GITHUB_UNAVAILABLE); agent tokens ask for today's set alone")
      expect(warn.mock.calls.flat().join(' ')).not.toContain('ghs_')
    } finally { warn.mockRestore() }
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
    await app.createToken(77, repo, PUSH_ORIGIN_PERMISSIONS)
    expect(minted(github).map(b => (b as { permissions: unknown }).permissions)).toEqual([PULL_READ_PERMISSIONS, PUSH_ORIGIN_PERMISSIONS])
    expect(github.calls.filter(c => c.path === '/app/installations/77')).toHaveLength(0)
  })

  it('leaves the install link out when no app name is configured', async () => {
    const { app } = setup({ slug: null })
    expect(app.installUrl()).toBeNull()
    expect(app.notInstalled(repo).details).toBeUndefined()
    expect(app.notInstalled(repo).message).toBe('The Harness GitHub App is not installed on acme/app. Ask an owner of acme to install it.')
  })

  // Dee, task #2136: a commit reads as Claude's line does.
  it('names Harness by Autonomous as its co-author', () => {
    expect(HARNESS_CO_AUTHOR).toBe('Co-authored-by: Harness by Autonomous <noreply@autonomous.ai>')
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

  it('never talks to the real GitHub in these tests', () => {
    expect(FAKE_API).not.toContain('api.github.com')
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

describe('what installation tokens may never carry (task #1788)', () => {
  it('installation tokens never ask for administration or repository creation', async () => {
    const app = await import('./app.js')
    const sets = Object.entries(app).filter(([name]) => name.endsWith('_PERMISSIONS')) as Array<[string, Record<string, string>]>
    expect(sets.map(([name]) => name)).toEqual(expect.arrayContaining(['TOKEN_PERMISSIONS', 'GRANTED_TOKEN_PERMISSIONS', 'PULL_READ_PERMISSIONS']))
    for (const [, permissions] of sets) {
      for (const never of app.NEVER_ON_INSTALLATION_TOKENS) expect(Object.keys(permissions)).not.toContain(never)
    }
    const { github, app: gh } = setup()
    github.installed.set('acme/app', 91)
    for (const never of app.NEVER_ON_INSTALLATION_TOKENS) {
      await expect(gh.createToken(91, repo, { [never]: 'write', metadata: 'read' })).rejects.toMatchObject({ code: 'GITHUB_APP_PERMISSIONS_FORBIDDEN' })
    }
    expect(github.calls.some(c => c.path.endsWith('/access_tokens'))).toBe(false)
  })
})

describe('whether an organization lets Harness create repositories (task #1788)', () => {
  it('says whether an organization lets Harness create repositories', async () => {
    const { app, github, time } = setup()
    expect(await app.ownerReadiness('acme')).toEqual({ state: 'not-installed', installUrl: 'https://github.com/apps/harness-fixture/installations/new' })
    expect(github.calls.map(c => c.path)).toEqual(['/orgs/acme/installation'])
    github.owners.set('acme', 91)
    time.advance(60_001)
    github.grants.set(91, { contents: 'write', metadata: 'read' })
    expect(await app.ownerReadiness('acme')).toEqual({ state: 'not-accepted' })
    time.advance(10 * 60_000 + 1)
    github.grants.set(91, { contents: 'write', metadata: 'read', repository_creation: 'write' })
    expect(await app.ownerReadiness('acme')).toEqual({ state: 'ready', installation: 91, canAdd: false })
    time.advance(10 * 60_000 + 1)
    github.grants.set(91, { repository_creation: 'write', installation_repositories: 'write' })
    expect(await app.ownerReadiness('Acme')).toEqual({ state: 'ready', installation: 91, canAdd: true })
    const asked = github.calls.length
    expect(await app.ownerReadiness('ACME')).toEqual({ state: 'ready', installation: 91, canAdd: true })
    expect(github.calls).toHaveLength(asked)
  })
})
