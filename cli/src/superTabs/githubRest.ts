/**
 * GitHub's REST API as this computer's own gh login, for the Swarm's reads (githubMentions.ts) and its merges by rule
 * (githubMerge.ts). The token is read from gh, kept in memory only, never logged or written, and read again after GitHub
 * refuses it. Each answer within 10 seconds. A read can carry the ETag of the last answer: an unchanged one is a 304, which
 * GitHub does not count against the rate limit.
 */
import { ghError, ghRun, type Run } from '../lib/github.js'

export interface GitHubReply { status: number; etag: string | null; body: unknown; resetAt: number | null }
export type GitHubGet = (path: string, etag: string | null) => Promise<GitHubReply>
export type GitHubSend = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => Promise<GitHubReply>

export function githubRest(run: Run = ghRun, request: typeof fetch = fetch, now: () => number = Date.now): { get: GitHubGet; send: GitHubSend } {
  let token: string | null = null
  const call = async (method: string, path: string, init: { etag?: string | null; body?: unknown }): Promise<GitHubReply> => {
    if (!token) {
      try { token = (await run(['auth', 'token'])).stdout.trim() || null } catch (error) { throw ghError(error) }
      if (!token) throw ghError({ stderr: 'gh auth login' })
    }
    const response = await request(`https://api.github.com${path}`, { method, signal: AbortSignal.timeout(10_000), headers: {
      Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Harness',
      ...(init.etag ? { 'If-None-Match': init.etag } : {}), ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) })
    if (response.status === 401) token = null
    const reset = Number(response.headers.get('x-ratelimit-reset'))
    const limited = response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
    const json = response.status >= 200 && response.status < 300 && response.status !== 204
    return { status: response.status, etag: response.headers.get('etag'), body: json ? await response.json().catch(() => null) : null,
      resetAt: !limited ? null : Number.isFinite(reset) && reset > 0 ? reset * 1000 : now() + 60_000 }
  }
  return {
    get: (path, etag) => call('GET', path, { etag }),
    send: (method, path, body) => call(method, path, { body }),
  }
}

type Json = Record<string, unknown>
const object = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}

/** A failure that stops a pass for one repository (`everywhere` false) or for all of them, until [until]. */
export class GitHubStop extends Error {
  constructor(readonly code: string, message: string, readonly everywhere: boolean, readonly until: number) { super(message) }
}

/** GitHub's page size: a page shorter than this is the last. */
export const PAGE = 100
const MAX_KEPT = 500
/** How long to wait before asking again: gh missing or signed out, a repository this login cannot read, a rate limit. */
const OFF_RETRY_MS = 5 * 60_000, UNREADABLE_RETRY_MS = 10 * 60_000, LIMIT_MAX_MS = 15 * 60_000
/** How long a file found missing is not asked for again: an agent's instructions file is written rarely, and a 404 is not
 *  free against GitHub's limit as a 304 is. */
const MISSING_MS = 5 * 60_000

/**
 * GitHub reads with each request's last ETag kept, so an unchanged answer is a 304, and each failure named
 * (GitHubStop): gh missing or signed out, a rate limit or no answer stop every repository; a repository this login cannot
 * read stops only that one.
 */
export class GitHubReads {
  private readonly kept = new Map<string, { etag: string; body: unknown }>()
  /** Files found missing, until when they are not asked for again. */
  private readonly missing = new Map<string, number>()
  constructor(private readonly get: GitHubGet, private readonly now: () => number = Date.now) {}

  /** Up to [maxPages] pages of a feed read from a cursor: what is new, so nothing on a 304. */
  async changed(repo: string, path: string, maxPages = 3): Promise<Json[]> {
    return this.pages(repo, path, maxPages, false)
  }

  /** Up to [maxPages] pages of a list as it is now: its last answer again on a 304. */
  async current(repo: string, path: string, maxPages = 3): Promise<Json[]> {
    return this.pages(repo, path, maxPages, true)
  }

