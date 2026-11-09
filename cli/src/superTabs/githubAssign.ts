/**
 * Harness gives a Swarm v4 team's tasks to its builders by code (anh Dee, 2026-11-09: "the assignment problem is extremely
 * important. assign to the right builder. assign to maximize optimize resource allocation", "the bottleneck is a
 * combination of cpu disk token etc.", "lets write the best algo"). The PM labels what each task touches and needs and how
 * big and urgent it is (part:, needs:, size:, p0-p2); this reads those with the project's builders and what their machines
 * last reported, plans with the solver (assign/search.ts), and gives each builder what it starts next, two deep:
 * `builder:<name>` on the issue and one line saying why. GitHub news (githubMentions.ts) then brings the task to its
 * builder. It runs where the merger runs: in the Harness of the person whose agent is the project's PM, with their gh.
 * A task its PM or a person gave by hand is never moved.
 */
import { DEEP, nextPicks, outOfQuota, readerFor, readProblem, reasonOf, takeBacks, worksOnOf, type AwayBuilder, type Crew, type Read } from './assign/crew.js'
import type { Choice } from './assign/model.js'
import { solve } from './assign/search.js'
import type { GitHubGet, GitHubSend } from './githubRest.js'
import { GitHubReads, GitHubStop, PAGE } from './githubRest.js'
import { authorOf, verdicts, type LedProject } from './githubMerge.js'

type Json = Record<string, unknown>

export const ASSIGN_INTERVAL_MS = 60_000
/** How long one plan may search: a pass every minute, so a second is ample (the night's 42 tasks plan in 0.6 s). */
const SOLVE_MS = 1_000
/** Search steps for each task, up to a ceiling: at 20 tasks the solver takes about 15,000 steps a second, at 200 about 1,300
 *  (benchmark, 2026-11-09), so a small team stops early and a large one uses the second. */
const STEPS_PER_TASK = 400, MAX_STEPS = 200_000
const SELF = 'Harness'
/** How many open pull requests are read for readers each pass, as the merger reads them. */
const MAX_PULLS = 30
/** Harness's ask of a reader, as askReaders writes it: who was asked, and for which head. */
const ASKED = /^Harness, \d\d:\d\d, to \*\*([^*]+)\*\*: [^\n]*?please read[^\n]*?READ-OK ([0-9a-f]{7,40})/

