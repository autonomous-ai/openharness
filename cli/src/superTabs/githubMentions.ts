/**
 * Harness reads GitHub for its person's Swarm v4 agents (anh Dee, 2026-11-09: "why can't it be built into the product?").
 *
 * A v4 team's tasks are its repository's GitHub issues, and its agents answer each other there: a review's READ-OK, a
 * question, a comment on a line of code, a new task labelled builder:<name>. An agent heard none of it unless it ran a
 * watcher of its own (swarm-sandbox's tools/wait_for_mentions.py, which this replaces). Every 20 seconds this reads each
 * GitHub repository of the projects this computer's person's v4 agents read, with this computer's own gh login, and hands
 * the backend (github.relay) what reaches one of them: a comment, review or line comment that names it or is on its own
 * task or pull request (labelled builder:<name>, as GitHub tells a pull request's author), and an issue newly labelled for
 * it. The backend writes each into the person's chat with that agent, which hears it as any message there.
 *
 * Whose: only agents of the person signed in here, running here (a v4 agent runs on its person's own machine), so the gh
 * login read with is theirs; never another person's agent (identity: never the machine owner's login).
 * What: only what the repository's owner, members and collaborators wrote; anyone may comment on a public repository.
 * Cost: conditional requests, so an unchanged answer is a 304, which GitHub does not count against the rate limit; nothing
 * at all while no such agent runs.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { GitHubReads, GitHubStop, PAGE, type GitHubGet } from './githubRest.js'
import { identifier, object } from './wire.js'

type Json = Record<string, unknown>

export const MENTIONS_INTERVAL_MS = 20_000
/** The repository's people, as GitHub marks each comment's author. */
export const TEAM: ReadonlySet<unknown> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
/** Bounds on one pass and on what is kept: a Swarm reads at most this many repositories here, and a burst beyond a page
 *  count is read next pass. */
const MAX_REPOS = 20, MAX_REVIEWED = 10, MAX_RELAYS = 50, MAX_SEEN = 2_000, MAX_OWNED = 1_000
const TEXT_MAX = 4_000, TITLE_MAX = 300
/** Who the agents here are and what they read, asked again at most this often: each ask reads every agent's Swarm. */
const AGENTS_FRESH_MS = 60_000
/** A thread that relays this many times to one agent within LOOP_WINDOW_MS is paused for it: an agent that forgets to sign
 *  its posts on its own pull request would otherwise hear itself, answer, and hear that too. */
const LOOP_RELAYS = 6, LOOP_WINDOW_MS = 10 * 60_000
/** A repository no agent here has read for this long is forgotten. */
const FORGET_MS = 7 * 24 * 60 * 60_000
const VERDICTS: ReadonlySet<unknown> = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'])

/** One of this computer's person's v4 agents and where it is heard: its Swarm, its chat with its person, the names it goes
 *  by, the label of its tasks and pull requests, and the repositories of the projects it reads. */
export interface WatchedAgent { tabId: string; agentId: string; chat: string; names: string[]; label: string; repos: string[] }


/** One thing GitHub said, before it is matched to the agents it reaches. */
interface Said { key: string; event: 'comment' | 'review' | 'review-comment'; on: 'issue' | 'pull'; number: number; url: string; login: string
  association: string; text: string; createdAt: string; verdict?: string; path?: string; line?: number }

/** What is kept of a repository between passes and restarts: where each feed was read to, what was already handed on, each
 *  agent's tasks already known, and which issues and pull requests carry which builder label. */
interface RepoMemory { comments: string; reviewComments: string; issues: string; seen: string[]; tasks: Record<string, number[]>
  owned: Record<string, string[]>; usedAt: number }
interface Memory { repos: Record<string, RepoMemory> }

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Whether [body] is the agent's own post: it signs its posts with its name first ("Pip, 14:05: ..."). */
export const signedBy = (body: string, names: readonly string[]): boolean =>
  names.some(name => new RegExp(`^\\W*${escape(name)}[*_]*\\s*[,:]`).test(body))
/** Whether [body] names the agent: one of its names as written, as a whole word ("Pip", "@Pip", "**Pip**"). In its own case:
 *  "pip install" names nobody. */
