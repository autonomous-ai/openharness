/**
 * Harness merges a Swarm v4 team's pull requests by rule, as lampOS's train bot does (its docs/joining.md, "Trains, reads
 * and promotes"; anh Dee, 2026-11-09: "go build it"). Agents never merge: in the swarm-sandbox run Claude Code's auto mode
 * refused every merge an agent tried after its READ-OK, and switching that check off for agents is not ours to do. The rule
 * is code, run by the Harness of the person whose agent is the project's PM, with that person's own gh login: one merger
 * for a project, as lampOS runs one train bot.
 *
 * A pull request into the default branch is merged, squashed, when
 * - it is not a draft;
 * - its head has a READ-OK from someone other than its author: `READ-OK <sha>` in a comment's first line, the reader the name
 *   the comment is signed with ("Juno, 14:20, to **Pip**: READ-OK f6edb44"), or its GitHub login when unsigned; two from two
 *   readers when its text or a comment's first line says TWO READS;
 * - no reader's last word on it is a HOLD: a HOLD stands until that reader's later READ-OK;
 * - every check on its head passed;
 * - and GitHub says it can merge.
 * One that cannot, being behind or in conflict, or whose checks failed, is told so on itself, to its author by name, once for
 * each head, so the GitHub news brings it to its author (githubMentions.ts).
 */
import { labelOf, teamOf, type Crew } from './assign/crew.js'
import type { GitHubGet, GitHubSend } from './githubRest.js'
import { GitHubReads, GitHubStop, PAGE } from './githubRest.js'
import { repositorySlug, TEAM } from './githubMentions.js'
import { identifier, object } from './wire.js'

type Json = Record<string, unknown>

export const MERGE_INTERVAL_MS = 30_000
/** Open pull requests are read a hundred a page, the most recently updated first, up to this many pages each pass: a busy shared
 *  repository has over a hundred open (lampOS and openharness about 110 each, 2026-11-10), and the team's own can be any of
 *  them. The newest thirty alone left an older team pull request unread and unmerged for good. */
