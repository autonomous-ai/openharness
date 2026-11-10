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
import { worksOnOf } from './assign/crew.js'
import { GitHubReads, GitHubStop, PAGE, Waits, waitWords, type GitHubGet } from './githubRest.js'
import { permanentRefusal } from './retries.js'
import { identifier, object, SuperTabHostError } from './wire.js'

type Json = Record<string, unknown>

export const MENTIONS_INTERVAL_MS = 20_000
/** The repository's people, as GitHub marks each comment's author. */
export const TEAM: ReadonlySet<unknown> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
/** Bounds on one pass and on what is kept: a Swarm reads at most this many repositories here, and a burst beyond a page
 *  count is read next pass. */
const MAX_REPOS = 20, MAX_REVIEWED = 10, MAX_RELAYS = 50, MAX_SEEN = 2_000, MAX_OWNED = 1_000, MAX_ASKED = 200
const TEXT_MAX = 4_000, TITLE_MAX = 300
/** Who the agents here are and what they read, asked again at most this often: each ask reads every agent's Swarm. */
const AGENTS_FRESH_MS = 60_000
/** A thread that relays this many times to one agent within LOOP_WINDOW_MS is paused for it: an agent that forgets to sign
 *  its posts on its own pull request would otherwise hear itself, answer, and hear that too. */
const LOOP_RELAYS = 6, LOOP_WINDOW_MS = 10 * 60_000
/** How far back the first read of a repository looks: the minutes around an agent's start, never its history. */
const FIRST_READ_MS = 10 * 60_000
/** A repository no agent here has read for this long is forgotten. */
const FORGET_MS = 7 * 24 * 60 * 60_000
const VERDICTS: ReadonlySet<unknown> = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'])

/** One of this computer's person's v4 agents and where it is heard: its Swarm, its chat with its person, the names it goes
 *  by, the label of its tasks and pull requests, and the repositories of the projects it reads. */
export interface WatchedAgent { tabId: string; agentId: string; chat: string; names: string[]; label: string; repos: string[] }


/** One thing GitHub said, before it is matched to the agents it reaches. A line comment names the review it is part of. */
interface Said { key: string; event: 'comment' | 'review' | 'review-comment'; on: 'issue' | 'pull'; number: number; url: string; login: string
  association: string; text: string; createdAt: string; verdict?: string; path?: string; line?: number; review?: number }
/** A review with the line comments it was submitted with. */
interface Review extends Said { id: number; lines: Said[] }

/** What is kept of a repository between passes and restarts: where each feed was read to, what was already handed on, each
 *  agent's tasks already known, and which issues and pull requests carry which builder label. */
interface RepoMemory { comments: string; reviewComments: string; issues: string; seen: string[]; tasks: Record<string, number[]>
  owned: Record<string, string[]>; usedAt: number
  /** The agents already asked what they work on here (askFocus). */
  asked?: string[] }
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

