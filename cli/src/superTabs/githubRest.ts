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

/** How long what GitHub names a repository now is kept, and how long that it did not say: a rename is rare, and every take,
 *  read and cut asks; one that GitHub does not answer is not asked again at each. */
export const NAME_KEPT_MS = 60 * 60_000, NAME_UNSAID_MS = 10 * 60_000

/** The most repository names kept, the ones asked longest ago going first: any name a command is given is asked. */
const NAMES_MAX = 200

/** What GitHub names a repository now, lower case, asked with [get]: for one renamed since its project was made, GitHub answers
 *  its old name with its new one. The name asked when GitHub does not say (it cannot be read now, or is not there), which is
 *  logged once and asked again after [NAME_UNSAID_MS]; a name it says is kept [NAME_KEPT_MS]. A name being asked is asked once,
 *  however many commands want it at that moment. */
export function currentNames(get: GitHubGet, now: () => number = Date.now, log: (line: string) => void = line => console.warn(line)): (slug: string) => Promise<string> {
  const known = new Map<string, { name: Promise<string>; at: number; said: boolean }>()
  const ask = async (slug: string, before: boolean | undefined): Promise<{ name: string; said: boolean }> => {
    const read = await get(`/repos/${slug}`, null).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)))
    const name = !(read instanceof Error) && read.status === 200 && typeof object(read.body).full_name === 'string' ? String(object(read.body).full_name).toLowerCase() : null
    if (!name && before !== false) log(`[super-tab] GitHub did not say what ${slug} is called now: ${read instanceof Error ? read.message : `it answered ${read.status}`}`)
    return { name: name ?? slug, said: !!name }
  }
  return slug => {
    const kept = known.get(slug)
    if (kept && now() - kept.at < (kept.said ? NAME_KEPT_MS : NAME_UNSAID_MS)) return kept.name
    const entry = { name: Promise.resolve(slug), at: now(), said: true }
    entry.name = ask(slug, kept?.said).then(answer => { entry.said = answer.said; entry.at = now(); return answer.name })
    known.delete(slug)
    known.set(slug, entry)
    if (known.size > NAMES_MAX) known.delete(known.keys().next().value!)
    return entry.name
  }
}
const MAX_KEPT = 500
/** How long to wait before asking again: gh missing or signed out, a repository this login cannot read, a rate limit. */
const OFF_RETRY_MS = 5 * 60_000, UNREADABLE_RETRY_MS = 10 * 60_000, LIMIT_MAX_MS = 15 * 60_000
/** How long to wait before asking again after [misses] in a row: 30 seconds, doubling to 15 minutes. A pass every 20 seconds against a
 *  GitHub or a server that is down is the same failure three times a minute for as long as it lasts (and a revoked login, 180 `gh`
 *  runs an hour). */
