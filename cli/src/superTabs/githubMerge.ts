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
import type { GitHubGet, GitHubSend } from './githubRest.js'
import { GitHubReads, GitHubStop, PAGE } from './githubRest.js'
import { nameKey, repositorySlug, signatureOf, signedAs, TEAM } from './githubMentions.js'
import { identifier, object } from './wire.js'

type Json = Record<string, unknown>

export const MERGE_INTERVAL_MS = 30_000
const MAX_PULLS = 30
/** How often the projects whose PM runs here are asked again: each ask reads the PM's Swarm. */
const PROJECTS_FRESH_MS = 60_000
/** A verdict as lampOS's readers write it: `READ-OK <sha>` or `HOLD <sha>`, the sha at least 7 hex digits. */
const VERDICT = /(?<![\w-])(READ-OK|HOLD)\s+([0-9a-f]{7,40})(?![0-9a-f])/
const SELF = 'Harness'

/** A project whose PM runs on this computer as its person: the merger merges its repository's pull requests, and the
 *  assigner gives its tasks (githubAssign.ts). Its Swarm, its PM and the project, to read its crew as the PM. */
export interface LedProject { repo: string; pm: string; tabId: string; pmAgentId: string; projectId: string }

/** The projects whose PM is one of this computer's person's agents running here, from the host's roster and the PM's read. */
export async function ledProjects(deps: { me: string | null; live: (harnessId: string) => boolean; roster: () => Promise<Json[]>
  read: (tabId: string, agentId: string) => Promise<Json> }): Promise<LedProject[]> {
  if (!deps.me) return []
  const found = new Map<string, LedProject>()
  for (const row of await deps.roster()) {
    const agent = object(row.agent)
    if (row.lead !== true || !identifier(row.ledConversationId) || !identifier(row.tabId) || !identifier(agent.id) || row.closeSession === true) continue
    if (agent.contributorId !== deps.me || agent.machineOwnerId !== deps.me || typeof agent.harnessId !== 'string' || !deps.live(agent.harnessId)) continue
    const state = await deps.read(row.tabId, agent.id).catch(() => null)
    const project = (Array.isArray(state?.projects) ? state.projects.map(object) : []).find(p => p.leadConversationId === row.ledConversationId)
    const repo = repositorySlug(object(project?.repository).repositoryUrl)
    if (repo && identifier(project?.id) && !found.has(repo)) {
      found.set(repo, { repo, pm: String(agent.displayName ?? agent.name ?? 'PM'), tabId: row.tabId, pmAgentId: agent.id, projectId: project.id })
    }
  }
  return [...found.values()]
}

/** What one pull request's comments say: each reader's last verdict, by its name as `nameKey` reads names, with the name as it signs, and
 *  whether it asks for two reads. A reader is its name as signed ("Juno, 14:20, to **Pip**: READ-OK f6edb44"), or its GitHub login when
 *  unsigned: "Juno" and "JUNO" are one reader, and one that signs two ways counts once. What the pull request's own [writers] signed
 *  (any of the agents its labels and branch name, whatever the length or spelling of the name) is its writer's, so a pull request's
 *  author keeps its own HOLD and lifts it, and is nobody's reader (mergeReady). */
export function verdicts(comments: Json[], body: string, writers: readonly string[] = []):
  { readers: Map<string, { verdict: 'READ-OK' | 'HOLD'; sha: string; name: string }>; twoReads: boolean } {
  const readers = new Map<string, { verdict: 'READ-OK' | 'HOLD'; sha: string; name: string; at: string }>()
  let twoReads = /\bTWO READS\b/.test(body)
  for (const comment of comments) {
    if (!TEAM.has(comment.author_association)) continue
    const first = String(comment.body ?? '').split('\n').find(line => line.trim()) ?? ''
    if (/\bTWO READS\b/.test(first)) twoReads = true
    const found = VERDICT.exec(first)
    if (!found) continue
    const name = writers.find(writer => signedAs(first, writer)) ?? signatureOf(first) ?? String(object(comment.user).login ?? '')
    const key = nameKey(name)
    if (!key || key === nameKey(SELF)) continue
    const at = String(comment.created_at ?? '')
    const last = readers.get(key)
    if (!last || at >= last.at) readers.set(key, { verdict: found[1] as 'READ-OK' | 'HOLD', sha: found[2]!, name, at })
  }
  return { readers: new Map([...readers].map(([k, v]) => [k, { verdict: v.verdict, sha: v.sha, name: v.name }])), twoReads }
}