export const PULL_PAGES = 3
export const openPullsPath = (repo: string): string => `/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${PAGE}`
/** How often the projects whose PM runs here are asked again: each ask reads the PM's Swarm. */
const PROJECTS_FRESH_MS = 60_000
/** A verdict as lampOS's readers write it: `READ-OK <sha>` or `HOLD <sha>`, the sha at least 7 hex digits. */
const VERDICT = /(?<![\w-])(READ-OK|HOLD)\s+([0-9a-f]{7,40})(?![0-9a-f])/
/** A post's signature: its writer's name first, then a comma, colon or bracket ("Juno, 14:20:", "**Faye** (PM):"). */
const SIGNATURE = /^\W*([A-Za-z][\w-]*(?: [A-Za-z][\w-]*)?)\**\s*[,:(]/
const SELF = 'Harness'

/** A project whose PM runs on this computer as its person: the merger merges its repository's pull requests, and the
 *  assigner gives its tasks (githubAssign.ts). Its Swarm, its PM and the project, to read its crew as the PM. */
export interface LedProject { repo: string; pm: string; tabId: string; pmAgentId: string; projectId: string }

/** The projects whose PM is one of this computer's person's agents running here, from the host's roster and the PM's read. */
export async function ledProjects(deps: { me: string | null; live: (harnessId: string) => boolean | Promise<boolean>; roster: () => Promise<Json[]>
  read: (tabId: string, agentId: string) => Promise<Json> }): Promise<LedProject[]> {
  if (!deps.me) return []
  const found = new Map<string, LedProject>()
  for (const row of await deps.roster()) {
    const agent = object(row.agent)
    if (row.lead !== true || !identifier(row.ledConversationId) || !identifier(row.tabId) || !identifier(agent.id) || row.closeSession === true) continue
    if (agent.contributorId !== deps.me || agent.machineOwnerId !== deps.me || typeof agent.harnessId !== 'string' || !await deps.live(agent.harnessId)) continue
    const state = await deps.read(row.tabId, agent.id).catch(() => null)
    const project = (Array.isArray(state?.projects) ? state.projects.map(object) : []).find(p => p.leadConversationId === row.ledConversationId)
    const repo = repositorySlug(object(project?.repository).repositoryUrl)
    if (repo && identifier(project?.id) && !found.has(repo)) {
      found.set(repo, { repo, pm: String(agent.displayName ?? agent.name ?? 'PM'), tabId: row.tabId, pmAgentId: agent.id, projectId: project.id })
    }
  }
  return [...found.values()]
}

/** What one pull request's comments say: each reader's last verdict, by its name in lowercase, with the name as it signs,
 *  and whether it asks for two reads. */
export function verdicts(comments: Json[], body: string): { readers: Map<string, { verdict: 'READ-OK' | 'HOLD'; sha: string; name: string }>; twoReads: boolean } {
  const readers = new Map<string, { verdict: 'READ-OK' | 'HOLD'; sha: string; name: string; at: string }>()
  let twoReads = /\bTWO READS\b/.test(body)
  for (const comment of comments) {
    if (!TEAM.has(comment.author_association)) continue
    const first = String(comment.body ?? '').split('\n').find(line => line.trim()) ?? ''
    if (/\bTWO READS\b/.test(first)) twoReads = true
    const found = VERDICT.exec(first)
    if (!found) continue
    const reader = SIGNATURE.exec(first)?.[1] ?? String(object(comment.user).login ?? '')
    if (!reader || reader === SELF) continue
    const at = String(comment.created_at ?? '')
    const key = reader.toLowerCase()
    const last = readers.get(key)
    if (!last || at >= last.at) readers.set(key, { verdict: found[1] as 'READ-OK' | 'HOLD', sha: found[2]!, name: reader, at })
  }
  return { readers: new Map([...readers].map(([k, v]) => [k, { verdict: v.verdict, sha: v.sha, name: v.name }])), twoReads }
}

/** One name however it is written: as an agent signs it ("Pip Two"), as its builder label has it (`pip-two`), or cased
 *  otherwise. Without it, "pip two" and "pip-two" were two people, so an agent with a two-word name read its own pull request
 *  and the merger merged it (found by the other session's Q3 tester, 2026-11-09; #3665 reads names more fully). */
export const sameKey = (name: string): string => name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/** The pull request's author by name: its builder label, else its branch's first part (`pip/12`). */
export function authorOf(pull: Json): string | null {
  const label = (Array.isArray(pull.labels) ? pull.labels.map(object) : []).map(l => String(l.name ?? '')).find(n => n.startsWith('builder:'))
  if (label) return label.slice('builder:'.length)
  const branch = String(object(pull.head).ref ?? '')
  return branch.includes('/') ? branch.split('/')[0]!.toLowerCase() : null
}

/** Whether every check on a head passed (none at all passes), is still running, or failed with which names. */
export function checksOf(runs: Json[], status: Json): { state: 'passed' | 'running' | 'failed'; failed: string[] } {
  const failed: string[] = []
  let running = false
  for (const run of runs) {
    if (run.status !== 'completed') { running = true; continue }
    if (!['success', 'neutral', 'skipped'].includes(String(run.conclusion))) failed.push(String(run.name ?? 'a check'))
  }
  for (const each of Array.isArray(status.statuses) ? status.statuses.map(object) : []) {
    if (each.state === 'pending') running = true
    else if (each.state !== 'success') failed.push(String(each.context ?? 'a status'))
  }
  return { state: failed.length ? 'failed' : running ? 'running' : 'passed', failed }
}

export class GitHubMerge {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private readonly reads: GitHubReads
  private readonly unreadable = new Map<string, number>()
  /** What each pull request was last told, by head and reason, so it is told once for each head. */
  private readonly told = new Map<string, string>()
  private projects: { at: number; list: LedProject[] } | null = null
  private offUntil = 0
  private logged = ''
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(private readonly deps: { projects: () => Promise<LedProject[]>; crew: (project: LedProject) => Promise<Crew>; get: GitHubGet
    send: GitHubSend; now?: () => number; log?: (line: string) => void; intervalMs?: number }) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (line => console.warn(line))
    this.reads = new GitHubReads(deps.get, this.now)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, this.deps.intervalMs ?? MERGE_INTERVAL_MS)
    this.timer.unref?.()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  tick(): Promise<void> {
    this.running ??= this.pass().catch(error => this.note('FAILED', error instanceof Error ? error.message : String(error)))
      .finally(() => { this.running = null })
    return this.running
  }

  private async pass(): Promise<void> {
    if (!this.projects || this.now() - this.projects.at >= PROJECTS_FRESH_MS) this.projects = { at: this.now(), list: await this.deps.projects() }
    if (!this.projects.list.length || this.now() < this.offUntil) return
    try {
      for (const project of this.projects.list) {
        if ((this.unreadable.get(project.repo) ?? 0) > this.now()) continue
        try { await this.mergeReady(project) } catch (error) {
          this.reads.forget(project.repo)
          if (error instanceof GitHubStop && error.everywhere) throw error
          if (error instanceof GitHubStop) this.unreadable.set(project.repo, error.until)
          this.note(error instanceof GitHubStop ? error.code : 'MERGE_FAILED', `${project.repo}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      this.note('', '')
    } catch (error) {
      if (!(error instanceof GitHubStop)) throw error
      this.offUntil = error.until
      this.note(error.code, error.message)
    }
  }

  private async mergeReady(project: LedProject): Promise<void> {
    const { repo } = project
    const base = String((await this.reads.one(repo, `/repos/${repo}`)).default_branch ?? '')
    const pulls = (await this.reads.current(repo, openPullsPath(repo), PULL_PAGES))
      .filter(pull => pull.draft !== true && object(pull.base).ref === base)
    // The team, read of the PM's Swarm (a changes read on the backend), only when a pull request could merge.
    if (!pulls.length) return
    const team = teamOf(await this.deps.crew(project), project.pm)
    for (const pull of pulls) {
      const number = Number(pull.number), head = String(object(pull.head).sha ?? '')
      if (!Number.isSafeInteger(number) || !/^[0-9a-f]{40}$/.test(head)) continue
      const author = authorOf(pull)
      // The team's own pull requests only (assign/crew.ts teamOf): a person's merges as that person's repository does it.
      if (author === null || !team.has(labelOf(author))) continue
      const comments = await this.reads.current(repo, `/repos/${repo}/issues/${number}/comments?per_page=${PAGE}`, 3)
      const { readers, twoReads } = verdicts(comments, String(pull.body ?? ''))
      if ([...readers.values()].some(r => r.verdict === 'HOLD')) continue
      const reads = [...readers].filter(([reader, r]) => r.verdict === 'READ-OK' && head.startsWith(r.sha) && sameKey(reader) !== sameKey(author))
      if (reads.length < (twoReads ? 2 : 1)) continue
      const runs = object(await this.reads.one(repo, `/repos/${repo}/commits/${head}/check-runs?per_page=${PAGE}`)).check_runs
      const checks = checksOf(Array.isArray(runs) ? runs.map(object) : [], await this.reads.one(repo, `/repos/${repo}/commits/${head}/status`))
      if (checks.state === 'running') continue
      if (checks.state === 'failed') { await this.tellOnce(repo, number, head, author, `checks failed: ${checks.failed.slice(0, 3).join(', ')}. Fix them and push.`, comments); continue }
      const detail = await this.reads.one(repo, `/repos/${repo}/pulls/${number}`)
      const state = String(detail.mergeable_state ?? 'unknown')
      if (state === 'behind') { await this.tellOnce(repo, number, head, author, `it is behind ${base}: update the branch and push.`, comments); continue }
      if (state === 'dirty') { await this.tellOnce(repo, number, head, author, `it conflicts with ${base}: rebase it on ${base} and push.`, comments); continue }
      if (state === 'blocked') { await this.tellOnce(repo, number, head, author, `GitHub's rules for ${base} block the merge. Ask your person.`, comments); continue }
      if (!['clean', 'has_hooks', 'unstable'].includes(state)) continue
      const merged = await this.deps.send('PUT', `/repos/${repo}/pulls/${number}/merge`, { merge_method: 'squash', sha: head })
      if (merged.status !== 200) {
        // A head that moved (409) or a merge GitHub refused (405) is read again next pass.
        this.reads.forget(repo)
        this.note('MERGE_REFUSED', `${repo}#${number}: GitHub answered ${merged.status}`)
        continue
      }
      const by = reads.map(([, r]) => r.name).join(' and ')
      await this.comment(repo, number, `${SELF}, ${this.clock()}: merged. READ-OK on ${head.slice(0, 7)} by ${by}, checks green.`)
      this.log(`[super-tab] merged ${repo}#${number} on ${head.slice(0, 7)} (READ-OK by ${by})`)
      this.reads.forget(repo)
    }
  }

  /** Tells the pull request's author, by name on the pull request itself, once for each head and reason. */
  /** Says once for a head why it is not merged. It names the head, and a restart finds it among the pull request's comments:
   *  remembered only in memory, every release (each restarts the PM's daemon, seven on 2026-11-10) said it again. */
  private async tellOnce(repo: string, number: number, head: string, author: string | null, what: string, comments: Json[]): Promise<void> {
    const key = `${repo}#${number}`, said = `${head}\n${what}`
    if (this.told.get(key) === said) return
    this.told.set(key, said)
    if (this.told.size > 1_000) this.told.delete(this.told.keys().next().value!)
    const line = `not merged yet at ${head.slice(0, 7)}: ${what}`
    if (comments.some(c => TEAM.has(c.author_association) && String(c.body ?? '').slice(0, 500).includes(line))) return
    await this.comment(repo, number, `${SELF}, ${this.clock()}${author ? `, to **${author}**` : ''}: ${line}`)
  }

  private async comment(repo: string, number: number, body: string): Promise<void> {
    const reply = await this.deps.send('POST', `/repos/${repo}/issues/${number}/comments`, { body })
    if (reply.status !== 201) this.note('COMMENT_FAILED', `${repo}#${number}: GitHub answered ${reply.status}`)
  }

  private clock(): string {
    const at = new Date(this.now())
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  }

  private note(code: string, detail: string): void {
    const line = code ? `${code} ${detail}` : ''
    if (line === this.logged) return
    this.logged = line
    this.log(code ? `[super-tab] merging by rule stopped · ${line}` : '[super-tab] merging by rule runs again')
  }
}