export const namesAgent = (body: string, names: readonly string[]): boolean =>
  names.some(name => new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`).test(body))
/** The builder label of an agent's tasks and pull requests: builder:pip for Pip. */
export const builderLabel = (name: string): string => `builder:${name.trim().toLowerCase().replace(/\s+/g, '-')}`

/** owner/name of a github.com repository's address, https or ssh; null for any other host or shape. */
export function repositorySlug(url: unknown): string | null {
  if (typeof url !== 'string') return null
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

/** This computer's person's v4 agents running here, from the host's roster and each agent's own read of its Swarm. */
export async function watchedAgents(deps: { me: string | null; live: (harnessId: string) => boolean; roster: () => Promise<Json[]>
  read: (tabId: string, agentId: string) => Promise<Json> }): Promise<WatchedAgent[]> {
  if (!deps.me) return []
  const watched: WatchedAgent[] = []
  for (const row of await deps.roster()) {
    const agent = object(row.agent)
    if (agent.regular !== true || row.closeSession === true || row.stopRequested === true || !identifier(row.tabId) || !identifier(agent.id)) continue
    if (agent.contributorId !== deps.me || agent.machineOwnerId !== deps.me || typeof agent.harnessId !== 'string' || !deps.live(agent.harnessId)) continue
    const names = [...new Set([agent.name, agent.displayName].filter((n): n is string => typeof n === 'string' && !!n.trim()).map(n => n.trim()))]
    if (!names.length) continue
    const state = await deps.read(row.tabId, agent.id).catch(() => null)
    if (!state) continue
    const chat = (Array.isArray(state.conversations) ? state.conversations.map(object) : [])
      .find(c => c.kind === 'agent-chat' && Array.isArray(c.agentIds) && c.agentIds.includes(agent.id))
    // A Swarm from before projects keeps its one repository on the Swarm itself.
    const projects = Array.isArray(state.projects) ? state.projects.map(object) : state.project ? [{ repository: state.project }] : []
    const repos = [...new Set(projects.map(p => repositorySlug(object(p.repository).repositoryUrl)).filter((s): s is string => !!s))]
    if (!chat || !identifier(chat.id) || !repos.length) continue
    watched.push({ tabId: row.tabId, agentId: agent.id, chat: chat.id, names, label: builderLabel(names[0]!), repos })
  }
  return watched
}

export class GitHubMentions {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private readonly reads: GitHubReads
  private readonly unreadable = new Map<string, number>()
  private readonly threads = new Map<string, number[]>()
  private agents: { at: number; list: WatchedAgent[] } | null = null
  private offUntil = 0
  /** The last failure told, so each is logged once until it changes or clears. */
  private told = ''
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(private readonly deps: {
    watched: () => Promise<WatchedAgent[]>
    get: GitHubGet
    /** Hands one relay to the backend as this computer's person (github.relay). */
    relay: (tabId: string, operationId: string, command: Json) => Promise<unknown>
    file: string
    now?: () => number
    log?: (line: string) => void
    intervalMs?: number
  }) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (line => console.warn(line))
    this.reads = new GitHubReads(deps.get, this.now)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, this.deps.intervalMs ?? MENTIONS_INTERVAL_MS)
    this.timer.unref?.()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One pass; one still running is not started twice. */
  tick(): Promise<void> {
    this.running ??= this.pass().catch(error => this.tell('FAILED', error instanceof Error ? error.message : String(error)))
      .finally(() => { this.running = null })
    return this.running
  }

  private async pass(): Promise<void> {
    if (!this.agents || this.now() - this.agents.at >= AGENTS_FRESH_MS) this.agents = { at: this.now(), list: await this.deps.watched() }
    const agents = this.agents.list
    if (!agents.length || this.now() < this.offUntil) return
    const memory = this.load()
    const byRepo = new Map<string, WatchedAgent[]>()
    for (const agent of agents) for (const repo of agent.repos) byRepo.set(repo, [...byRepo.get(repo) ?? [], agent])
    const relays = { left: MAX_RELAYS }
    try {
      for (const [repo, watching] of [...byRepo].slice(0, MAX_REPOS)) {
        if ((this.unreadable.get(repo) ?? 0) > this.now()) continue
        try { await this.readRepo(repo, watching, memory, relays) } catch (error) {
          // What was read but not handed on is read again next pass: an ETag kept now would answer it with a 304.
          this.reads.forget(repo)
          if (error instanceof GitHubStop && error.everywhere) throw error
          if (error instanceof GitHubStop) this.unreadable.set(repo, error.until)
          this.tell(error instanceof GitHubStop ? error.code : 'RELAY_FAILED', `${repo}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      this.tell('', '')
    } catch (error) {
      if (!(error instanceof GitHubStop)) throw error
      this.offUntil = error.until
      this.tell(error.code, error.message)
    } finally {
      for (const [repo, kept] of Object.entries(memory.repos)) if (!byRepo.has(repo) && this.now() - kept.usedAt > FORGET_MS) delete memory.repos[repo]
      this.save(memory)
    }
  }

  private async readRepo(repo: string, agents: WatchedAgent[], memory: Memory, relays: { left: number }): Promise<void> {
    const at = new Date(this.now()).toISOString()
    // First read of a repository: from now on, nothing before it.
    const kept = memory.repos[repo] ??= { comments: at, reviewComments: at, issues: at, seen: [], tasks: {}, owned: {}, usedAt: this.now() }
    kept.usedAt = this.now()
    // An agent new to this repository: its open tasks and pull requests now. Its tasks are told to nobody, since only a task
    // labelled from now on is news; its pull requests are its own, so what is said on them from now on reaches it.
    for (const agent of agents) {
      if (kept.tasks[agent.agentId]) continue
      const open = (await this.reads.changed(repo, `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(agent.label)}&per_page=${PAGE}`)).filter(issue => Number.isSafeInteger(issue.number))
      for (const issue of open) kept.owned[String(issue.number)] = [...new Set([...kept.owned[String(issue.number)] ?? [], agent.label])]
      kept.tasks[agent.agentId] = open.filter(issue => !issue.pull_request).map(issue => Number(issue.number))
    }
    // Issues and pull requests changed since the last read: whose task or pull request each is, new tasks, and the pull requests
    // whose reviews to read. A comment changes its issue, so the issue it is on is known before its comment is matched.
    const issuesFrom = kept.issues
    const changed = await this.reads.changed(repo, `/repos/${repo}/issues?state=all&sort=updated&direction=asc&per_page=${PAGE}&since=${issuesFrom}`)
    for (const issue of changed) {
      const number = Number(issue.number)
      if (!Number.isSafeInteger(number)) continue
      const labels = (Array.isArray(issue.labels) ? issue.labels.map(object) : []).map(l => String(l.name ?? '')).filter(name => name.startsWith('builder:'))
      if (labels.length) kept.owned[String(number)] = labels; else delete kept.owned[String(number)]
    }
    trim(kept.owned, MAX_OWNED)
    const tasks: Array<{ agent: WatchedAgent; issue: Json }> = []
    for (const issue of changed) {
      if (issue.pull_request || issue.state !== 'open') continue
      for (const agent of agents) if (kept.owned[String(issue.number)]?.includes(agent.label) && !kept.tasks[agent.agentId]!.includes(Number(issue.number))) tasks.push({ agent, issue })
    }
    for (const { agent, issue } of tasks) {
      // Only the repository's people can label an issue: a labelled one is the team's task, whoever opened it.
      const association = TEAM.has(issue.author_association) ? String(issue.author_association) : 'COLLABORATOR'
      await this.hand(repo, agent, Number(issue.number), relays, `t:${issue.number}`, { event: 'task', on: 'issue', number: Number(issue.number),
        url: String(issue.html_url ?? ''), login: String(object(issue.user).login ?? ''), association, text: cut(String(issue.title ?? ''), TITLE_MAX) })
      kept.tasks[agent.agentId]!.push(Number(issue.number))
    }
    if (changed.length) kept.issues = newest(changed, issuesFrom)

    const comments = await this.reads.changed(repo, `/repos/${repo}/issues/comments?sort=updated&direction=asc&per_page=${PAGE}&since=${kept.comments}`)
    const said: Said[] = comments.map(c => ({ key: `c:${c.id}`, event: 'comment' as const, on: String(c.html_url ?? '').includes('/pull/') ? 'pull' as const : 'issue' as const,
      number: Number(String(c.issue_url ?? '').split('/').pop()), url: String(c.html_url ?? ''), login: String(object(c.user).login ?? ''),
      association: String(c.author_association ?? ''), text: String(c.body ?? ''), createdAt: String(c.created_at ?? '') }))
    const lineComments = await this.reads.changed(repo, `/repos/${repo}/pulls/comments?sort=updated&direction=asc&per_page=${PAGE}&since=${kept.reviewComments}`)
    said.push(...lineComments.map(c => ({ key: `l:${c.id}`, event: 'review-comment' as const, on: 'pull' as const,
      number: Number(String(c.pull_request_url ?? '').split('/').pop()), url: String(c.html_url ?? ''), login: String(object(c.user).login ?? ''),
      association: String(c.author_association ?? ''), text: String(c.body ?? ''), createdAt: String(c.created_at ?? ''),
      path: typeof c.path === 'string' ? c.path : undefined, line: Number.isSafeInteger(c.line) ? Number(c.line) : Number.isSafeInteger(c.original_line) ? Number(c.original_line) : undefined })))
    // A pull request's reviews have no feed of their own: read for the pull requests that changed, a few each pass.
    for (const pull of changed.filter(issue => issue.pull_request).slice(-MAX_REVIEWED)) {
      const reviews = await this.reads.changed(repo, `/repos/${repo}/pulls/${pull.number}/reviews?per_page=${PAGE}`)
      said.push(...reviews.filter(r => VERDICTS.has(r.state) && String(r.submitted_at ?? '') >= issuesFrom).map(r => ({ key: `r:${r.id}`, event: 'review' as const,
        on: 'pull' as const, number: Number(pull.number), url: String(r.html_url ?? ''), login: String(object(r.user).login ?? ''),
        association: String(r.author_association ?? ''), text: String(r.body ?? ''), createdAt: String(r.submitted_at ?? ''), verdict: String(r.state) })))
    }
    for (const item of said) {
      // Edited, not new: GitHub's since is by update time. Never twice, never a stranger's, never on nothing.
      if (kept.seen.includes(item.key) || !TEAM.has(item.association) || !Number.isSafeInteger(item.number)) continue
      if ((item.event === 'comment' && item.createdAt < kept.comments) || (item.event === 'review-comment' && item.createdAt < kept.reviewComments)) continue
      const owners = kept.owned[String(item.number)] ?? []
      for (const agent of agents) {
        if (signedBy(item.text, agent.names) || !(namesAgent(item.text, agent.names) || owners.includes(agent.label))) continue
        await this.hand(repo, agent, item.number, relays, item.key, { event: item.event, on: item.on, number: item.number, url: item.url, login: item.login,
          association: item.association, text: cut(item.text.trim() || verdictWord(item.verdict), TEXT_MAX),
          ...(item.verdict ? { verdict: item.verdict } : {}), ...(item.path ? { path: item.path } : {}), ...(item.line ? { line: item.line } : {}) })
      }
      kept.seen.push(item.key)
    }
    if (kept.seen.length > MAX_SEEN) kept.seen.splice(0, kept.seen.length - MAX_SEEN)
    if (comments.length) kept.comments = newest(comments, kept.comments)
    if (lineComments.length) kept.reviewComments = newest(lineComments, kept.reviewComments)
  }

  /** Hands one relay to the backend, once per agent and item: a retry after a failure sends the same operation id, which the
   *  backend writes once. */
  private async hand(repo: string, agent: WatchedAgent, number: number, relays: { left: number }, key: string, item: Json): Promise<void> {
    if (relays.left <= 0) throw new GitHubStop('BUSY', 'More GitHub news than one pass relays: the rest goes next pass.', true, this.now())
    const thread = `${agent.agentId}\n${repo}#${number}`
    const recent = (this.threads.get(thread) ?? []).filter(at => this.now() - at < LOOP_WINDOW_MS)
    if (recent.length >= LOOP_RELAYS) {
      this.tell('LOOP', `${repo}#${number} relayed ${LOOP_RELAYS} times in 10 minutes to one agent: paused there`)
      return
    }
    const operationId = `github-${createHash('sha256').update(`${repo}\n${key}\n${agent.agentId}`).digest('hex').slice(0, 40)}`
    await this.deps.relay(agent.tabId, operationId, { type: 'github.relay', conversationId: agent.chat, agentId: agent.agentId, repository: repo, ...item })
    this.threads.set(thread, [...recent, this.now()])
    relays.left--
  }

  private tell(code: string, detail: string): void {
    const line = code ? `${code} ${detail}` : ''
    if (line === this.told) return
    this.told = line
    this.log(code ? `[super-tab] GitHub news for agents stopped · ${line}` : '[super-tab] GitHub news for agents reads again')
  }

  private load(): Memory {
    try {
      const saved = object(JSON.parse(readFileSync(this.deps.file, 'utf8')))
      return { repos: object(saved.repos) as Memory['repos'] }
    } catch { return { repos: {} } }
  }

  private save(memory: Memory): void {
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true })
      const temporary = `${this.deps.file}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(memory), { mode: 0o600 })
      renameSync(temporary, this.deps.file)
    } catch (error) { this.tell('SAVE_FAILED', error instanceof Error ? error.message : String(error)) }
  }
}

const cut = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text
const verdictWord = (verdict: string | undefined) => verdict === 'APPROVED' ? 'Approved.' : verdict === 'CHANGES_REQUESTED' ? 'Changes requested.' : 'Commented.'
/** The newest update time among [rows], never older than [from]: where the feed is read from next. */
const newest = (rows: Json[], from: string) => rows.reduce((top, row) => String(row.updated_at ?? '') > top ? String(row.updated_at) : top, from)
/** Keeps only the [max] most recently added keys of [record]. */
function trim(record: Record<string, unknown>, max: number): void {
  const keys = Object.keys(record)
  for (const key of keys.slice(0, Math.max(0, keys.length - max))) delete record[key]
}