export class GitHubAssign {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private readonly reads: GitHubReads
  private readonly unreadable = new Map<string, number>()
  /** Each repository's last plan, which the next starts from so a plan changes only where it gains. */
  private readonly last = new Map<string, Choice>()
  /** Tasks given and not yet seen labelled in a read, so a pass before GitHub's lists catch up never gives one twice. */
  private readonly given = new Map<string, string>()
  /** What was said of one task (a label refused, no builder able to do it), so each is said once, not every pass. */
  private readonly said = new Set<string>()
  private projects: { at: number; list: LedProject[] } | null = null
  private offUntil = 0
  private logged = ''
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(private readonly deps: { projects: () => Promise<LedProject[]>; crew: (project: LedProject) => Promise<Crew>
    get: GitHubGet; send: GitHubSend; now?: () => number; log?: (line: string) => void; intervalMs?: number }) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (line => console.warn(line))
    this.reads = new GitHubReads(deps.get, this.now)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, this.deps.intervalMs ?? ASSIGN_INTERVAL_MS)
    this.timer.unref?.()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One pass; one still running is not started twice. */
  tick(): Promise<void> {
    this.running ??= this.pass().catch(error => this.note('FAILED', error instanceof Error ? error.message : String(error)))
      .finally(() => { this.running = null })
    return this.running
  }

  private async pass(): Promise<void> {
    if (!this.projects || this.now() - this.projects.at >= ASSIGN_INTERVAL_MS) this.projects = { at: this.now(), list: await this.deps.projects() }
    if (!this.projects.list.length || this.now() < this.offUntil) return
    try {
      for (const project of this.projects.list) {
        if ((this.unreadable.get(project.repo) ?? 0) > this.now()) continue
        try { await this.assign(project) } catch (error) {
          this.reads.forget(project.repo)
          if (error instanceof GitHubStop && error.everywhere) throw error
          if (error instanceof GitHubStop) this.unreadable.set(project.repo, error.until)
          this.note(error instanceof GitHubStop ? error.code : 'ASSIGN_FAILED', `${project.repo}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      this.note('', '')
    } catch (error) {
      if (!(error instanceof GitHubStop)) throw error
      this.offUntil = error.until
      this.note(error.code, error.message)
    }
  }

  private async assign(project: LedProject): Promise<void> {
    const { repo } = project
    const issues = await this.reads.current(repo, `/repos/${repo}/issues?state=open&per_page=${PAGE}`, 3)
    // A task GitHub now shows labelled is no longer one this pass may have given and not yet seen.
    for (const issue of issues) {
      const key = `${repo}#${issue.number}`
      if (this.given.has(key) && labelNames(issue).some(name => name.startsWith('builder:'))) this.given.delete(key)
    }
    const crew = await this.deps.crew(project)
    await this.takeBack(repo, issues, crew.away ?? [])
    // What each builder works on in this project: the Works on line of its instructions file here (agents/<Name>.md).
    for (const builder of crew.builders) builder.worksOn = worksOnOf(await this.reads.file(repo, `agents/${builder.name}.md`))
    await this.labelAreas(repo, crew)
    const read = readProblem({ now: this.now(), issues: issues.filter(issue => !this.given.has(`${repo}#${issue.number}`)),
      closed: await this.reads.current(repo, `/repos/${repo}/issues?state=closed&sort=updated&direction=desc&per_page=${PAGE}`, 1),
      crew })
    if (!read.problem.builders.length) return
    await this.takeBack(repo, issues, outOfQuota(read))
    await this.askReaders(project, read)
    if (!read.free.size) return
    // Nobody can take a task while every list is full: no plan, so a backlog costs no CPU each minute (the daemon at rest
    // keeps under 1% of a core).
    if (![...read.open.values()].some(count => count < DEEP)) return
    // As many steps as the problem is worth, within the second: a few thousand for a small team, the whole second for a large.
    const solved = solve(read.problem, { budgetMs: SOLVE_MS, iterations: Math.min(MAX_STEPS, STEPS_PER_TASK * read.problem.tasks.length), seed: 1,
      ...(this.last.has(repo) ? { start: this.last.get(repo) } : {}) })
    this.last.set(repo, solved.choice)
    for (const pick of nextPicks(solved.plan, read)) await this.give(project, read, pick)
    for (const { task, why } of solved.plan.unplaced) if (read.free.has(task)) this.once(`[super-tab] Task assignment: UNPLACED ${repo}${task}: ${why}`)
  }

  /**
   * Takes back the tasks of builders that cannot work (anh Dee's plan, 2026-11-09: "when a builder stops, stalls or runs
   * out of quota, Harness takes the task back and gives it to the next best builder"): their builder label, and
   * status:taken when it was taken, come off, with one line of why; the next plan gives each to another builder. Once a
   * task, as the label is gone from the next read.
   */
  private async takeBack(repo: string, issues: Json[], away: AwayBuilder[]): Promise<void> {
    if (!away.length) return
    for (const back of takeBacks(issues, away, this.now())) {
      const key = `${repo}#${back.number}:back:${back.label}`
      if (this.said.has(key)) continue
      this.said.add(key)
      for (const label of [back.label, ...back.taken ? ['status:taken'] : []]) {
        await this.deps.send('DELETE', `/repos/${repo}/issues/${back.number}/labels/${encodeURIComponent(label)}`)
      }
      await this.deps.send('POST', `/repos/${repo}/issues/${back.number}/comments`,
        { body: `${SELF}, ${this.clock()}: ${back.why}, so this task goes to the builder who can start it next.` })
      this.log(`[super-tab] took ${repo}#${back.number} back: ${back.why}`)
    }
  }

  /** Makes the `part:` label of each area a builder works on that the repository does not have yet, so its PM labels tasks
   *  with the same words (anh Dee, 2026-11-09: "how does github label get populated if we enter a new label"). Once each. */
  private async labelAreas(repo: string, crew: Crew): Promise<void> {
    const areas = [...new Set(crew.builders.flatMap(b => b.worksOn ?? []))]
    if (!areas.length) return
    const have = new Set((await this.reads.current(repo, `/repos/${repo}/labels?per_page=${PAGE}`, 3)).map(label => String(label.name ?? '').toLowerCase()))
    for (const area of areas) {
      const name = `part:${area}`, key = `${repo}:${name}`
      if (have.has(name) || this.said.has(key)) continue
      this.said.add(key)
      const made = await this.deps.send('POST', `/repos/${repo}/labels`, { name, color: 'c5def5', description: 'An area of the project' })
      // 422: someone made it since the list was read.
      if (made.status === 201 || made.status === 422) this.log(`[super-tab] made the label ${name} in ${repo}`)
      else this.once(`[super-tab] Task assignment: LABEL_NOT_MADE ${repo} ${name}: GitHub answered ${made.status}`)
    }
  }

  /**
   * Asks a reader for each open pull request into the default branch that needs one (Swarm v4: a builder no longer picks
   * its own): a READ-OK on its head from someone other than its author, two for TWO READS. A reader asked and not yet
   * answered is still reading. A verdict on an older head no longer counts, and a HOLD on one still blocks the merge
   * (githubMerge.ts), so its reader is asked to read the new head, once. Nothing while a HOLD stands on the head itself: its
   * author fixes first. Each ask is one comment naming the reader, which GitHub news brings it (githubMentions.ts).
   */
  private async askReaders(project: LedProject, read: Read): Promise<void> {
    const { repo } = project
    const base = String((await this.reads.one(repo, `/repos/${repo}`)).default_branch ?? '')
    const pulls = (await this.reads.current(repo, `/repos/${repo}/pulls?state=open&per_page=${MAX_PULLS}`, 1))
      .filter(pull => pull.draft !== true && String((pull.base as Json | undefined)?.ref ?? '') === base)
    for (const pull of pulls) {
      const number = Number(pull.number), head = String((pull.head as Json | undefined)?.sha ?? '')
      if (!Number.isSafeInteger(number) || !/^[0-9a-f]{40}$/.test(head)) continue
      const comments = await this.reads.current(repo, `/repos/${repo}/issues/${number}/comments?per_page=${PAGE}`, 3)
      const { readers, twoReads } = verdicts(comments, String(pull.body ?? ''))
      const author = authorOf(pull)
      const onHead = (sha: string) => head.startsWith(sha)
      if ([...readers.values()].some(r => r.verdict === 'HOLD' && onHead(r.sha))) continue
      // Who Harness asked, for which heads.
      const asked = new Map<string, Set<string>>()
      for (const c of comments) {
        const found = ASKED.exec(String(c.body ?? ''))
        if (found) asked.set(found[1]!.toLowerCase(), new Set([...asked.get(found[1]!.toLowerCase()) ?? [], found[2]!]))
      }
      const ok = [...readers].filter(([reader, r]) => reader !== author && r.verdict === 'READ-OK' && onHead(r.sha)).map(([reader]) => reader)
      const stale = [...readers].filter(([reader, r]) => reader !== author && !onHead(r.sha))
      const waiting = [...asked.keys()].filter(name => !readers.has(name))
      for (const [reader, r] of stale) {
        if ([...asked.get(reader) ?? []].some(onHead)) continue
        const builder = [...read.builders.values()].find(b => b.name.toLowerCase() === reader)
        await this.ask(repo, number, head, builder?.name ?? reader, `the head is now ${head.slice(0, 7)}, after your ${r.verdict} on ${r.sha.slice(0, 7)}: please read it again`)
      }
      let need = (twoReads ? 2 : 1) - ok.length - stale.length - waiting.length
      const skip = new Set([...asked.keys(), ...readers.keys()])
      while (need-- > 0) {
        const reader = readerFor(read, author, skip)
        if (!reader) { this.once(`[super-tab] Task assignment: NO_READER ${repo}#${number}: no builder of the team but its author can read it`); break }
        skip.add(reader.id)
        await this.ask(repo, number, head, reader.name, 'please read this pull request')
      }
    }
  }

  /** One ask of a reader, once per pull request, head and reader: a comment naming it, with the head it reads. */
  private async ask(repo: string, number: number, head: string, name: string, what: string): Promise<void> {
    const key = `${repo}#${number}@${head}:${name.toLowerCase()}`
    if (this.said.has(key)) return
    this.said.add(key)
    await this.deps.send('POST', `/repos/${repo}/issues/${number}/comments`, { body: `${SELF}, ${this.clock()}, to **${name}**: ${what}, `
      + `and start your comment with READ-OK ${head.slice(0, 7)} or HOLD ${head.slice(0, 7)} (with the file, line and fix).` })
    this.log(`[super-tab] asked ${name} to read ${repo}#${number} at ${head.slice(0, 7)}`)
  }

  /** Labels the task for its builder and says why on it, as Harness, in its PM's person's name. */
  private async give(project: LedProject, read: Read, pick: { task: string; builder: string; start: number }): Promise<void> {
    const builder = read.builders.get(pick.builder)
    const number = Number(pick.task.slice(1))
    if (!builder || !Number.isSafeInteger(number)) return
    const { name, label } = builder
    const labelled = await this.deps.send('POST', `/repos/${project.repo}/issues/${number}/labels`, { labels: [label] })
    if (labelled.status !== 200) {
      this.once(`[super-tab] Task assignment: LABEL_REFUSED ${project.repo}#${number}: GitHub answered ${labelled.status}`)
      return
    }
    this.given.set(`${project.repo}#${number}`, label)
    await this.deps.send('POST', `/repos/${project.repo}/issues/${number}/comments`,
      { body: `${SELF}, ${this.clock()}: for **${name}**: ${reasonOf(pick, read)}.` })
    this.log(`[super-tab] gave ${project.repo}#${number} to ${name} (${reasonOf(pick, read)})`)
  }

  private clock(): string {
    const at = new Date(this.now())
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  }

  /** Says [line] the first time only; the memory is bounded, oldest first. */
  private once(line: string): void {
    if (this.said.has(line)) return
    this.said.add(line)
    if (this.said.size > 500) this.said.delete(this.said.values().next().value!)
    this.log(line)
  }

  /** Says a failure once until it changes, and once that it has passed. */
  private note(code: string, detail: string): void {
    const line = code ? `${code} ${detail}` : ''
    if (line === this.logged) return
    this.logged = line
    this.log(code ? `[super-tab] Task assignment stopped · ${line}` : '[super-tab] Task assignment runs again')
  }
}

const labelNames = (issue: Json): string[] =>
  (Array.isArray(issue.labels) ? issue.labels : []).map(label => String((label as Json)?.name ?? ''))
