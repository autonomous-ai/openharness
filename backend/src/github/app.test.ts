import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { githubAppConfig, GitHubAppError, PULL_PATCH_PERMISSIONS, PULL_READ_PERMISSIONS, PULL_WATCH_PERMISSIONS, readPrivateKey } from './app.js'
import { FAKE_API, fakeApp, fakeGitHub, throwawayKey } from './fakeGitHub.js'
import { githubRepository } from './repository.js'
import { GitHubApp } from './app.js'

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
  it('asks for exactly the one repository and the permissions it is given', async () => {
    const { app, github } = setup()
    const minted = await app.createToken(77, repo, PULL_READ_PERMISSIONS)
    expect(minted.token).toBe('ghs_fixture_1')
    expect(Date.parse(minted.expiresAt)).toBeGreaterThan(Date.parse('2026-10-24T12:59:00Z'))
    const call = github.calls.at(-1)!
    expect(call).toMatchObject({ method: 'POST', path: '/app/installations/77/access_tokens' })
    expect(call.body).toEqual({ repositories: ['app'], permissions: PULL_READ_PERMISSIONS })
  })

  it('names a repository the installation does not cover as not installed, with the install link, and a missing permission apart', async () => {
    const { app, github } = setup()
    github.installed.set('acme/app', 77)
    await app.installation(repo)
    github.control.tokenStatus = 422
    github.control.tokenMessage = 'There is at least one repository that does not exist or is not accessible to the parent installation.'
    const refusal = await app.createToken(77, repo, PULL_READ_PERMISSIONS).then(() => { throw new Error('expected a refusal') }, (error: unknown) => error as GitHubAppError)
    expect(refusal).toMatchObject({ code: 'GITHUB_APP_NOT_INSTALLED', status: 409,
      details: { installUrl: 'https://github.com/apps/harness-fixture/installations/new' } })
    expect(refusal.message).toContain('acme/app')
    // The installation is looked up again next time.
    const calls = github.calls.length
    await app.installation(repo)
    expect(github.calls.length).toBe(calls + 1)
    github.control.tokenMessage = 'The permissions requested are not granted to this installation.'
    await expect(app.createToken(77, repo, PULL_READ_PERMISSIONS)).rejects.toMatchObject({ code: 'GITHUB_APP_PERMISSIONS', status: 409 })
    github.control.tokenStatus = 500
    await expect(app.createToken(77, repo, PULL_READ_PERMISSIONS)).rejects.toMatchObject({ code: 'GITHUB_UNAVAILABLE', status: 502 })
  })

  const minted = (github: ReturnType<typeof fakeGitHub>) => github.calls.filter(c => c.path.endsWith('/access_tokens')).map(c => c.body)

  it('never widens a narrow token, whatever the installation granted', async () => {
    const { app, github } = setup()
    github.grants.set(77, { contents: 'write', pull_requests: 'write', checks: 'read', metadata: 'read', workflows: 'write', issues: 'write' })
    await app.createToken(77, repo, PULL_READ_PERMISSIONS)
    await app.createToken(77, repo, PULL_WATCH_PERMISSIONS)
    expect(minted(github).map(b => (b as { permissions: unknown }).permissions)).toEqual([PULL_READ_PERMISSIONS, PULL_WATCH_PERMISSIONS])
    expect(github.calls.filter(c => c.path === '/app/installations/77')).toHaveLength(0)
  })

  it('leaves the install link out when no app name is configured', async () => {
    const { app } = setup({ slug: null })
    expect(app.installUrl()).toBeNull()
    expect(app.notInstalled(repo).details).toBeUndefined()
    expect(app.notInstalled(repo).message).toBe('The Harness GitHub App is not installed on acme/app. Ask an owner of acme to install it.')
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
    const { token } = await app.createToken(77, repo, PULL_READ_PERMISSIONS)
    await app.revoke(token)
    expect(github.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/installation/token', auth: `Bearer ${token}` })
    expect(github.revoked).toEqual([token])
    await app.revoke(token)
    const second = await app.createToken(77, repo, PULL_READ_PERMISSIONS)
    github.control.revokeStatus = 500
    await expect(app.revoke(second.token)).rejects.toMatchObject({ code: 'GITHUB_UNAVAILABLE' })
  })
})