export const retryIn = (misses: number): number => Math.min(LIMIT_MAX_MS, 30_000 * 2 ** Math.max(0, misses - 1))
/** [ms] as the log says it: "30 s", "2 min". */
export const waitWords = (ms: number): string => {
  const seconds = Math.max(1, Math.round(ms / 1000))
  return seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`
}

/** What a pass over several repositories remembers of what failed, for the relay and the merger alike: each repository's own misses and
 *  how long it is left alone, and the passes in a row that stopped for every repository. */
export class Waits {
  private readonly until = new Map<string, number>()
  private readonly misses = new Map<string, number>()
  private stops = 0

  /** Whether [repo] is left alone at [now]. */
  held(repo: string, now: number): boolean { return (this.until.get(repo) ?? 0) > now }

  /** [repo] failed: it waits [floor] ms, or the next of 30 s doubling to 15 min if that is longer. The wait. */
  miss(repo: string, now: number, floor = 0): number {
    const misses = (this.misses.get(repo) ?? 0) + 1
    this.misses.set(repo, misses)
    const wait = Math.max(floor, retryIn(misses))
    this.until.set(repo, now + wait)
    return wait
  }

  /** [repo] was read through: its misses start again. */
  ok(repo: string): void { this.misses.delete(repo) }

  /** A pass stopped for every repository, [floor] ms at least: the wait before the next. */
  stop(floor: number): number { return Math.max(floor, retryIn(++this.stops)) }

  /** A pass ran through: its stops start again. */
  ran(): void { this.stops = 0 }
}
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

  /** What [path] answers now, asked outright and not kept: an answer that is large and asked for once (a commit's check
   *  runs, goal.ts), which kept under its ETag would sit in memory for good. */
  async fresh(repo: string, path: string): Promise<unknown> {
    return this.read(repo, path, false, false, true)
  }

  /** Up to [maxPages] pages of a list as it is now, asked outright and not kept (fresh): the comments and files of closed pull
   *  requests, read once a day (scoreboard.ts), which kept under their ETags would push out the ones every pass asks with. */
  async freshPages(repo: string, path: string, maxPages: number): Promise<Json[]> {
    return this.pages(repo, path, maxPages, false, true)
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

  private async pages(repo: string, path: string, maxPages: number, keep: boolean, once = false): Promise<Json[]> {
    const rows: Json[] = []
    for (let page = 1; page <= maxPages; page++) {
      const body = await this.read(repo, page === 1 ? path : `${path}&page=${page}`, keep, false, once)
      // Asked outright there is no 304: no body is an answer cut off on its way (a list of a hundred files with their patches
      // is 600 KB against the 10 s deadline), and read as the end of the list it would count as nothing, with nothing said.
      if (body === null && once) throw new GitHubStop('GH_FAILED', 'GitHub\'s answer did not arrive whole.', false, this.now())
      if (body === null) return rows
      if (!Array.isArray(body)) throw new GitHubStop('GH_FAILED', 'GitHub answered something unreadable.', false, this.now())
      rows.push(...body.map(object))
      if (body.length < PAGE) break
    }
    return rows
  }

  /** The body of [url], its kept body on a 304 when [keep], or null on a 304 otherwise. With [fileMissing] a 404 answers
   *  `{ missing: true }`: a file that is not there. [once]: asked with no ETag, and nothing of the answer kept. */
  private async read(repo: string, url: string, keep: boolean, fileMissing = false, once = false): Promise<unknown> {
    const last = once ? undefined : this.kept.get(url)
    const reply = await this.get(url, last?.etag ?? null).catch(error => {
      const code = typeof error?.code === 'string' ? error.code : 'GH_FAILED'
      // gh missing or signed out stops every repository until it is fixed; a slow or failed answer only this pass.
      if (code === 'GH_MISSING' || code === 'GH_SIGNED_OUT') throw new GitHubStop(code, error.message, true, this.now() + OFF_RETRY_MS)
      throw new GitHubStop(code === 'TimeoutError' ? 'TIMEOUT' : 'UNREACHABLE', 'GitHub did not answer.', true, this.now())
    })
    if (reply.status === 304) return keep ? last?.body ?? null : null
    if (reply.resetAt !== null) throw new GitHubStop('RATE_LIMITED', 'GitHub is limiting this computer\'s requests.', true, Math.min(reply.resetAt, this.now() + LIMIT_MAX_MS))
    if (reply.status === 401) throw new GitHubStop('GH_SIGNED_OUT', 'GitHub refused this computer\'s gh login: run gh auth login.', true, this.now() + OFF_RETRY_MS)
    if (reply.status === 404 && fileMissing) return { missing: true }
    if (reply.status === 404 || reply.status === 403) throw new GitHubStop('UNREADABLE', `this computer's gh login cannot read ${repo}.`, false, this.now() + UNREADABLE_RETRY_MS)
    // GitHub failing on its own side stops every repository; any other answer is about this one (it still goes when it next can).
    if (reply.status !== 200) throw new GitHubStop('GH_FAILED', `GitHub answered ${reply.status}.`, reply.status >= 500, this.now())
    if (reply.etag && !once) {
      this.kept.delete(url)
      this.kept.set(url, { etag: reply.etag, body: keep ? reply.body : null })
      if (this.kept.size > MAX_KEPT) this.kept.delete(this.kept.keys().next().value!)
    }
    return reply.body
  }
}