  /** One object as it is now: its last answer again on a 304. */
  async one(repo: string, path: string): Promise<Json> {
    const body = await this.read(repo, path, true)
    return object(body)
  }

  /** A file of [repo]'s default branch as text, its last answer again on a 304. Null when it is not there: a missing file
   *  is an answer here, never a repository this login cannot read, and it is not asked again for [MISSING_MS]. */
  async file(repo: string, path: string): Promise<string | null> {
    const url = `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`
    if ((this.missing.get(url) ?? 0) > this.now()) return null
    const body = object(await this.read(repo, url, true, true))
    if (body.missing === true) {
      this.missing.set(url, this.now() + MISSING_MS)
      if (this.missing.size > MAX_KEPT) this.missing.delete(this.missing.keys().next().value!)
      return null
    }
    this.missing.delete(url)
    return typeof body.content === 'string' && body.encoding === 'base64' ? Buffer.from(body.content, 'base64').toString('utf8') : null
  }

  /** Forgets [repo]'s answers: what was read but not acted on is read again, never answered by a 304. */
  forget(repo: string): void {
    for (const url of [...this.kept.keys()]) if (url.startsWith(`/repos/${repo}/`) || url === `/repos/${repo}`) this.kept.delete(url)
    for (const url of [...this.missing.keys()]) if (url.startsWith(`/repos/${repo}/`)) this.missing.delete(url)
  }

  private async pages(repo: string, path: string, maxPages: number, keep: boolean): Promise<Json[]> {
    const rows: Json[] = []
    for (let page = 1; page <= maxPages; page++) {
      const body = await this.read(repo, page === 1 ? path : `${path}&page=${page}`, keep)
      if (body === null) return rows
      if (!Array.isArray(body)) throw new GitHubStop('GH_FAILED', 'GitHub answered something unreadable.', true, this.now())
      rows.push(...body.map(object))
      if (body.length < PAGE) break
    }
    return rows
  }

  /** The body of [url], its kept body on a 304 when [keep], or null on a 304 otherwise. With [fileMissing] a 404 answers
   *  `{ missing: true }`: a file that is not there. */
  private async read(repo: string, url: string, keep: boolean, fileMissing = false): Promise<unknown> {
    const last = this.kept.get(url)
    const reply = await this.get(url, last?.etag ?? null).catch(error => {
      const code = typeof error?.code === 'string' ? error.code : 'GH_FAILED'
      // gh missing or signed out stops every repository until it is fixed; a slow or failed answer only this pass.
      if (code === 'GH_MISSING' || code === 'GH_SIGNED_OUT') throw new GitHubStop(code, error.message, true, this.now() + OFF_RETRY_MS)
      throw new GitHubStop(code === 'TimeoutError' ? 'TIMEOUT' : 'UNREACHABLE', 'GitHub did not answer.', true, this.now())
    })
    if (reply.status === 304) return keep ? last?.body ?? null : null
    if (reply.resetAt !== null) throw new GitHubStop('RATE_LIMITED', 'GitHub is limiting this computer\'s requests.', true, Math.min(reply.resetAt, this.now() + LIMIT_MAX_MS))
    if (reply.status === 401) throw new GitHubStop('GH_SIGNED_OUT', 'GitHub refused this computer\'s gh login: run gh auth login.', true, this.now())
    if (reply.status === 404 && fileMissing) return { missing: true }
    if (reply.status === 404 || reply.status === 403) throw new GitHubStop('UNREADABLE', `this computer's gh login cannot read ${repo}.`, false, this.now() + UNREADABLE_RETRY_MS)
    if (reply.status !== 200) throw new GitHubStop('GH_FAILED', `GitHub answered ${reply.status}.`, true, this.now())
    if (reply.etag) {
      this.kept.delete(url)
      this.kept.set(url, { etag: reply.etag, body: keep ? reply.body : null })
      if (this.kept.size > MAX_KEPT) this.kept.delete(this.kept.keys().next().value!)
    }
    return reply.body
  }
}