describe('reading a pull request\'s state', () => {
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

// Task #3401: a task's Ready reads the files its pull request changes, and the server opens its review steps from them.
describe('listing a pull request\'s files', () => {
  it('lists every changed file across pages, a renamed file under both names, with the watch\'s read-only token', async () => {
    const { app, github } = setup()
    const { token } = await app.createToken(77, repo, PULL_WATCH_PERMISSIONS)
    github.files.set('acme/app#12', [...Array.from({ length: 150 }, (_, i) => ({ filename: `src/f${i}.ts`, status: 'modified' })),
      { filename: 'src/session.ts', status: 'renamed', previous_filename: 'src/auth.ts' }])
    const listed = await app.pullRequestFiles(repo, 12, token)
    expect(listed).toHaveLength(152)
    expect(listed!.map(f => f.filename)).toEqual(expect.arrayContaining(['src/f0.ts', 'src/f149.ts', 'src/session.ts', 'src/auth.ts']))
    expect(github.calls.filter(c => c.path === '/repos/acme/app/pulls/12/files')).toHaveLength(2)
  })

  it('says it cannot tell when GitHub fails, and when the list may stop at GitHub\'s 3,000 files', async () => {
    const { app, github } = setup()
    const { token } = await app.createToken(77, repo, PULL_WATCH_PERMISSIONS)
    github.files.set('acme/app#12', Array.from({ length: 3000 }, (_, i) => ({ filename: `src/f${i}.ts`, status: 'modified' })))
    expect(await app.pullRequestFiles(repo, 12, token)).toBeNull()
    github.files.set('acme/app#12', [{ filename: 'a.ts', status: 'added' }])
    github.control.pullsStatus = 500
    expect(await app.pullRequestFiles(repo, 12, token)).toBeNull()
  })
})

// Dee, #1891: a task's pull request is watched for its Engineer (superTabs/pullRequestEvents.ts), with what the app holds.
describe('watching a pull request', () => {
  const HEAD = 'abc1234def5678'
  const seed = (github: ReturnType<typeof fakeGitHub>) => {
    github.pulls.set('acme/app#12', { state: 'open', merged_at: null, draft: false, head: { sha: HEAD }, base: { ref: 'main', sha: 'base000' }, mergeable: false,
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

  // Review of #3218 (Ledger, round 3), Important 3: listed files, removed ones above all, cannot be tied to a head (a push and a
  // push back between reads). A head's patch is read from the comparison of the base and head commits the pull request named
  // in one answer: two fixed commits, which no push changes.
  it('reads a head\'s files from the comparison of the base and head it named, with a contents-read token', async () => {
    const { app, github } = setup()
    expect(PULL_PATCH_PERMISSIONS).toEqual({ contents: 'read', pull_requests: 'read', metadata: 'read' })
    const { token } = await app.createToken(77, repo, PULL_PATCH_PERMISSIONS)
    const head = 'd7b66b0167e16c82bd73fbc61645e691742fa10e', base = 'd908300eaf1e6f81a2ec6c8076acca81857954ae'
    github.pulls.set('acme/app#12', { state: 'open', merged_at: null, draft: false, head: { sha: head }, base: { ref: 'main', sha: base }, mergeable: true,
      html_url: 'https://github.com/acme/app/pull/12' })
    github.compares.set(`acme/app@${base}...${head}`, [
      { filename: 'a.ts', status: 'modified', sha: 's', patch: '@@ -1 +1 @@\n-a\n+b' },
      { filename: 'backend/src/superTabs/pmFooting.ts', status: 'removed', sha: 'c436dc29cf000d6376014bc78faa3fb77d3555bf', patch: '@@ -1 +0,0 @@\n-x' }])
    // The base branch the comparison was against comes with the files (security review of #3218, round 3).
    expect(await app.pullRequestPatchFiles(repo, 12, token, head)).toEqual({ base: 'main', files: [
      { filename: 'a.ts', status: 'modified', sha: 's', patch: '@@ -1 +1 @@\n-a\n+b' },
      { filename: 'backend/src/superTabs/pmFooting.ts', status: 'removed', sha: 'c436dc29cf000d6376014bc78faa3fb77d3555bf', patch: '@@ -1 +0,0 @@\n-x' }] })
    expect(github.calls.slice(-2).map(c => c.path)).toEqual(['/repos/acme/app/pulls/12', `/repos/acme/app/compare/${base}...${head}`])
  })

  it('reads no files for a head the pull request no longer names, a comparison GitHub cannot give, or one at its file cap', async () => {
    const { app, github } = setup()
    const { token } = await app.createToken(77, repo, PULL_PATCH_PERMISSIONS)
    const head = 'a'.repeat(40), base = 'b'.repeat(40)
    github.pulls.set('acme/app#12', { state: 'open', merged_at: null, draft: false, head: { sha: head }, base: { ref: 'main', sha: base }, mergeable: true,
      html_url: 'https://github.com/acme/app/pull/12' })
    expect(await app.pullRequestPatchFiles(repo, 12, token, head)).toBeNull()
    github.compares.set(`acme/app@${base}...${head}`, [{ filename: 'a.ts', status: 'modified', sha: 's', patch: '@@ -1 +1 @@\n-a\n+b' }])
    expect(await app.pullRequestPatchFiles(repo, 12, token, 'c'.repeat(40))).toBeNull()
    expect((await app.pullRequestPatchFiles(repo, 12, token, head))?.files).toHaveLength(1)
    github.compares.set(`acme/app@${base}...${head}`, Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts`, status: 'added', sha: `s${i}` })))
    expect(await app.pullRequestPatchFiles(repo, 12, token, head)).toBeNull()
  })

  // Task #3553: what a new head is of the pull request, to judge whether it is git's own merge of its reviewed head and main
  // (superTabs/mergeCarry.ts): its parents, whether the second is on the branch it merges into, and the three comparisons.
  it('reads a merge head\'s parents and the three sides of the merge, at the head the pull request names', async () => {
    const { app, github } = setup()
    const { token } = await app.createToken(77, repo, PULL_PATCH_PERMISSIONS)
    const M = 'd'.repeat(40), H = 'a'.repeat(40), B = 'b'.repeat(40)
    // The base's tip as the pull request names it: the second parent is checked against this commit, never the branch name,
    // which a tag of the same name could shadow (security review of #3284, Important 1).
    const TIP = 'e'.repeat(40)
    github.pulls.set('acme/app#12', { state: 'open', merged_at: null, draft: false, head: { sha: M }, base: { ref: 'main', sha: TIP }, mergeable: true,
      html_url: 'https://github.com/acme/app/pull/12' })
    github.commits.set(`acme/app@${M}`, [H, B])
    github.compares.set(`acme/app@${B}...${TIP}`, [])
    github.compareStatus.set(`acme/app@${B}...${TIP}`, 'identical')
    github.compares.set(`acme/app@${H}...${B}`, [{ filename: 'lib.ts', status: 'modified', sha: 'm2' }])
    github.compares.set(`acme/app@${B}...${H}`, [{ filename: 'app.ts', status: 'modified', sha: 'p1' }])
    github.compares.set(`acme/app@${H}...${M}`, [{ filename: 'lib.ts', status: 'modified', sha: 'm2' }])
    expect(await app.mainMergeSides(repo, 12, token, M)).toEqual({ base: 'main', sides: { parents: [H, B], onBase: true,
      prSide: [{ filename: 'app.ts', status: 'modified', sha: 'p1' }], mainSide: [{ filename: 'lib.ts', status: 'modified', sha: 'm2' }],
      mergeSide: [{ filename: 'lib.ts', status: 'modified', sha: 'm2' }] } })
    expect(github.calls.map(c => c.path)).toContain(`/repos/acme/app/compare/${B}...${TIP}`)
    expect(github.calls.map(c => c.path).filter(path => path.includes('...main'))).toEqual([])
    // Its second parent behind the tip is on it; one the tip never had is not.
    github.compareStatus.set(`acme/app@${B}...${TIP}`, 'ahead')
    expect((await app.mainMergeSides(repo, 12, token, M))?.sides.onBase).toBe(true)
    github.compareStatus.set(`acme/app@${B}...${TIP}`, 'diverged')
    expect((await app.mainMergeSides(repo, 12, token, M))?.sides.onBase).toBe(false)
  })

  it('reads no merge for a head the pull request no longer names, a commit that is no merge, or a side at its file cap', async () => {
    const { app, github } = setup()
    const { token } = await app.createToken(77, repo, PULL_PATCH_PERMISSIONS)
    const M = 'd'.repeat(40), H = 'a'.repeat(40), B = 'b'.repeat(40)
    github.pulls.set('acme/app#12', { state: 'open', merged_at: null, draft: false, head: { sha: M }, base: { ref: 'main', sha: B }, mergeable: true,
      html_url: 'https://github.com/acme/app/pull/12' })
    expect(await app.mainMergeSides(repo, 12, token, 'c'.repeat(40))).toBeNull()
    // One parent: no comparison is read, and the sides say it is no merge.
    github.commits.set(`acme/app@${M}`, [H])
    expect(await app.mainMergeSides(repo, 12, token, M)).toEqual({ base: 'main', sides: { parents: [H], onBase: false, prSide: [], mainSide: [], mergeSide: [] } })
    github.commits.set(`acme/app@${M}`, [H, B])
    github.compares.set(`acme/app@${B}...${B}`, [])
    github.compares.set(`acme/app@${H}...${B}`, Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts`, status: 'added', sha: `s${i}` })))
    github.compares.set(`acme/app@${B}...${H}`, [])
    github.compares.set(`acme/app@${H}...${M}`, [])
    expect(await app.mainMergeSides(repo, 12, token, M)).toBeNull()
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

describe('what installation tokens may never carry (task #1788)', () => {
  it('installation tokens never ask for administration or repository creation', async () => {
    const app = await import('./app.js')
    const sets = Object.entries(app).filter(([name]) => name.endsWith('_PERMISSIONS')) as Array<[string, Record<string, string>]>
    expect(sets.map(([name]) => name)).toEqual(expect.arrayContaining(['PULL_READ_PERMISSIONS', 'PULL_WATCH_PERMISSIONS', 'PUSH_ORIGIN_PERMISSIONS']))
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