/** owner/name of a github.com link into a repository ("https://github.com/Acme/App/pull/4#..."), as GitHub writes it now. */
const repositoryOf = (url: unknown): string | null => {
  const m = typeof url === 'string' ? /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})(?:[/#?]|$)/.exec(url) : null
  return m ? `${m[1]}/${m[2]}` : null
}
/** A refusal the server makes of one item and would make of it again: a bad request, a firewall, a chat that is gone, an id used for other
 *  words. By its code, not its status: a sign-in, a timeout, throttling, an update, a busy server and a lapsed billing say nothing of the
 *  item, and a backend that does not know the command yet (a discriminator it does not recognise) refuses every item. */
const REFUSED_CODES: ReadonlySet<string> = new Set(['VALIDATION_ERROR', 'REQUEST_BLOCKED', 'FORBIDDEN', 'HUMAN_REQUIRED', 'OPERATION_REUSED'])
const refusedForGood = (error: unknown): error is SuperTabHostError => error instanceof SuperTabHostError && error.status < 500
  && (permanentRefusal(error) || REFUSED_CODES.has(error.code) && !(error.code === 'VALIDATION_ERROR' && /discriminator|Unrecognized key/i.test(error.message)))

/** owner/name of a github.com repository's address, https or ssh, in lower case (GitHub reads it in any case, and two spellings of one
 *  repository are one here); null for any other host or shape. */
export function repositorySlug(url: unknown): string | null {
  if (typeof url !== 'string') return null
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null
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
    // The name people see first (backend agentNames.ts: a chosen name, else a free one): it names the agent's label and its
    // instructions file as the assigner and Desktop name them. Its stored name can be its engine's ("Claude Code").
    const names = [...new Set([agent.displayName, agent.name].filter((n): n is string => typeof n === 'string' && !!n.trim()).map(n => n.trim()))]
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
  /** How long each repository is left alone after it failed: one this login cannot read, or one whose news the server could not take. */
  private readonly waits = new Waits()
  /** The items the server refused for good, each named once in the log. */
  private readonly refused = new Set<string>()
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
    /** Tells one agent something only it reads, in its chat with its person (an agent-only notice). */
    tell?: (agent: WatchedAgent, operationId: string, text: string) => Promise<unknown>
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
    const byRepo = new Map<string, WatchedAgent[]>()
    for (const agent of agents) for (const repo of agent.repos) byRepo.set(repo, [...byRepo.get(repo) ?? [], agent])
    // Every repository left alone for now: nothing is read, and the file is neither read nor written for it.
    const repos = [...byRepo].slice(0, MAX_REPOS)
    if (repos.every(([repo]) => this.waits.held(repo, this.now()))) return
    const memory = this.load()
    const relays = { left: MAX_RELAYS, sent: 0 }
    // Whether a repository is being left alone: the pass then says nothing of reading again.
    let held = false
    try {
      for (const [repo, watching] of repos) {
        if (this.waits.held(repo, this.now())) { held = true; continue }
        try { await this.readRepo(repo, watching, memory, relays); this.waits.ok(repo) } catch (error) {
          // What was read but not handed on is read again next pass: an ETag kept now would answer it with a 304.
          this.reads.forget(repo)
          if (error instanceof GitHubStop && error.everywhere) throw error
          held = true
          // This repository waits, 30 seconds and doubling to 15 minutes (longer if GitHub says so), and what it owes goes then.
          const wait = this.waits.miss(repo, this.now(), error instanceof GitHubStop ? error.until - this.now() : 0)
          this.tell(error instanceof GitHubStop ? error.code : 'RELAY_FAILED', `${repo}: ${error instanceof Error ? error.message : String(error)} (again in ${waitWords(wait)})`)
        }
      }
      this.waits.ran()
      if (!held) this.tell('', '')
    } catch (error) {
      if (!(error instanceof GitHubStop)) throw error
      // More news than one pass relays is no failure: the rest goes at the next.
      const wait = error.code === 'BUSY' ? 0 : this.waits.stop(error.until - this.now())
      this.offUntil = this.now() + wait
      this.tell(error.code, `${error.message}${wait ? ` (again in ${waitWords(wait)})` : ''}`)
    } finally {
      for (const [repo, kept] of Object.entries(memory.repos)) if (!byRepo.has(repo) && this.now() - kept.usedAt > FORGET_MS) delete memory.repos[repo]
      this.save(memory)
    }
  }

  private async readRepo(repo: string, agents: WatchedAgent[], memory: Memory, relays: { left: number; sent: number }): Promise<void> {
    /** What the server refused for good of this repository's news, and what to record of each if it is passed over (see `passOver`). */
    const refused: Array<{ error: SuperTabHostError; number: number; key: string; record: () => void }> = []
    const sentBefore = relays.sent
    // First read of a repository: what was said in the last few minutes, and nothing before. An agent's start and Harness's
    // ask to it can come in the same minute (a PM resumed asks its silent reader at once, githubAssign.ts): read from the
    // moment of the first read alone, that ask was missed for good.
    const from = new Date(this.now() - FIRST_READ_MS).toISOString()
    const kept = memory.repos[repo] ??= { comments: from, reviewComments: from, issues: from, seen: [], tasks: {}, owned: {}, usedAt: this.now() }
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
      const refusal = await this.hand(repo, agent, Number(issue.number), relays, `t:${issue.number}`, { event: 'task', on: 'issue', number: Number(issue.number),
        url: String(issue.html_url ?? ''), login: String(object(issue.user).login ?? ''), association, text: cut(String(issue.title ?? ''), TITLE_MAX) })
      const record = () => { kept.tasks[agent.agentId]!.push(Number(issue.number)) }
      if (refusal) { refused.push({ error: refusal, number: Number(issue.number), key: `t:${issue.number}`, record }); continue }
      record()
      await this.askFocus(repo, agent, kept)
    }

    const comments = await this.reads.changed(repo, `/repos/${repo}/issues/comments?sort=updated&direction=asc&per_page=${PAGE}&since=${kept.comments}`)
    const said: Said[] = comments.map(c => ({ key: `c:${c.id}`, event: 'comment' as const, on: String(c.html_url ?? '').includes('/pull/') ? 'pull' as const : 'issue' as const,
      number: Number(String(c.issue_url ?? '').split('/').pop()), url: String(c.html_url ?? ''), login: String(object(c.user).login ?? ''),
      association: String(c.author_association ?? ''), text: String(c.body ?? ''), createdAt: String(c.created_at ?? '') }))
    const lineComments = await this.reads.changed(repo, `/repos/${repo}/pulls/comments?sort=updated&direction=asc&per_page=${PAGE}&since=${kept.reviewComments}`)
    const lines: Said[] = lineComments.map(c => ({ key: `l:${c.id}`, event: 'review-comment' as const, on: 'pull' as const,
      number: Number(String(c.pull_request_url ?? '').split('/').pop()), url: String(c.html_url ?? ''), login: String(object(c.user).login ?? ''),
      association: String(c.author_association ?? ''), text: String(c.body ?? ''), createdAt: String(c.created_at ?? ''),
      path: typeof c.path === 'string' ? c.path : undefined, line: Number.isSafeInteger(c.line) ? Number(c.line) : Number.isSafeInteger(c.original_line) ? Number(c.original_line) : undefined,
      review: Number.isSafeInteger(c.pull_request_review_id) ? Number(c.pull_request_review_id) : undefined }))
    // A pull request's reviews have no feed of their own: read for the pull requests that changed, a few each pass.
    const reviews: Review[] = []
    for (const pull of changed.filter(issue => issue.pull_request).slice(-MAX_REVIEWED)) {
      const read = await this.reads.changed(repo, `/repos/${repo}/pulls/${pull.number}/reviews?per_page=${PAGE}`)
      reviews.push(...read.filter(r => VERDICTS.has(r.state) && String(r.submitted_at ?? '') >= issuesFrom).map(r => ({ key: `r:${r.id}`, event: 'review' as const,
        on: 'pull' as const, number: Number(pull.number), url: String(r.html_url ?? ''), login: String(object(r.user).login ?? ''),
        association: String(r.author_association ?? ''), text: String(r.body ?? ''), createdAt: String(r.submitted_at ?? ''), verdict: String(r.state),
        id: Number(r.id), lines: [] })))
    }
    // A review's line comments are part of it, as GitHub shows them, and go with it in one message: a review of five lines woke
    // its agent six times, and GitHub makes even a lone line comment a review of its own, which relayed it twice. A line whose
    // review went before (read in the pass before its lines were) goes alone.
    const unsent = new Map(reviews.filter(r => !kept.seen.includes(r.key)).map(r => [r.id, r]))
    const loose: Said[] = []
    for (const line of lines) {
      const review = line.review === undefined ? undefined : unsent.get(line.review)
      if (review?.number === line.number && !kept.seen.includes(line.key)) review.lines.push(line)
      else loose.push(line)
    }
    for (const item of [...said, ...reviews, ...loose]) {
      // Edited, not new: GitHub's since is by update time. Never twice, never a stranger's, never on nothing.
      if (kept.seen.includes(item.key) || !TEAM.has(item.association) || !Number.isSafeInteger(item.number)) continue
      if ((item.event === 'comment' && item.createdAt < kept.comments) || (item.event === 'review-comment' && item.createdAt < kept.reviewComments)) continue
      const owners = kept.owned[String(item.number)] ?? []
      let refusal: SuperTabHostError | null = null
      for (const agent of agents) {
        const relay = 'lines' in item ? reviewFor(item as Review, agent, owners.includes(agent.label)) : sayingFor(item, agent, owners.includes(agent.label))
        if (relay) refusal = await this.hand(repo, agent, item.number, relays, item.key, relay) ?? refusal
      }
      const record = () => { kept.seen.push(item.key, ...('lines' in item ? (item as Review).lines.map(line => line.key) : [])) }
      if (refusal) { refused.push({ error: refusal, number: item.number, key: item.key, record }); continue }
      record()
    }
    this.passOver(repo, refused, relays.sent > sentBefore)
    if (kept.seen.length > MAX_SEEN) kept.seen.splice(0, kept.seen.length - MAX_SEEN)
    // Each feed moves on only once all it brought was handed on: a pass that failed reads the same again (its ETags are
    // forgotten), and what went is not sent twice (seen, tasks). The issue feed moving on first lost a failed review for good
    // whenever a newer pull request had moved it past its own.
    if (changed.length) kept.issues = newest(changed, issuesFrom)
    if (comments.length) kept.comments = newest(comments, kept.comments)
    if (lineComments.length) kept.reviewComments = newest(lineComments, kept.reviewComments)
  }

  /**
   * With its first task in a repository, an agent asks its person what to focus on there, unless its instructions file
   * says (anh Dee, 2026-11-09: "the agent must be more proactive and ask the user what area they want the agent to focus
   * on. otherwise the user won't know what to say"). Its answer becomes the `Works on:` line the assigner reads
   * (assign/crew.ts worksOnOf). Once per agent and repository; the operation id is the same after a restart.
   */
  private async askFocus(repo: string, agent: WatchedAgent, kept: RepoMemory): Promise<void> {
    const tell = this.deps.tell
    if (!tell || kept.asked?.includes(agent.agentId)) return
    const name = agent.names[0]!
    const file = `agents/${name}.md`
    if (worksOnOf(await this.reads.file(repo, file)) === null) {
      const areas = (await this.reads.current(repo, `/repos/${repo}/labels?per_page=${PAGE}`, 3)).map(label => String(label.name ?? ''))
        .filter(label => label.startsWith('part:')).map(label => label.slice('part:'.length)).sort()
      const choices = areas.length ? `its areas so far: ${areas.join(', ')}; or anything` : 'it has no areas yet, so any word will do; or anything'
      const operationId = `works-on-${createHash('sha256').update(`${repo}\n${agent.agentId}`).digest('hex').slice(0, 40)}`
      await tell(agent, operationId, `You have your first task in ${repo}. Ask your person, in your chat with them, which area of ${repo} `
        + `you should focus on (${choices}). Do not wait for the answer to start your task. When they answer, make "Works on: <their answer>" `
        + `the first line of ${file} in ${repo}, in a pull request of its own on a branch ${agent.label.slice('builder:'.length)}/works-on, labelled `
        // Harness reads and merges only the team's own pull requests, known by their builder label or branch (assign/crew.ts teamOf).
        + `${agent.label}: Harness then gives you those tasks first.`)
    }
    kept.asked = [...kept.asked ?? [], agent.agentId].slice(-MAX_ASKED)
  }

  /** Hands one relay to the backend, once per agent and item: a retry after a failure sends the same operation id, which the
   *  backend writes once. What the server refuses for good of it is returned, not thrown (see `passOver`). */
  private async hand(repo: string, agent: WatchedAgent, number: number, relays: { left: number; sent: number }, key: string, item: Json): Promise<SuperTabHostError | null> {
    if (relays.left <= 0) throw new GitHubStop('BUSY', 'More GitHub news than one pass relays: the rest goes next pass.', true, this.now())
    const thread = `${agent.agentId}\n${repo}#${number}`
    const recent = (this.threads.get(thread) ?? []).filter(at => this.now() - at < LOOP_WINDOW_MS)
    if (recent.length >= LOOP_RELAYS) {
      this.tell('LOOP', `${repo}#${number} relayed ${LOOP_RELAYS} times in 10 minutes to one agent: paused there`)
      return null
    }
    const operationId = `github-${createHash('sha256').update(`${repo}\n${key}\n${agent.agentId}`).digest('hex').slice(0, 40)}`
    try {
      // The repository as GitHub writes it now (its case, its name after a rename): the server refuses a link outside the repository
      // a row names, and the address a project was written with may be neither.
      await this.deps.relay(agent.tabId, operationId, { type: 'github.relay', conversationId: agent.chat, agentId: agent.agentId,
        repository: repositoryOf(item.url) ?? repo, ...item })
    } catch (error) {
      if (refusedForGood(error)) return error
      throw error
    }
    this.threads.set(thread, [...recent, this.now()])
    relays.left--
    relays.sent++
    return null
  }

  /** What the server refused for good of a repository's news this pass (a link it will not take, a comment its firewall refuses, a chat
   *  that is gone), once the pass is over: if something else of the repository went through, these are what the server refuses of them,
   *  not its state, so they are passed over, named once in the log, and the rest has gone on. If nothing did, the refusal may be the
   *  server's (an older backend, a firewall in front of this computer), and dropping them would lose the news for good: the repository
   *  waits as for any failure and they are handed on again. */
  private passOver(repo: string, refused: Array<{ error: SuperTabHostError; number: number; key: string; record: () => void }>, wentThrough: boolean): void {
    if (!refused.length) return
    if (!wentThrough) throw refused[0]!.error
    for (const { error, number, key, record } of refused) {
      record()
      const id = `${repo}\n${key}`
      if (this.refused.has(id)) continue
      this.refused.add(id)
      if (this.refused.size > MAX_SEEN) this.refused.delete(this.refused.values().next().value!)
      this.log(`[super-tab] GitHub news for agents passed over one item · RELAY_REFUSED ${repo}#${number} (${error.code}): ${error.message.slice(0, 200)}`)
    }
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

/** What [agent] is handed of a comment or line comment: one that names it or is on its own task or pull request, never its own. */
function sayingFor(item: Said, agent: WatchedAgent, own: boolean): Json | null {
  if (signedBy(item.text, agent.names) || !(own || namesAgent(item.text, agent.names))) return null
  return { event: item.event, on: item.on, number: item.number, url: item.url, login: item.login, association: item.association,
    text: cut(item.text.trim() || verdictWord(undefined), TEXT_MAX), ...(item.path ? { path: item.path } : {}), ...(item.line ? { line: item.line } : {}) }
}

/** What [agent] is handed of a review: all of it on its own pull request, else only the parts that name it; nothing of a
 *  review it signed. One line and nothing else is handed on as that line comment, which is how GitHub's Files tab shows it;
 *  a verdict is kept for the pull request's own agent, whose work it judges. */
function reviewFor(review: Review, agent: WatchedAgent, own: boolean): Json | null {
  if ([review, ...review.lines].some(part => signedBy(part.text, agent.names))) return null
  const body = review.text.trim() && (own || namesAgent(review.text, agent.names)) ? review.text.trim() : ''
  const lines = review.lines.filter(line => own || namesAgent(line.text, agent.names))
  if (!own && !body && !lines.length) return null
  if (!body && lines.length === 1 && (!own || review.verdict === 'COMMENTED')) return sayingFor(lines[0]!, agent, true)
  const where = (line: Said) => [line.path, line.line ? `line ${line.line}` : ''].filter(Boolean).join(' ')
  const text = [body, ...lines.map(line => where(line) ? `${where(line)}:\n${line.text.trim()}` : line.text.trim())].filter(Boolean).join('\n\n')
  return { event: 'review', on: 'pull', number: review.number, url: review.url, login: review.login, association: review.association,
    verdict: review.verdict, text: cut(text || verdictWord(review.verdict), TEXT_MAX) }
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
