/**
 * Tests only: a fake GitHub REST API for the Harness GitHub App, and a throwaway RSA key. Nothing here reaches github.com.
 */
import { createHash, createPublicKey, generateKeyPairSync, verify, type KeyObject } from 'node:crypto'
import { GitHubApp, type GitHubAppConfig } from './app.js'

export const FAKE_API = 'https://github.fake.test'

export function throwawayKey(): { privateKey: KeyObject; pem: string; publicKey: KeyObject } {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { privateKey, pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: createPublicKey(privateKey) }
}

export interface FakeCall { method: string; path: string; auth: string; body: unknown; ifNoneMatch?: string }

/** One fake GitHub: which repositories have the app (`installed`, by `owner/name`, lower case), what each default branch's
 *  protection is, and every request it was sent. A request whose JWT is not signed by [publicKey] is answered 401. */
export function fakeGitHub(options: { publicKey: KeyObject; appId: string; now?: () => number }) {
  const now = options.now ?? Date.now
  const installed = new Map<string, number>()
  /** The app's installation on an owner (`owner`, lower case), and repositories renamed (old `owner/name` → new), lower case. */
  const owners = new Map<string, number>()
  const renamed = new Map<string, string>()
  const protection = new Map<string, { rules?: unknown[]; protected?: boolean; branch?: string; fail?: boolean }>()
  /** Pull requests by `owner/name#number`, lower case: GitHub's state and when it was merged, and what a watch reads. */
  const pulls = new Map<string, { state: 'open' | 'closed'; merged_at: string | null; draft?: boolean; head?: { sha: string }; base?: { ref: string };
    mergeable?: boolean | null; html_url?: string }>()
  /** A head's latest check runs and its check suites, by `owner/name@sha`, lower case. */
  const checkRuns = new Map<string, Array<{ name: string; status: string; conclusion: string | null; completed_at: string | null }>>()
  const checkSuites = new Map<string, Array<{ status: string; latest_check_runs_count: number }>>()
  /** A pull request's reviews and conversation comments, by `owner/name#number`, lower case. */
  const reviews = new Map<string, Array<{ id: number; user: { login: string }; state: string; body: string; html_url: string }>>()
  const comments = new Map<string, Array<{ id: number; user: { login: string }; body: string; html_url: string }>>()
  /** Workflow runs by `owner/name`, lower case: each run's status and its jobs' statuses and runner labels. */
  const actions = new Map<string, Array<{ id: number; status: string; jobs: Array<{ status: string; labels: string[] }> }>>()
  const calls: FakeCall[] = []
  const issued = new Set<string>()
  const revoked: string[] = []
  let minted = 0
  const control = { revokeStatus: 204, tokenStatus: 201 as number, tokenMessage: '', down: false, botId: 4242 as number | null, actionsStatus: 200, jobsStatus: 200 }
  /** Each token's permissions, as it was minted. */
  const permissions = new Map<string, unknown>()
  const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status })
  const jwtValid = (auth: string) => {
    const jwt = auth.replace(/^Bearer /, '')
    const [header, payload, signature] = jwt.split('.')
    if (!header || !payload || !signature) return false
    if (!verify('sha256', Buffer.from(`${header}.${payload}`), options.publicKey, Buffer.from(signature, 'base64url'))) return false
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { iat: number; exp: number; iss: string }
    const seconds = Math.floor(now() / 1000)
    return claims.iss === options.appId && claims.iat <= seconds && claims.exp > seconds && claims.exp - claims.iat <= 600
  }
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '')
    const ifNoneMatch = (init?.headers as Record<string, string> | undefined)?.['If-None-Match']
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: url.pathname, auth, body, ...(ifNoneMatch ? { ifNoneMatch } : {}) })
    if (control.down) throw new TypeError('fetch failed')
    let match: RegExpExecArray | null
    if (method === 'GET' && (match = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(url.pathname))) {
      if (!jwtValid(auth)) return json(401, { message: 'Bad credentials' })
      const id = installed.get(`${match[1]}/${match[2]}`.toLowerCase())
      return id === undefined ? json(404, { message: 'Not Found' }) : json(200, { id, account: { login: match[1] } })
    }
    if (method === 'GET' && (match = /^\/(?:orgs|users)\/([^/]+)\/installation$/.exec(url.pathname))) {
      if (!jwtValid(auth)) return json(401, { message: 'Bad credentials' })
      const id = owners.get(match[1]!.toLowerCase())
      return id === undefined ? json(404, { message: 'Not Found' }) : json(200, { id })
    }
    if (method === 'GET' && url.pathname === '/app') {
      if (!jwtValid(auth)) return json(401, { message: 'Bad credentials' })
      return json(200, { slug: 'harness-fixture' })
    }
    if (method === 'GET' && (match = /^\/users\/([^/]+)$/.exec(url.pathname))) {
      const login = decodeURIComponent(match[1]!)
      return control.botId && login.endsWith('[bot]') ? json(200, { login, id: control.botId }) : json(404, { message: 'Not Found' })
    }
    if (method === 'POST' && (match = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname))) {
      if (!jwtValid(auth)) return json(401, { message: 'Bad credentials' })
      if (control.tokenStatus !== 201) return json(control.tokenStatus, { message: control.tokenMessage })
      const token = `ghs_fixture_${++minted}`
      issued.add(token)
      permissions.set(token, (body as { permissions: unknown }).permissions)
      return json(201, { token, expires_at: new Date(now() + 3600_000).toISOString(), permissions: (body as { permissions: unknown }).permissions })
    }
    if (method === 'DELETE' && url.pathname === '/installation/token') {
      const token = auth.replace(/^Bearer /, '')
      if (!issued.has(token)) return json(401, { message: 'Bad credentials' })
      if (control.revokeStatus !== 204) return json(control.revokeStatus, { message: 'Server Error' })
      issued.delete(token)
      revoked.push(token)
      return json(204)
    }
    const repoPath = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (method === 'GET' && repoPath) {
      if (!issued.has(auth.replace(/^Bearer /, ''))) return json(401, { message: 'Bad credentials' })
      const known = protection.get(`${repoPath[1]}/${repoPath[2]}`.toLowerCase()) ?? {}
      if (known.fail) return json(500, { message: 'Server Error' })
      const branch = known.branch ?? 'main'
      // A renamed repository: GitHub redirects its old name to its id, and fetch follows, so the body names it as it is now.
      if (!repoPath[3]) return json(200, { full_name: renamed.get(`${repoPath[1]}/${repoPath[2]}`.toLowerCase()) ?? `${repoPath[1]}/${repoPath[2]}`, default_branch: branch })
      const runs = actions.get(`${repoPath[1]}/${repoPath[2]}`.toLowerCase()) ?? []
      if (repoPath[3] === '/actions/runs') {
        if (control.actionsStatus !== 200) return json(control.actionsStatus, { message: 'Server Error' })
        const matching = runs.filter(r => r.status === url.searchParams.get('status'))
        return json(200, { total_count: matching.length, workflow_runs: matching.slice(0, Number(url.searchParams.get('per_page') ?? 30)).map(r => ({ id: r.id, status: r.status, name: `run ${r.id}`, head_branch: 'secret-branch' })) })
      }
      const jobs = /^\/actions\/runs\/(\d+)\/jobs$/.exec(repoPath[3] ?? '')
      if (jobs) {
        if (control.jobsStatus !== 200) return json(control.jobsStatus, { message: 'Server Error' })
        const run = runs.find(r => r.id === Number(jobs[1]))
        return run ? json(200, { total_count: run.jobs.length, jobs: run.jobs.map((j, i) => ({ id: i, name: `job ${i}`, ...j })) }) : json(404, { message: 'Not Found' })
      }
      // As GitHub does: each answer carries an ETag, and a request naming the current one is answered 304 with no body.
      const tagged = (value: unknown) => {
        const etag = `"${createHash('sha1').update(JSON.stringify(value)).digest('hex')}"`
        if (ifNoneMatch === etag) return new Response(null, { status: 304, headers: { etag } })
        return new Response(JSON.stringify(value), { status: 200, headers: { etag } })
      }
      const repoKey = `${repoPath[1]}/${repoPath[2]}`.toLowerCase()
      const pull = /^\/pulls\/(\d+)$/.exec(repoPath[3] ?? '')
      if (pull) {
        const known = pulls.get(`${repoKey}#${pull[1]}`)
        return known ? tagged({ number: Number(pull[1]), ...known }) : json(404, { message: 'Not Found' })
      }
      const head = /^\/commits\/([0-9a-f]+)\/(check-runs|check-suites)$/.exec(repoPath[3] ?? '')
      if (head) {
        const key = `${repoKey}@${head[1]}`
        return head[2] === 'check-runs' ? tagged({ total_count: checkRuns.get(key)?.length ?? 0, check_runs: checkRuns.get(key) ?? [] })
          : tagged({ total_count: checkSuites.get(key)?.length ?? 0, check_suites: checkSuites.get(key) ?? [] })
      }
      const talk = /^\/(pulls|issues)\/(\d+)\/(reviews|comments)$/.exec(repoPath[3] ?? '')
      if (talk) return tagged((talk[3] === 'reviews' ? reviews : comments).get(`${repoKey}#${talk[2]}`) ?? [])
      if (repoPath[3] === `/rules/branches/${encodeURIComponent(branch)}`) return json(200, known.rules ?? [])
      if (repoPath[3] === `/branches/${encodeURIComponent(branch)}`) return json(200, { name: branch, protected: known.protected ?? false })
    }
    return json(404, { message: 'Not Found' })
  }) as typeof globalThis.fetch
  return { fetch, calls, installed, owners, renamed, protection, pulls, checkRuns, checkSuites, reviews, comments, revoked, issued, control, actions, permissions }
}

/** A configured app talking to [github]. */
export function fakeApp(key: KeyObject, github: ReturnType<typeof fakeGitHub>, options: { appId?: string; slug?: string | null; now?: () => number } = {}) {
  const config: GitHubAppConfig = { appId: options.appId ?? '424242', privateKey: key, slug: options.slug === undefined ? 'harness-fixture' : options.slug }
  return new GitHubApp(config, { fetch: github.fetch, apiUrl: FAKE_API, now: options.now })
}
