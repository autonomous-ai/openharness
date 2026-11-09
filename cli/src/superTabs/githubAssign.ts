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
import { DEEP, labelOf, nextPicks, outOfQuota, teamOf, QUIET_ASK_MS, QUIET_BACK_MS, learnedMinutes, readerFor, readProblem, reasonOf, startedAt, takeBacks, takenTasks, tasksOf, worksOnOf, type AwayBuilder, type Crew, type Read } from './assign/crew.js'
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
/** Closed tasks whose time is read each pass, and how many are remembered: a slow start, never a slow pass. */
const MEASURES_PER_PASS = 5, MAX_MEASURED = 500
/** How many open pull requests are read for readers each pass, as the merger reads them. */
const MAX_PULLS = 30
/** How long a reader asked for a head has to read it before another reader is asked too. */
const READ_WAIT_MS = 2 * 60 * 60_000
/** How Harness's ask about a quiet task begins, after the builder's name: a restart finds it by these words. */
const QUIET_ASKED = 'nothing has moved on this task for '
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
  /** Each quiet taken task its builder was asked about: since when it was quiet, and when it was asked. */
  private readonly quiet = new Map<string, { since: number; askedAt: number }>()
  /** Each finished task's size and the minutes its work took, by repository and issue; null when it cannot be told. */
  private readonly took = new Map<string, { size: string; minutes: number } | null>()
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
    const listed = await this.reads.current(repo, `/repos/${repo}/issues?state=open&per_page=${PAGE}`, 3)
    // A task given and not yet shown labelled (GitHub's lists can lag) is read with its label, so it counts in its builder's
    // list and is never given twice; once shown, or closed, it is forgotten.
    const open = new Set(listed.map(issue => `${repo}#${issue.number}`))
    for (const key of [...this.given.keys()]) if (key.startsWith(`${repo}#`) && !open.has(key)) this.given.delete(key)
    const issues = listed.map(issue => {
      const key = `${repo}#${issue.number}`, label = this.given.get(key)
      if (!label) return issue
      if (labelNames(issue).some(name => name.startsWith('builder:'))) { this.given.delete(key); return issue }
      return { ...issue, labels: [...(Array.isArray(issue.labels) ? issue.labels : []), { name: label }] }
    })
    const crew = await this.deps.crew(project)
    await this.takeBack(repo, issues, crew.away ?? [])
    // What each builder works on in this project: the Works on line of its instructions file here (agents/<Name>.md).
    for (const builder of crew.builders) builder.worksOn = worksOnOf(await this.reads.file(repo, `agents/${builder.name}.md`))
    await this.labelAreas(repo, crew)
    const closed = await this.reads.current(repo, `/repos/${repo}/issues?state=closed&sort=updated&direction=desc&per_page=${PAGE}`, 1)
    await this.measure(repo, closed)
    const minutes = learnedMinutes([...this.took].filter(([key, took]) => key.startsWith(`${repo}#`) && took).map(([, took]) => took!))
    const read = readProblem({ now: this.now(), issues, closed, crew, minutes })
    if (!read.problem.builders.length) return
    // Only while another builder has room: a team's one builder would be given its task straight back.
    const short = outOfQuota(read)
    if (short.length < read.problem.builders.length) await this.takeBack(repo, issues, short)
    // Open pull requests, drafts included: a draft is where a task's work shows before it is read.
    const pulls = await this.reads.current(repo, `/repos/${repo}/pulls?state=open&per_page=${MAX_PULLS}`, 1)
    const withReaders = await this.askReaders(project, read, pulls, crew)
    await this.askQuiet(repo, issues, pulls, crew, withReaders)
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
  private async takeBack(repo: string, issues: Json[], away: AwayBuilder[], why?: string): Promise<void> {
    if (!away.length) return
    for (const back of takeBacks(issues, away, this.now()).map(b => why ? { ...b, why } : b)) {
      const key = `${repo}#${back.number}:back:${back.label}`
      if (this.said.has(key)) continue
      // status:taken first: a task left taken with no builder is one nobody plans (readProblem), while one left queued for
      // its builder is taken back again next pass. A label already gone is off; anything else GitHub refuses is said, and
      // tried again next pass.
      let refused = 0
      for (const label of [...back.taken ? ['status:taken'] : [], back.label]) {
        const reply = await this.deps.send('DELETE', `/repos/${repo}/issues/${back.number}/labels/${encodeURIComponent(label)}`)
        if (reply.status !== 200 && reply.status !== 404) { refused = reply.status; break }
      }
      if (refused) { this.once(`[super-tab] Task assignment: TAKE_BACK_REFUSED ${repo}#${back.number}: GitHub answered ${refused}`); continue }
      this.said.add(key)
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
  private async askReaders(project: LedProject, read: Read, open: Json[], crew: Crew): Promise<Set<number>> {
    const { repo } = project
    const team = teamOf(crew, project.pm)
    // The tasks whose pull request waits for its readers or its merge, not for its builder (askQuiet).
    const withReaders = new Set<number>()
    const base = String((await this.reads.one(repo, `/repos/${repo}`)).default_branch ?? '')
    const pulls = open.filter(pull => pull.draft !== true && String((pull.base as Json | undefined)?.ref ?? '') === base)
    for (const pull of pulls) {
      const number = Number(pull.number), head = String((pull.head as Json | undefined)?.sha ?? '')
      if (!Number.isSafeInteger(number) || !/^[0-9a-f]{40}$/.test(head)) continue
      const author = authorOf(pull)
      if (author === null || !team.has(labelOf(author))) continue
      const comments = await this.reads.current(repo, `/repos/${repo}/issues/${number}/comments?per_page=${PAGE}`, 3)
      const { readers, twoReads } = verdicts(comments, String(pull.body ?? ''))
      const onHead = (sha: string) => head.startsWith(sha)
      if ([...readers.values()].some(r => r.verdict === 'HOLD' && onHead(r.sha))) continue
      for (const task of tasksOf(pull)) withReaders.add(task)
      // Who Harness asked, for which heads, and when.
      const now = this.now()
      const asked = new Map<string, Map<string, number>>()
      for (const c of comments) {
        const found = ASKED.exec(String(c.body ?? ''))
        if (!found) continue
        const heads = asked.get(found[1]!.toLowerCase()) ?? new Map<string, number>()
        // GitHub dates every comment; one it did not is taken as asked now, as before.
        const at = Date.parse(String(c.created_at ?? ''))
        heads.set(found[2]!, Math.max(heads.get(found[2]!) ?? 0, Number.isFinite(at) ? at : now))
        asked.set(found[1]!.toLowerCase(), heads)
      }
      // A reader asked [READ_WAIT_MS] ago with no verdict since is no longer counted on: another is asked too, and the first
      // READ-OK on the head counts, whoever's. Agents read within minutes of the ask that wakes them, so one that has not is
      // stopped or stuck, and its pull request would wait on it for ever. A reader whose verdict is on an older head is
      // measured from its ask for this head; one that never gave one, from its last ask.
      const lastAsk = (name: string, thisHead: boolean) =>
        Math.max(0, ...[...asked.get(name) ?? []].filter(([sha]) => !thisHead || onHead(sha)).map(([, at]) => at))
      const ok = [...readers].filter(([reader, r]) => reader !== author && r.verdict === 'READ-OK' && onHead(r.sha)).map(([reader]) => reader)
      const stale = [...readers].filter(([reader, r]) => reader !== author && !onHead(r.sha))
      const waiting = [...asked.keys()].filter(name => !readers.has(name) && now - lastAsk(name, false) < READ_WAIT_MS)
      for (const [reader, r] of stale) {
        if (lastAsk(reader, true)) continue
        await this.ask(repo, number, head, r.name, `the head is now ${head.slice(0, 7)}, after your ${r.verdict} on ${r.sha.slice(0, 7)}: please read it again`)
      }
      // A stale reader not asked again yet is asked just now, above.
      const rereading = stale.filter(([reader]) => { const at = lastAsk(reader, true); return at === 0 || now - at < READ_WAIT_MS })
      let need = (twoReads ? 2 : 1) - ok.length - rereading.length - waiting.length
      const skip = new Set([...asked.keys(), ...readers.keys()])
      while (need-- > 0) {
        // A team of one builder still has its PM, who read for it before Harness asked readers (the swarm-sandbox, where
        // Juno, its PM, read every pull request of Pip's).
        const builder = readerFor(read, author, skip)
        const pm = project.pm.toLowerCase()
        const reader = builder ?? (pm !== author && !skip.has(pm) ? { id: pm, name: project.pm } : null)
        if (!reader) { this.once(`[super-tab] Task assignment: NO_READER ${repo}#${number}: nobody but its author can read it`); break }
        skip.add(reader.id)
        skip.add(reader.name.toLowerCase())
        await this.ask(repo, number, head, reader.name, 'please read this pull request')
      }
    }
    return withReaders
  }

  /** Learns how long finished tasks took: for a few closed sized issues a pass not measured yet, from its builder's
   *  "taken by" to its close. A closed issue does not change, so each is read once; the memory keeps the last few hundred. */
  private async measure(repo: string, closed: Json[]): Promise<void> {
    let reads = 0
    for (const issue of closed) {
      const key = `${repo}#${issue.number}`
      const size = labelNames(issue).find(name => /^size:[sml]$/.test(name))?.slice('size:'.length)
      if (issue.pull_request || !size || this.took.has(key)) continue
      if (reads++ >= MEASURES_PER_PASS) break
      const comments = await this.reads.current(repo, `/repos/${repo}/issues/${issue.number}/comments?per_page=${PAGE}`, 1)
      const began = startedAt(comments), ended = Date.parse(String(issue.closed_at ?? ''))
      this.took.set(key, began !== null && Number.isFinite(ended) && ended > began ? { size, minutes: (ended - began) / 60_000 } : null)
      if (this.took.size > MAX_MEASURED) this.took.delete(this.took.keys().next().value!)
    }
  }

  /**
   * A task its builder took and nothing touched for [QUIET_ASK_MS] gets one ask of its builder by name, which GitHub news
   * brings it; quiet for [QUIET_BACK_MS] after that, it goes to another builder. Harness's own ask is no activity; an
   * answer, a push or a label is.
   */
  private async askQuiet(repo: string, issues: Json[], pulls: Json[], crew: Crew, withReaders: ReadonlySet<number>): Promise<void> {
    const now = this.now()
    // A task whose pull request waits for its readers or its merge is not its builder's to move (askReaders); the
    // sandbox's dry run asked Pip about #16 while its pull request had its READ-OK, minutes before Harness merged it.
    const taken = takenTasks(issues, pulls, crew.builders).filter(task => !withReaders.has(task.number))
    const open = new Set(taken.map(t => `${repo}#${t.number}`))
    for (const key of [...this.quiet.keys()]) if (key.startsWith(`${repo}#`) && !open.has(key)) this.quiet.delete(key)
    for (const task of taken) {
      // A task GitHub gave no time for is never called quiet.
      if (task.touched <= 0) continue
      const key = `${repo}#${task.number}`
      let asked = this.quiet.get(key)
      // Touched after the ask (allowing the ask itself, written a moment after it was decided): it is moving again.
      if (asked && task.touched > asked.askedAt + 2 * 60_000) { this.quiet.delete(key); asked = undefined }
      const since = asked?.since ?? task.touched
      if (!asked && now - since >= QUIET_ASK_MS) {
        // Asked before this daemon restarted (a release restarts every PM's): the ask is then the issue's last touch.
        const before = await this.quietAskedAt(repo, task.number, task.name, task.touched)
        if (before !== null) { asked = { since: before - QUIET_ASK_MS, askedAt: before }; this.quiet.set(key, asked) }
      }
      if (asked && now - asked.askedAt >= QUIET_BACK_MS - QUIET_ASK_MS && now - asked.since >= QUIET_BACK_MS) {
        // A team's one builder keeps it: there is nobody else to give it to.
        if (!crew.builders.some(b => b.label !== task.label)) continue
        this.quiet.delete(key)
        await this.takeBack(repo, issues.filter(issue => Number(issue.number) === task.number),
          [{ name: task.name, label: task.label, why: 'stopping' }], `${task.name} has had no activity on it since it was asked`)
      } else if (!asked && now - since >= QUIET_ASK_MS) {
        const reply = await this.deps.send('POST', `/repos/${repo}/issues/${task.number}/comments`, { body: `${SELF}, ${this.clock()}, to **${task.name}**: `
          + `${QUIET_ASKED}${Math.round((now - since) / 3_600_000)} h. Are you still on it? Say where it stands, or what you need.`
          // A team's one builder keeps it (below), so it is told no other will take it.
          + (crew.builders.some(b => b.label !== task.label) ? ` With no word in ${Math.round((QUIET_BACK_MS - QUIET_ASK_MS) / 3_600_000)} h it goes to another builder.` : '') })
        if (reply.status >= 300) { this.once(`[super-tab] Task assignment: ASK_REFUSED ${repo}#${task.number}: GitHub answered ${reply.status}`); continue }
        this.quiet.set(key, { since, askedAt: now })
        this.log(`[super-tab] asked ${task.name} about quiet ${repo}#${task.number}`)
      }
    }
  }

  /** When Harness asked [name] about quiet task [number], if that ask is its last touch (the comments since [touched]). */
  private async quietAskedAt(repo: string, number: number, name: string, touched: number): Promise<number | null> {
    const since = new Date(touched - 60_000).toISOString()
    const comments = await this.reads.current(repo, `/repos/${repo}/issues/${number}/comments?since=${since}&per_page=${PAGE}`, 1)
    const asks = comments.filter(c => {
      const found = /^Harness, \d\d:\d\d, to \*\*([^*]+)\*\*: (.*)$/m.exec(String(c.body ?? ''))
      return found?.[1]?.toLowerCase() === name.toLowerCase() && found[2]!.startsWith(QUIET_ASKED)
    }).map(c => Date.parse(String(c.created_at ?? ''))).filter(Number.isFinite)
    return asks.length ? Math.max(...asks) : null
  }

  /** One ask of a reader, once per pull request, head and reader: a comment naming it, with the head it reads. One GitHub
   *  refuses is said, and asked again next pass. */
  private async ask(repo: string, number: number, head: string, name: string, what: string): Promise<void> {
    const key = `${repo}#${number}@${head}:${name.toLowerCase()}`
    if (this.said.has(key)) return
    const reply = await this.deps.send('POST', `/repos/${repo}/issues/${number}/comments`, { body: `${SELF}, ${this.clock()}, to **${name}**: ${what}, `
      + `and start your comment with READ-OK ${head.slice(0, 7)} or HOLD ${head.slice(0, 7)} (with the file, line and fix).` })
    if (reply.status >= 300) { this.once(`[super-tab] Task assignment: ASK_REFUSED ${repo}#${number}: GitHub answered ${reply.status}`); return }
    this.said.add(key)
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
