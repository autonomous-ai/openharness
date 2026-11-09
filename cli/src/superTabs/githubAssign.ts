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
import { DEEP, nextPicks, readProblem, reasonOf, type Crew, type Read } from './assign/crew.js'
import type { Choice } from './assign/model.js'
import { solve } from './assign/search.js'
import type { GitHubGet, GitHubSend } from './githubRest.js'
import { GitHubReads, GitHubStop, PAGE } from './githubRest.js'
import type { LedProject } from './githubMerge.js'

type Json = Record<string, unknown>

export const ASSIGN_INTERVAL_MS = 60_000
/** How long one plan may search: a pass every minute, so a second is ample (the night's 42 tasks plan in 0.6 s). */
const SOLVE_MS = 1_000
/** Search steps for each task, up to a ceiling: at 20 tasks the solver takes about 15,000 steps a second, at 200 about 1,300
 *  (benchmark, 2026-11-09), so a small team stops early and a large one uses the second. */
const STEPS_PER_TASK = 400, MAX_STEPS = 200_000
const SELF = 'Harness'

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
    const read = readProblem({ now: this.now(), issues: issues.filter(issue => !this.given.has(`${repo}#${issue.number}`)),
      closed: await this.reads.current(repo, `/repos/${repo}/issues?state=closed&sort=updated&direction=desc&per_page=${PAGE}`, 1),
      crew: await this.deps.crew(project) })
    if (!read.free.size || !read.problem.builders.length) return
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