/** The pull request's author by name: its builder label, else its branch's first part (`pip/12`). */
export function authorOf(pull: Json): string | null {
  return writersOf(pull).names[0] ?? null
}

/** Every agent a pull request names as its own, whatever its readers call it: each builder label (GitHub keeps a label's case as
 *  written, so `Builder:Pip` is one), and its branch's first part (`pip/12`). Nothing of either, the account that opened it. */
export function writersOf(pull: Json): { names: string[]; account: string } {
  const labels = (Array.isArray(pull.labels) ? pull.labels.map(object) : []).map(l => String(l.name ?? '')).filter(name => /^builder:/i.test(name))
    .map(name => name.slice('builder:'.length))
  const branch = String(object(pull.head).ref ?? '')
  return { names: [...labels, ...branch.includes('/') ? [branch.split('/')[0]!.toLowerCase()] : []], account: String(object(pull.user).login ?? '') }
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

  constructor(private readonly deps: { projects: () => Promise<LedProject[]>; get: GitHubGet; send: GitHubSend; now?: () => number
    log?: (line: string) => void; intervalMs?: number }) {
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
    const pulls = (await this.reads.current(repo, `/repos/${repo}/pulls?state=open&per_page=${MAX_PULLS}`, 1))
      .filter(pull => pull.draft !== true && object(pull.base).ref === base)
    for (const pull of pulls) {
      const number = Number(pull.number), head = String(object(pull.head).sha ?? '')
      if (!Number.isSafeInteger(number) || !/^[0-9a-f]{40}$/.test(head)) continue
      const author = authorOf(pull)
      // Nothing says which agent wrote it (no builder label, no `name/` branch): the account that opened it did.
      const { names, account } = writersOf(pull)
      const writers = names.length ? names : [account]
      const comments = await this.reads.current(repo, `/repos/${repo}/issues/${number}/comments?per_page=${PAGE}`, 3)
      const { readers, twoReads } = verdicts(comments, String(pull.body ?? ''), writers)
      if ([...readers.values()].some(r => r.verdict === 'HOLD')) continue
      const reads = [...readers].filter(([reader, r]) => r.verdict === 'READ-OK' && head.startsWith(r.sha) && !writers.some(writer => reader === nameKey(writer)))
      if (reads.length < (twoReads ? 2 : 1)) continue
      const runs = object(await this.reads.one(repo, `/repos/${repo}/commits/${head}/check-runs?per_page=${PAGE}`)).check_runs
      const checks = checksOf(Array.isArray(runs) ? runs.map(object) : [], await this.reads.one(repo, `/repos/${repo}/commits/${head}/status`))
      if (checks.state === 'running') continue
      if (checks.state === 'failed') { await this.tellOnce(repo, number, head, author, `checks failed on ${head.slice(0, 7)}: ${checks.failed.slice(0, 3).join(', ')}. Fix them and push.`); continue }
      const detail = await this.reads.one(repo, `/repos/${repo}/pulls/${number}`)
      const state = String(detail.mergeable_state ?? 'unknown')
      if (state === 'behind') { await this.tellOnce(repo, number, head, author, `it is behind ${base}: update the branch and push.`); continue }
      if (state === 'dirty') { await this.tellOnce(repo, number, head, author, `it conflicts with ${base}: rebase it on ${base} and push.`); continue }
      if (state === 'blocked') { await this.tellOnce(repo, number, head, author, `GitHub's rules for ${base} block the merge. Ask your person.`); continue }
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
  private async tellOnce(repo: string, number: number, head: string, author: string | null, what: string): Promise<void> {
    const key = `${repo}#${number}`, said = `${head}\n${what}`
    if (this.told.get(key) === said) return
    this.told.set(key, said)
    if (this.told.size > 1_000) this.told.delete(this.told.keys().next().value!)
    await this.comment(repo, number, `${SELF}, ${this.clock()}${author ? `, to **${author}**` : ''}: not merged yet: ${what}`)
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
