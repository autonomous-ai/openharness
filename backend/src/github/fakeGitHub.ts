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

/** One fake GitHub: which repositories have the app (`installed`, by `owner/name`, lower case), and every request it was
 *  sent. A request whose JWT is not signed by [publicKey] is answered 401. */
export function fakeGitHub(options: { publicKey: KeyObject; appId: string; now?: () => number }) {
  const now = options.now ?? Date.now
  const installed = new Map<string, number>()
  /** The app's installation on an owner (`owner`, lower case), and repositories renamed (old `owner/name` → new), lower case. */
  const owners = new Map<string, number>()
  const renamed = new Map<string, string>()
  /** Pull requests by `owner/name#number`, lower case: GitHub's state and when it was merged, and what a watch reads. */
  const pulls = new Map<string, { state: 'open' | 'closed'; merged_at: string | null; draft?: boolean; head?: { sha: string }; base?: { ref: string; sha?: string };
    mergeable?: boolean | null; html_url?: string }>()
  /** A head's latest check runs and its check suites, by `owner/name@sha`, lower case. */
  const checkRuns = new Map<string, Array<{ name: string; status: string; conclusion: string | null; completed_at: string | null }>>()
  const checkSuites = new Map<string, Array<{ status: string; latest_check_runs_count: number }>>()
  /** A pull request's reviews and conversation comments, by `owner/name#number`, lower case. */
  const reviews = new Map<string, Array<{ id: number; user: { login: string }; author_association?: string; state: string; body: string; html_url: string }>>()
  const comments = new Map<string, Array<{ id: number; user: { login: string }; author_association?: string; body: string; html_url: string }>>()
  /** The files of a comparison, by `owner/name@BASE...HEAD`, lower case: GET /compare/{base}...{head}. */
  const compares = new Map<string, Array<{ filename: string; status: string; sha: string; patch?: string; previous_filename?: string }>>()
  /** A comparison's status, by the same key, when not 'ahead' (task #3553: whether a commit is on a branch). */
  const compareStatus = new Map<string, string>()
  /** Each commit's parents, by `owner/name@SHA`, lower case: GET /git/commits/{sha} (task #3553). */
  const commits = new Map<string, string[]>()
  /** A pull request's changed files, by `owner/name#number`, lower case, as GET /pulls/{n}/files lists them (task #3401). */
  const files = new Map<string, Array<{ filename: string; status: string; previous_filename?: string }>>()
  /** Each installation's accepted permissions, by installation id, as GET /app/installations/{id} answers them. An
   *  installation listed here refuses a token that asks for more, as GitHub does; one not listed answers 404 and mints any. */
  const grants = new Map<number, Record<string, 'read' | 'write'>>()
  const calls: FakeCall[] = []
  const issued = new Set<string>()
  const revoked: string[] = []
  let minted = 0
  const control = { revokeStatus: 204, tokenStatus: 201 as number, tokenMessage: '', down: false, botId: 4242 as number | null, pullsStatus: 200 }
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
    if (method === 'GET' && (match = /^\/app\/installations\/(\d+)$/.exec(url.pathname))) {
      if (!jwtValid(auth)) return json(401, { message: 'Bad credentials' })
      const granted = grants.get(Number(match[1]))
      return granted ? json(200, { id: Number(match[1]), permissions: granted }) : json(404, { message: 'Not Found' })
    }
    if (method === 'POST' && (match = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname))) {
      if (!jwtValid(auth)) return json(401, { message: 'Bad credentials' })
      if (control.tokenStatus !== 201) return json(control.tokenStatus, { message: control.tokenMessage })
      const granted = grants.get(Number(match[1]))
      const asked = ((body as { permissions?: Record<string, string> }).permissions) ?? {}
      if (granted && Object.entries(asked).some(([name, level]) => !granted[name] || (level === 'write' && granted[name] !== 'write'))) {
        return json(422, { message: 'The permissions requested are not granted to this installation.' })
      }
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
      const branch = 'main'
      // A renamed repository: GitHub redirects its old name to its id, and fetch follows, so the body names it as it is now.
      if (!repoPath[3]) return json(200, { full_name: renamed.get(`${repoPath[1]}/${repoPath[2]}`.toLowerCase()) ?? `${repoPath[1]}/${repoPath[2]}`, default_branch: branch })
      // As GitHub does: each answer carries an ETag, and a request naming the current one is answered 304 with no body.
      const tagged = (value: unknown) => {
        const etag = `"${createHash('sha1').update(JSON.stringify(value)).digest('hex')}"`
        if (ifNoneMatch === etag) return new Response(null, { status: 304, headers: { etag } })
        return new Response(JSON.stringify(value), { status: 200, headers: { etag } })
      }
      const repoKey = `${repoPath[1]}/${repoPath[2]}`.toLowerCase()
      const pull = /^\/pulls\/(\d+)$/.exec(repoPath[3] ?? '')
      if (pull) {
        if (control.pullsStatus !== 200) return json(control.pullsStatus, { message: 'Server Error' })
        const known = pulls.get(`${repoKey}#${pull[1]}`)
        return known ? tagged({ number: Number(pull[1]), ...known }) : json(404, { message: 'Not Found' })
      }
      const head = /^\/commits\/([0-9a-f]+)\/(check-runs|check-suites)$/.exec(repoPath[3] ?? '')
      if (head) {
        const key = `${repoKey}@${head[1]}`
        return head[2] === 'check-runs' ? tagged({ total_count: checkRuns.get(key)?.length ?? 0, check_runs: checkRuns.get(key) ?? [] })
          : tagged({ total_count: checkSuites.get(key)?.length ?? 0, check_suites: checkSuites.get(key) ?? [] })
      }
      const compared = /^\/compare\/([0-9A-Za-z._-]+)\.\.\.([0-9A-Za-z._-]+)$/.exec(repoPath[3] ?? '')
      if (compared) {
        const key = `${repoKey}@${compared[1]}...${compared[2]}`
        const listed = compares.get(key)
        return listed ? json(200, { status: compareStatus.get(key) ?? 'ahead', files: listed }) : json(404, { message: 'Not Found' })
      }
      const commit = /^\/git\/commits\/([0-9a-f]{40})$/.exec(repoPath[3] ?? '')
      if (commit) {
        const parents = commits.get(`${repoKey}@${commit[1]}`)
        return parents ? json(200, { sha: commit[1], parents: parents.map(sha => ({ sha })) }) : json(404, { message: 'Not Found' })
      }
      const changed = /^\/pulls\/(\d+)\/files$/.exec(repoPath[3] ?? '')
      if (changed) {
        if (control.pullsStatus !== 200) return json(control.pullsStatus, { message: 'Server Error' })
        const all = files.get(`${repoKey}#${changed[1]}`) ?? []
        const size = Number(url.searchParams.get('per_page') ?? 30), page = Number(url.searchParams.get('page') ?? 1)
        return json(200, all.slice((page - 1) * size, page * size))
      }
      const talk = /^\/(pulls|issues)\/(\d+)\/(reviews|comments)$/.exec(repoPath[3] ?? '')
      if (talk) {
        // Oldest first, a page at a time, with a Link to the last page as GitHub sends it.
        const all: unknown[] = (talk[3] === 'reviews' ? reviews : comments).get(`${repoKey}#${talk[2]}`) ?? []
        const size = Number(url.searchParams.get('per_page') ?? 30), page = Number(url.searchParams.get('page') ?? 1), last = Math.max(1, Math.ceil(all.length / size))
        const answer = tagged(all.slice((page - 1) * size, page * size))
        if (last > 1) answer.headers.set('link', `<${FAKE_API}${url.pathname}?per_page=${size}&page=${last}>; rel="last"`)
        return answer
      }
    }
    return json(404, { message: 'Not Found' })
  }) as typeof globalThis.fetch
  return { fetch, calls, grants, installed, owners, renamed, pulls, checkRuns, checkSuites, reviews, comments, files, compares, compareStatus, commits, revoked, issued, control, permissions }
}

/** A configured app talking to [github]. */
export function fakeApp(key: KeyObject, github: ReturnType<typeof fakeGitHub>, options: { appId?: string; slug?: string | null; now?: () => number } = {}) {
  const config: GitHubAppConfig = { appId: options.appId ?? '424242', privateKey: key, slug: options.slug === undefined ? 'harness-fixture' : options.slug }
  return new GitHubApp(config, { fetch: github.fetch, apiUrl: FAKE_API, now: options.now })
}
