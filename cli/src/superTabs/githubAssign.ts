/**
 * Harness gives a Swarm v4 team's tasks to its builders by code (anh Dee, 2026-11-09: "the assignment problem is extremely
 * important. assign to the right builder. assign to maximize optimize resource allocation", "the bottleneck is a
 * combination of cpu disk token etc.", "lets write the best algo"). The PM labels what each task touches and needs and how
 * big and urgent it is (part:, needs:, size:, p0-p2); this reads those with the project's builders and what their machines
 * last reported, plans with the solver (assign/search.ts), and gives each builder with nothing to build what it starts next
 * (one task at a time, four open at most: assign/crew.ts hasRoom): `builder:<name>` on the issue and one line saying why.
 * GitHub news (githubMentions.ts) then brings the task to its
 * builder. It runs where the merger runs: in the Harness of the person whose agent is the project's PM, running or stopped there, with their gh.
 * A task its PM or a person gave by hand is never moved.
 */
import { addElsewhere, areaOf, ASKED, buildingIn, builtOn, dependsOn, hasRoom, heldTasks, labelOf, machineHas, nextPicks, openPieces, outOfQuota, teamOf, QUIET_ASK_MS, QUIET_BACK_MS, learnedMinutes, readerFor, readerKey, readProblem, reasonOf, startedAt, takeBacks, takenTasks, tasksOf, worksOnOf, type AwayBuilder, type Crew, type CrewBuilder, type Pick, type Read, type Up } from './assign/crew.js'
import type { Choice } from './assign/model.js'
import { solve } from './assign/search.js'
import type { GitHubGet, GitHubSend } from './githubRest.js'
import { GitHubReads, GitHubStop, PAGE, Waits } from './githubRest.js'
import { authorOf, FailingHeads, isHeld, isWriter, openPullsPath, PULL_PAGES, pullPeople, pullTalk, RECORD_SETTLE_MS, sameChange, verdicts, type LedProject, type VerdictRecords } from './githubMerge.js'
import { repositorySlug, TEAM } from './githubMentions.js'
import { goalOf, type Score } from './goal.js'
import { numbersOf, type DayBoard, type Numbers } from './pmNumbers.js'
import { boardOf, boardWords } from './scoreboard.js'

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
/** The labels the team's flow uses (lib/swarmSkills.ts SWARM_BASICS, PM_BASICS), made where a repository lacks them: gh
 *  refuses to add a label the repository does not have, so in a fresh repository a builder could not take its first task,
 *  nor the PM size one. */
const FLOW_LABELS: ReadonlyArray<{ name: string; color: string; description: string }> = [
  { name: 'status:taken', color: '0e8a16', description: 'A builder is on it' },
  { name: 'size:s', color: 'c2e0c6', description: 'About half an hour of work' },
  { name: 'size:m', color: 'c2e0c6', description: 'About an hour and a half of work' },
  { name: 'size:l', color: 'c2e0c6', description: 'About four hours of work' },
  { name: 'p0', color: 'b60205', description: 'First' },
  { name: 'p1', color: 'd93f0b', description: 'Next' },
  { name: 'p2', color: 'fbca04', description: 'Later' },
]
/** How long a task Harness gave may wait for its builder, untaken, while another builder of the team has nothing (Swarm plan,
 *  step 1, item 6: "Nobody waits on it: a task not taken in 10 minutes is open to any agent with room"). */
const WAIT_TAKE_MS = 10 * 60_000
/** Pages of a hundred open issues and pull requests read each pass: a list that fills them is said (TOO_MANY_OPEN). */
const ISSUE_PAGES = 10
/** The most of the Swarm's other projects whose repositories are read each pass for what this project's builders build there:
 *  a Swarm has a handful today, and the server allows it a hundred. Past these, its builders count as building nothing in the
 *  rest, which is said once (OTHER_PROJECTS). */
const OTHER_PROJECTS = 10
/** Pages of a repository's newest open items a builder whose label has a comma is looked for among (listOf), as a claim does. */
const COMMA_PAGES = 3
/** How long a builder found building in another project goes before it is read again when a task is about to be given to it:
 *  the plan's estimate of that work can be four hours (a large task only given), and one that finished it early sat with
 *  nothing beside free tasks until then (review of #4144). Its busy time in the plan stays the estimate. */
const RECHECK_MS = 15 * 60_000
/** How long a reader asked for a head has to read it before another reader is asked too, or, with no other, it again; and
 *  how many asks one reader gets for one head. Thirty minutes (Swarm plan, step 1, item 1: "No verdict in 30 minutes: another is
 *  asked"; lampOS's first verdict came at 6 minutes at the median and 37 at p90): two hours until 11-11, and v4's sandbox #27
 *  waited four on two readers who never answered. A reader's turn that ends without its read is typed it too (nextThing.ts). */
const READ_WAIT_MS = 30 * 60_000, READ_ASKS = 3
/** How far back a word to a builder that its task's pieces are closed is looked for after a restart. */
const PIECES_SAID_MS = 24 * 60 * 60_000
/** How Harness's ask about a quiet task begins, after the builder's name: a restart finds it by these words. */
const QUIET_ASKED = 'nothing has moved on this task for '
export class GitHubAssign {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private readonly reads: GitHubReads
  private readonly unreadable = new Map<string, number>()
  /** Each repository's last plan, which the next starts from so a plan changes only where it gains. */
  private readonly last = new Map<string, Choice>()
  /** Tasks given and not yet seen labelled in a read, so a pass before GitHub's lists catch up never gives one twice. */
  private readonly given = new Map<string, string>()
  /** The labels each repository has, or was asked to make, as `repo:name` (labelRepo). */
  private readonly labels = new Set<string>()
  /** The take backs and the readers' asks made, by task or pull request (`repo#N`), so each is made once; forgotten once
   *  the task or pull request is no longer open, so the memory stays as large as the open work. */
  private readonly backs = new Set<string>()
  private readonly asks = new Set<string>()
  /** The tasks nobody could start whose PM was told why, by task and reason (sayBlocked), forgotten as the others are. */
  private readonly blocked = new Set<string>()
  /** The tasks whose builder was told their pieces are closed, since they last waited on them (sayPiecesDone); and when each
   *  task last waited on its pieces or had that said, from which its quiet is counted (askQuiet). Forgotten as tasks close. */
  private readonly pieces = new Set<string>()
  private readonly waited = new Map<string, number>()
  /** What commits change, as the merger reads it (sameChange), so a verdict both count is one neither asks again. */
  private readonly patches = new Map<string, unknown>()
  /** What was said of one task (a label refused, no builder able to do it), so each is said once, not every pass. */
  private readonly said = new Set<string>()
  /** Each quiet taken task its builder was asked about: since when it was quiet, and when it was asked. */
  private readonly quiet = new Map<string, { since: number; askedAt: number }>()
  /** Each finished task's size and the minutes its work took, by repository and issue; null when it cannot be told. */
  private readonly took = new Map<string, { size: string; minutes: number } | null>()
  /** How long each of the Swarm's other repositories that could not be read is left alone. */
  private readonly unreadOthers = new Waits()
  /** What each builder was found building in the Swarm's other projects as a pass of a project was about to give it a task, by
   *  `<project's repository> <label>`: how many tasks, until when the plan counts it busy with them, and when it is read again.
   *  Forgotten then, or when it is no builder of that project's any more. */
  private readonly away = new Map<string, { tasks: number; until: number; recheck: number }>()
  /** Each builder's own list in a repository as this pass read it, by `<repository> <label>`: one computer leading several of a
   *  Swarm's projects reads each once a pass. */
  private readonly fresh = new Map<string, Promise<Json[]>>()
  private projects: { at: number; list: LedProject[] } | null = null
  private offUntil = 0
  private logged = ''
  private readonly now: () => number
  private readonly log: (line: string) => void

  private readonly failing: FailingHeads
  constructor(private readonly deps: { projects: () => Promise<LedProject[]>; crew: (project: LedProject) => Promise<Crew>
    /** The repositories of [project]'s Swarm's projects, as its PM's person reads the Swarm (swarmRepositories): its builders
     *  may build in each. The PM's own read shows only its own project. */
    repositories: (project: LedProject) => Promise<string[]>
    get: GitHubGet; send: GitHubSend; now?: () => number; log?: (line: string) => void; intervalMs?: number
    /** Who made each verdict by command, the merger's own (githubMerge.ts VerdictRecords): only such a READ-OK is a read. */
    records: VerdictRecords
    /** Whether [project]'s PM runs here now: GitHub news brings an agent what is said only while it runs (githubMentions.ts), so a
     *  PM asked while stopped never hears it (the swarm-sandbox, 2026-11-10: Juno, its PM and only reader). */
    pmRunning: (project: LedProject) => Promise<boolean>
    /** Takes what a pass counted of a project, for its PM and its people, and how to read its goal and what its day's
     *  scoreboard says when a line says them, with the files most landings touch, which it keeps (pmNumbers.ts PmNumbers). */
    numbers: { pass: (project: LedProject, numbers: Numbers, goal: () => Promise<Score | null>, board: () => Promise<DayBoard>) => Promise<void> } }) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (line => console.warn(line))
    this.reads = new GitHubReads(deps.get, this.now)
    this.failing = new FailingHeads(this.reads, this.now, this.log)
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
    this.fresh.clear()
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
    const listed = await this.reads.current(repo, `/repos/${repo}/issues?state=open&per_page=${PAGE}`, ISSUE_PAGES)
    // GitHub's list of issues counts the pull requests too: lampOS had 155 issues and 104 pull requests open (2026-11-10), 259 of
    // the 300 three pages held. Past the last page the oldest tasks would drop out of the plan, so a list that fills it is said.
    if (listed.length >= ISSUE_PAGES * PAGE) this.once(`[super-tab] Task assignment: TOO_MANY_OPEN ${repo}: the newest ${listed.length} open issues and pull requests are planned`)
    // A task given and not yet shown labelled (GitHub's lists can lag) is read with its label, so it counts in its builder's
    // list and is never given twice; once shown, or closed, it is forgotten.
    const open = new Set(listed.map(issue => `${repo}#${issue.number}`))
    for (const key of [...this.given.keys()]) if (key.startsWith(`${repo}#`) && !open.has(key)) this.given.delete(key)
    for (const key of [...this.backs]) if (key.startsWith(`${repo}#`) && !open.has(key.slice(0, key.indexOf(':back:')))) this.backs.delete(key)
    for (const key of [...this.blocked]) if (key.startsWith(`${repo}#`) && !open.has(key.slice(0, key.indexOf(':blocked:')))) this.blocked.delete(key)
    for (const key of [...this.pieces, ...this.waited.keys()]) if (key.startsWith(`${repo}#`) && !open.has(key)) { this.pieces.delete(key); this.waited.delete(key) }
    const issues = listed.map(issue => {
      const key = `${repo}#${issue.number}`, label = this.given.get(key)
      if (!label) return issue
      if (labelNames(issue).some(name => name.startsWith('builder:'))) { this.given.delete(key); return issue }
      return { ...issue, labels: [...(Array.isArray(issue.labels) ? issue.labels : []), { name: label }] }
    })
    const crew = await this.deps.crew(project)
    // What each builder works on in this project: the Works on line of its instructions file here (agents/<Name>.md).
    for (const builder of crew.builders) builder.worksOn = worksOnOf(await this.reads.file(repo, `agents/${builder.name}.md`))
    await this.labelRepo(repo, crew)
    const closed = await this.reads.current(repo, `/repos/${repo}/issues?state=closed&sort=updated&direction=desc&per_page=${PAGE}`, 1)
    await this.measure(repo, closed)
    const minutes = learnedMinutes([...this.took].filter(([key, took]) => key.startsWith(`${repo}#`) && took).map(([, took]) => took!))
    // Open pull requests, drafts included: a draft is where a task's work shows before it is read.
    const pulls = await this.reads.current(repo, openPullsPath(repo), PULL_PAGES)
    // The tasks whose pull request waits for its readers or its merge, readers asked as needed (with no builder here, its
    // PM): their builders have done their part, so none is called quiet, and one whose builder went away is kept, as its
    // pull request merges without it. Another builder would do it again.
    const { withReaders, up } = await this.askReaders(project, issues, pulls, crew)
    // Read after them: such a task is not one its builder builds, and takes none of its time in the plan; and a task that
    // comes after another waits for that one's pull request to be up.
    const read = readProblem({ now: this.now(), issues, crew, withReaders, up, minutes })
    // What a builder was found building in the Swarm's other projects as a task was about to be given to it, until it is read
    // again: it has no room here, it is busy in the plan for what is left of the estimate, and the task goes to another
    // (buildsElsewhere).
    for (const [key, away] of this.away) {
      if (!key.startsWith(`${repo} `)) continue
      const builder = crew.builders.find(b => key === `${repo} ${b.label}`)
      if (!builder || away.recheck <= this.now()) this.away.delete(key)
      else addElsewhere(read, builder.id, { tasks: away.tasks, minutes: Math.ceil((away.until - this.now()) / 60_000) })
    }
    const elsewhere = this.buildsElsewhere(project, read)
    // One whose machine is down keeps its tasks while nobody else can take them: they would only come back to it, labels and
    // comments twice over. One its person is stopping gives them back all the same, for whoever joins.
    await this.takeBack(repo, issues, (crew.away ?? []).filter(away => (away.why !== 'down' && away.why !== 'paused') || crew.builders.length > 0), undefined, withReaders)
    const { short, picks } = await this.plan(project, issues, pulls, crew, read, withReaders, elsewhere)
    // What this pass read, counted: who has nothing after it, what is open, what landed.
    const numbers = numbersOf({ now: this.now(), crew, pm: project.pm, issues, read, short, picks, closed })
    await this.deps.numbers.pass(project, numbers,
      async () => goalOf(this.reads, repo, String((await this.reads.one(repo, `/repos/${repo}`)).default_branch ?? '')),
      // The day's scoreboard, read only as the day is posted: the comments and files of what landed (scoreboard.ts), and the
      // files most landings touch, which the numbers keep for the merger (the allocator's design, package 8).
      async () => {
        const board = await boardOf(this.reads, repo, { now: this.now(), closed, team: teamOf(crew, project.pm) },
          (part, why) => this.once(`[super-tab] Task assignment: SCOREBOARD_UNREAD ${repo}: its ${part}: ${why}`))
        return { words: boardWords(board, numbers.more), hot: board.hot && board.hot.files.map(([path]) => path) }
      })
  }

  /**
   * Whether a builder builds a task in the Swarm's other projects' repositories now, for [project]'s pass: asked only just before
   * a task is given to it, or taken back for it. Every regular agent builds for every public project of its Swarm (assign/crew.ts
   * crewOf), and each project is planned on its own PM's person's computer, so each gave the same agent a task building (the
   * allocator's design, package 11, option (a): docs/design/2026-11-11-swarm-allocator/one-view.md). Read for every builder with
   * room each pass instead, a Swarm of twelve builders and ten other projects asked GitHub 120 times a pass in its person's name
   * (review of #4144). Its own list in each (listOf), all at once, so two PMs' plans race for one builder within one round
   * trip, with a task given there from here that GitHub's lists do not show yet. One found building there counts as having no
   * room here, and is busy in the plan for as long as the plan counts that work (buildingIn); it is read again [RECHECK_MS] on
   * at the latest, so one that finished early is given a task here then. The task is planned again next pass. At most
   * [OTHER_PROJECTS] repositories. The Swarm, or a repository, that cannot be read is said once, and its builders count as
   * building nothing there; a repository is asked again only after a wait that grows (Waits). GitHub failing on its own side, or
   * limiting this login, stops the pass, as for the project's own.
   */
  private buildsElsewhere(project: LedProject, read: Read): (builder: CrewBuilder) => Promise<boolean> {
    let swarm: Promise<string[]> | undefined
    return async builder => {
      swarm ??= this.deps.repositories(project).catch((error: unknown) => {
        this.once(`[super-tab] Task assignment: SWARM_UNREAD ${project.repo}: ${error instanceof Error ? error.message : String(error)} Its builders count as building nothing in the Swarm's other projects.`)
        return []
      })
      const others = (await swarm).filter(repo => repo !== project.repo)
      if (others.length > OTHER_PROJECTS) {
        this.once(`[super-tab] Task assignment: OTHER_PROJECTS ${project.repo}: of the Swarm's ${others.length} other projects, the first ${OTHER_PROJECTS} are read for what its builders build`)
      }
      const lists = await Promise.all(others.slice(0, OTHER_PROJECTS).map(async (other): Promise<Json[]> => {
        if (this.unreadOthers.held(other, this.now())) return []
        try {
          const listed = await this.listOf(other, builder)
          // Given there from here (its project led here too): GitHub's lists can lag behind the label.
          const given = [...this.given].filter(([key, label]) => key.startsWith(`${other}#`) && label === builder.label).map(([key]) => Number(key.slice(other.length + 1)))
          this.unreadOthers.ok(other)
          return [...listed, ...given.filter(number => !listed.some(item => Number(item.number) === number)).map(number => ({ number, labels: [{ name: builder.label }] }))]
        } catch (error) {
          if (!(error instanceof GitHubStop) || error.everywhere) throw error
          this.unreadOthers.miss(other, this.now(), error.until - this.now())
          this.once(`[super-tab] Task assignment: ${error.code} ${other}: ${error.message} ${project.repo}'s builders count as building nothing there.`)
          return []
        }
      }))
      const found = buildingIn(lists, builder)
      if (!found.tasks) return false
      const until = this.now() + found.minutes * 60_000
      this.away.set(`${project.repo} ${builder.label}`, { tasks: found.tasks, until, recheck: Math.min(until, this.now() + RECHECK_MS) })
      addElsewhere(read, builder.id, found)
      return true
    }
  }

  /** [builder]'s own open list in [repo] as GitHub has it now, with its ETag, read once a pass ([fresh]): the issues and pull
   *  requests that carry its label (`labels=`, as githubClaim.ts reads a builder's own). GitHub reads a comma there as "and", so a
   *  label with one is looked for among the repository's newest open items, as a claim does (githubClaim.ts HELD_PAGES). */
  private listOf(repo: string, builder: CrewBuilder): Promise<Json[]> {
    const key = `${repo} ${builder.label}`
    let listed = this.fresh.get(key)
    if (!listed) {
      const comma = builder.label.includes(',')
      listed = this.reads.current(repo, `/repos/${repo}/issues?state=open${comma ? '' : `&labels=${encodeURIComponent(builder.label)}`}&per_page=${PAGE}`, comma ? COMMA_PAGES : 1)
        .then(items => items.filter(item => labelNames(item).includes(builder.label)))
      this.fresh.set(key, listed)
    }
    return listed
  }

  /** Gives the free tasks to the builders who can start them soonest, after taking back what waits on a builder that cannot
   *  work; the builders out of quota, and the tasks it gave. */
  private async plan(project: LedProject, issues: Json[], pulls: Json[], crew: Crew, read: Read, withReaders: ReadonlySet<number>,
    elsewhere: (builder: CrewBuilder) => Promise<boolean>): Promise<{ short: AwayBuilder[]; picks: Pick[] }> {
    const { repo } = project
    if (!read.problem.builders.length) return { short: [], picks: [] }
    // Only while another builder has room: a team's one builder would be given its task straight back.
    const short = outOfQuota(read)
    if (short.length < read.problem.builders.length) await this.takeBack(repo, issues, short, undefined, withReaders)
    await this.sayPiecesDone(repo, issues, crew)
    await this.askQuiet(repo, issues, pulls, crew, withReaders)
    await this.sayWaiting(project, issues, read.looped)
    await this.openWaiting(repo, issues, crew, read, short, elsewhere)
    if (!read.free.size) return { short, picks: [] }
    // Nobody is given a task while every builder has one to build, or holds four: no plan, so a backlog costs no CPU each
    // minute (the daemon at rest keeps under 1% of a core).
    if (!crew.builders.some(builder => hasRoom(read, builder.id))) return { short, picks: [] }
    // As many steps as the problem is worth, within the second: a few thousand for a small team, the whole second for a large.
    const solved = solve(read.problem, { budgetMs: SOLVE_MS, iterations: Math.min(MAX_STEPS, STEPS_PER_TASK * read.problem.tasks.length), seed: 1,
      ...(this.last.has(repo) ? { start: this.last.get(repo) } : {}) })
    this.last.set(repo, solved.choice)
    const picks: Pick[] = []
    // Each read just before its label is written: two PMs' plans race for one builder only within that round trip.
    for (const pick of nextPicks(solved.plan, read)) if (!await elsewhere(read.builders.get(pick.builder)!) && await this.give(project, read, pick)) picks.push(pick)
    let told = 0
    for (const { task, why } of solved.plan.unplaced) {
      if (!read.free.has(task)) continue
      this.once(`[super-tab] Task assignment: UNPLACED ${repo}${task}: ${why}`)
      const blocked = blockedWhy(issues.find(issue => `#${issue.number}` === task), why, crew, read, task)
      if (blocked && told < BLOCKED_PER_PASS && await this.sayBlocked(project, Number(task.slice(1)), blocked)) told++
    }
    return { short, picks }
  }

  /**
   * Takes back the tasks of builders that cannot work (anh Dee's plan, 2026-11-09: "when a builder stops, stalls or runs
   * out of quota, Harness takes the task back and gives it to the next best builder"): their builder label and
   * status:taken come off, with one line of why; the next plan gives each to another builder. Once a task, as the label
   * is gone from the next read.
   */
  private async takeBack(repo: string, issues: Json[], away: AwayBuilder[], why?: string, keep: ReadonlySet<number> = new Set()): Promise<void> {
    if (!away.length) return
    for (const back of takeBacks(issues, away, this.now()).filter(b => !keep.has(b.number)).map(b => why ? { ...b, why } : b)) {
      const key = `${repo}#${back.number}:back:${back.label}`
      if (this.backs.has(key)) continue
      // status:taken first: a task left taken with no builder is one nobody plans (readProblem), while one left queued for
      // its builder is taken back again next pass. A label already gone is off; anything else GitHub refuses is said, and
      // tried again next pass.
      const given = await giveBack(this.deps.send, repo, back.number, back.label, back.taken)
      if ('refused' in given) { this.once(`[super-tab] Task assignment: TAKE_BACK_REFUSED ${repo}#${back.number}: GitHub answered ${given.refused}`); continue }
      if (given.takenKept !== null) this.once(`[super-tab] Task assignment: TAKEN_NOT_CLEARED ${repo}#${back.number}: GitHub answered ${given.takenKept}`)
      this.backs.add(key)
      const said = await this.deps.send('POST', `/repos/${repo}/issues/${back.number}/comments`, { body: backLine(back.why, this.clock()) })
      // Taken back all the same: the labels say so. Its line held or refused is said here (githubWrites.ts holds a line said too often).
      if (said.status >= 300) this.once(`[super-tab] Task assignment: LINE_REFUSED ${repo}#${back.number}: GitHub answered ${said.status}`)
      this.log(`[super-tab] took ${repo}#${back.number} back: ${back.why}`)
    }
  }

  /**
   * Makes the labels the team's flow needs that the repository does not have yet: the flow's own (FLOW_LABELS), each
   * builder's, and the part: label of each area a builder works on (anh Dee, 2026-11-09: "how does github label get
   * populated if we enter a new label"). The repository's labels are read only when the team needs one not seen yet, and a
   * label GitHub refuses is said once and not asked for again.
   */
  private async labelRepo(repo: string, crew: Crew): Promise<void> {
    const wanted = [...FLOW_LABELS,
      ...crew.builders.map(b => ({ name: b.label, color: '1d76db', description: `${b.name}'s tasks and pull requests` })),
      ...[...new Set(crew.builders.flatMap(b => b.worksOn ?? []))].map(area => ({ name: `part:${area}`, color: 'c5def5', description: 'An area of the project' }))]
    const missing = wanted.filter(label => !this.labels.has(`${repo}:${label.name}`))
    if (!missing.length) return
    // An area's label is the repository's however it spells it (`part:Mobile App` is mobile-app): no second one is made beside it.
    const have = new Set((await this.reads.current(repo, `/repos/${repo}/labels?per_page=${PAGE}`, 3)).map(label => String(label.name ?? '').toLowerCase())
      .map(name => name.startsWith('part:') ? `part:${areaOf(name)}` : name))
    for (const label of missing) {
      this.labels.add(`${repo}:${label.name}`)
      if (have.has(label.name.toLowerCase())) continue
      const made = await this.deps.send('POST', `/repos/${repo}/labels`, label)
      // 422: someone made it since the list was read.
      if (made.status === 201 || made.status === 422) this.log(`[super-tab] made the label ${label.name} in ${repo}`)
      else this.once(`[super-tab] Task assignment: LABEL_NOT_MADE ${repo} ${label.name}: GitHub answered ${made.status}`)
    }
  }

  /**
   * Asks a reader for each open pull request into the default branch that needs one (Swarm v4: a builder no longer picks
   * its own): a READ-OK on its head from someone other than its author, two for TWO READS. A reader asked and not yet
   * answered is still reading. A verdict on an older head no longer counts, and a HOLD on one still blocks the merge
   * (githubMerge.ts), so its reader is asked to read the new head, once. Nothing while a HOLD stands on the head itself: its
   * author fixes first. Each ask is one comment naming the reader, which GitHub news brings it (githubMentions.ts). What it
   * read of them is returned: the tasks whose pull request waits for its readers or its merge, and the team's pull requests
   * that are up, by the task each is for, which a task that comes after one is built on (assign/crew.ts readProblem).
   */
  private async askReaders(project: LedProject, issues: Json[], open: Json[], crew: Crew): Promise<{ withReaders: Set<number>; up: Map<number, Up[]> }> {
    const { repo } = project
    const team = teamOf(crew, project.pm)
    // What each builder holds, for the reader with the least (readerFor).
    const held = heldTasks(issues, crew.builders)
    // Read only when the PM is the reader left; one that cannot be read is taken as stopped, and the pass goes on.
    let pmRuns: Promise<boolean> | undefined
    const pmHears = () => pmRuns ??= this.deps.pmRunning(project).catch(() => false)
    // The tasks whose pull request waits for its readers or its merge, not for its builder (askQuiet).
    const withReaders = new Set<number>()
    const up = new Map<number, Up[]>()
    const base = String((await this.reads.one(repo, `/repos/${repo}`)).default_branch ?? '')
    const openPulls = new Set(open.map(pull => `${repo}#${pull.number}`))
    for (const key of [...this.asks]) if (key.startsWith(`${repo}#`) && !openPulls.has(key.slice(0, key.indexOf('@')))) this.asks.delete(key)
    const pulls = open.filter(pull => pull.draft !== true && String((pull.base as Json | undefined)?.ref ?? '') === base)
    for (const pull of pulls) {
      const number = Number(pull.number), head = String((pull.head as Json | undefined)?.sha ?? '')
      if (!Number.isSafeInteger(number) || !/^[0-9a-f]{40}$/.test(head)) continue
      const author = authorOf(pull)
      if (author === null || !team.has(labelOf(author))) continue
      // Up for its tasks whatever follows: one on hold or with failed checks still has the code a later task is built on. Only
      // one GitHub says is by a member of the repository: anyone can name a fork's branch `pip/1` and say it closes #1, which
      // read as Pip's gave Pip the next task on an outsider's branch (review of #4121).
      if (TEAM.has(pull.author_association)) for (const task of tasksOf(pull)) up.set(task, [...up.get(task) ?? [], { pull: number, branch: String((pull.head as Json).ref ?? ''), label: labelOf(author) }])
      // One on hold waits for a person to lift it: nobody is asked to read it meanwhile, and its task waits with it, not its
      // builder (askQuiet asks nothing of it, and it is not taken back).
      if (isHeld(pull)) { for (const task of tasksOf(pull)) withReaders.add(task); continue }
      // Nobody is asked to read a head whose checks failed: its builder fixes it first, and the fix is a new head, read again. Its
      // task stays its builder's, as one held: taken back, it went to another builder while its pull request was still open
      // (code review of #4060); its builder's turn's end tells it the checks (nextThing.ts).
      if (await this.failing.failing(repo, head)) { for (const task of tasksOf(pull)) withReaders.add(task); continue }
      // While who made its verdicts cannot be read, nobody is asked: a READ-OK made by command would read as typed.
      const comments = await this.deps.records.named(project, await pullTalk(this.reads, repo, number))
      if (!comments) { for (const task of tasksOf(pull)) withReaders.add(task); continue }
      const people = pullPeople(pull, team)
      const askNow = (name: string, why: string, nth?: number) => this.ask(repo, number, head, name, why, nth)
      const { readers, twoReads } = verdicts(comments, String(pull.body ?? ''), people)
      // A verdict on an earlier head whose change is the head's is one on it, a HOLD as much as a READ-OK (sameChange): its author
      // has changed nothing to read again.
      const same = await sameChange(this.reads, this.patches, repo, base, head, [...readers.values()].map(r => r.sha))
      const onHead = (sha: string) => head.startsWith(sha) || same.has(sha)
      // A HOLD of its own side (its writers' own, or an unsigned one from the login that opened it) stops nothing here: no reader
      // of its own is asked to lift it, and another agent's READ-OK made by command does (verdicts).
      const own = (name: string) => isWriter(people.writers, name)
      // Nor one its reader answered with a typed READ-OK: it is asked to make that by command (below).
      if ([...readers].some(([reader, r]) => r.verdict === 'HOLD' && onHead(r.sha) && !own(reader) && !r.ownLogin && !r.retyped)) continue
      for (const task of tasksOf(pull)) withReaders.add(task)
      // Who Harness asked, for which heads, and when.
      const now = this.now()
      const asked = new Map<string, Map<string, number>>()
      // Each asked as its ask wrote it: GitHub news brings an ask to the name as written, in its case (the swarm-sandbox, 2026-11-10).
      const written = new Map<string, string>()
      // How often each was asked for this head.
      const onThisHead = new Map<string, number>()
      for (const c of comments) {
        const found = ownAsk(c, ASKED)
        if (!found) continue
        // Keyed as the readers are (verdicts): the one asked as "Kai Lee" is the one that answered as "kai-lee".
        const name = readerKey(found[1]!)
        written.set(name, found[1]!)
        if (head.startsWith(found[2]!)) onThisHead.set(name, (onThisHead.get(name) ?? 0) + 1)
        const heads = asked.get(name) ?? new Map<string, number>()
        // GitHub dates every comment; one it did not is taken as asked now, as before.
        const at = Date.parse(String(c.created_at ?? ''))
        heads.set(found[2]!, Math.max(heads.get(found[2]!) ?? 0, Number.isFinite(at) ? at : now))
        asked.set(name, heads)
      }
      // A reader asked [READ_WAIT_MS] ago with no verdict since is no longer counted on: another is asked too, and the first
      // READ-OK on the head counts, whoever's. Agents read within minutes of the ask that wakes them, so one that has not is
      // stopped or stuck, and its pull request would wait on it for ever. A reader whose verdict is on an older head is
      // measured from its ask for this head; one that never gave one, from its last ask.
      const lastAsk = (name: string, thisHead: boolean) =>
        Math.max(0, ...[...asked.get(name) ?? []].filter(([sha]) => !thisHead || onHead(sha)).map(([, at]) => at))
      // Only a READ-OK made by command is a read, never its writers' own (verdicts); a reader who signs two ways counts once, as
      // the merger counts it.
      // One made before a HOLD of its own side that stands lifts nothing (verdicts): another is needed after it.
      const ownHold = [...readers].filter(([reader, r]) => r.verdict === 'HOLD' && (own(reader) || r.ownLogin)).map(([, r]) => r.at).sort().at(-1) ?? ''
      const ok = [...readers].filter(([reader, r]) => !own(reader) && r.recorded && r.verdict === 'READ-OK' && onHead(r.sha) && r.at > ownHold)
      // No verdict of the login that opened it is asked about again: every agent of its person posts as that login, its writer
      // too, which heard the ask and could answer it (review of #3708).
      const stale = [...readers].filter(([reader, r]) => !own(reader) && !r.ownLogin && !onHead(r.sha))
      // A reader whose READ-OK on the head was typed is asked again, by name, to make it by command: at most READ_ASKS times for a
      // head, and not again before it answers (plan item 3: a typed READ-OK counts for nothing).
      // One just made may be by command, its record not yet there (RECORD_SETTLE_MS): it is not asked about before.
      const typed = [...readers].filter(([reader, r]) => !own(reader) && !r.ownLogin && onHead(r.sha)
        && (r.verdict === 'READ-OK' ? !r.recorded : r.retyped))
      const settling = (r: { at: string }) => now - Date.parse(r.at) < RECORD_SETTLE_MS
      for (const [reader, r] of typed) {
        if (settling(r) || lastAsk(reader, true) >= Date.parse(r.at) || (onThisHead.get(reader) ?? 0) >= READ_ASKS) continue
        await askNow(r.name, `your READ-OK on ${r.sha.slice(0, 7)} was typed, and only one made by command counts: please read it again`,
          onThisHead.get(reader) ?? 0)
      }
      // A writer asked before (a task taken over by the reader asked) is not reading it.
      const waiting = [...asked.keys()].filter(name => !own(name) && !readers.has(name) && now - lastAsk(name, false) < READ_WAIT_MS)
      for (const [reader, r] of stale) {
        if (lastAsk(reader, true)) continue
        await askNow(r.name, `the head is now ${head.slice(0, 7)}, after your ${r.verdict} on ${r.sha.slice(0, 7)}: please read it again`)
      }
      // A stale reader not asked again yet is asked just now, above.
      const rereading = stale.filter(([reader]) => { const at = lastAsk(reader, true); return at === 0 || now - at < READ_WAIT_MS })
      // A typed reader asked again (or about to be, or whose record may still come) is reading, as one asked first is
      // (READ_WAIT_MS); one asked READ_ASKS times for the head is not counted on.
      const retyping = typed.filter(([reader, r]) => {
        const at = lastAsk(reader, true)
        return settling(r) || (at >= Date.parse(r.at) ? now - at < READ_WAIT_MS : (onThisHead.get(reader) ?? 0) < READ_ASKS)
      })
      let need = (twoReads ? 2 : 1) - ok.length - rereading.length - waiting.length - retyping.length
      // None of its writers reads it: its label's agent nor its branch's (a task taken over carries both).
      const skip = new Set([...asked.keys(), ...readers.keys(), ...crew.builders.filter(b => own(b.name)).map(b => b.id)])
      while (need-- > 0) {
        // A team of one builder still has its PM, who read for it before Harness asked readers (the swarm-sandbox, where
        // Juno, its PM, read every pull request of Pip's).
        const builder = readerFor(crew.builders, held, author, skip)
        const pm = readerKey(project.pm)
        const reader = builder ?? (!own(pm) && !skip.has(pm) && await pmHears() ? { id: pm, name: project.pm } : null)
        if (!reader) {
          // Nobody new can read it. A reader asked about an earlier head, with no verdict on this one, is asked about this one: once,
          // and half an hour after its last ask at the soonest, so a run of pushes is one ask. One asked about this head is not asked
          // again: its own turn's end types it the read it owes (nextThing.ts). Asked again each silent half hour, a pull request had
          // one more comment in its person's name each time (#4055; anh Dee, 2026-11-11: "never spam github as user accounts could
          // be banned").
          const stoppedPm = !await pmHears()
          const again = [...asked.keys()].filter(name => !own(name) && !lastAsk(name, true) && !(stoppedPm && name === pm)
            && !(readers.has(name) && onHead(readers.get(name)!.sha)) && now - lastAsk(name, false) >= READ_WAIT_MS)
            .sort((a, b) => lastAsk(a, false) - lastAsk(b, false))[0]
          if (again) await askNow(written.get(again)!, `the head is now ${head.slice(0, 7)}: please read this pull request`)
          else this.once(`[super-tab] Task assignment: NO_READER ${repo}#${number}@${head.slice(0, 7)}: `
            + (!own(pm) && stoppedPm ? 'its PM, the reader left, is stopped'
              : [...asked.keys()].some(name => !own(name)) ? 'its readers asked have not read it, and nobody else can' : 'nobody but its author can read it'))
          break
        }
        skip.add(reader.id)
        skip.add(readerKey(reader.name))
        await askNow(reader.name, 'please read this pull request')
      }
    }
    return { withReaders, up }
  }

  /** Learns how long finished tasks took: for a few closed sized issues a pass not measured yet, from its builder's
   *  "taken by" to its close. A closed issue does not change, so each is read once; the memory keeps the last few hundred. */
  private async measure(repo: string, closed: Json[]): Promise<void> {
    let reads = 0
    for (const issue of closed) {
      const key = `${repo}#${issue.number}`
      const size = labelNames(issue).find(name => /^size:[sml]$/.test(name))?.slice('size:'.length)
      // Only work that was done: a task closed as not planned (a duplicate, one dropped) ended without its work, and would
      // pull its size's time down.
      if (issue.pull_request || !size || this.took.has(key) || (issue.state_reason !== undefined && issue.state_reason !== null && issue.state_reason !== 'completed')) continue
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
   * answer, a push or a label is. A task that waited on pieces cut off it is quiet from when it last did, or from when its
   * builder was told they are closed (sayPiecesDone): GitHub does not touch a task as a piece of it closes, so by its own time
   * it would be quiet since its builder's last cut, hours back, the moment the last piece closes.
   */
  private async askQuiet(repo: string, issues: Json[], pulls: Json[], crew: Crew, withReaders: ReadonlySet<number>): Promise<void> {
    const now = this.now()
    // A task whose pull request waits for its readers or its merge is not its builder's to move (askReaders); the
    // sandbox's dry run asked Pip about #16 while its pull request had its READ-OK, minutes before Harness merged it.
    const taken = takenTasks(issues, pulls, crew.builders).filter(task => !withReaders.has(task.number))
    const open = new Set(taken.map(t => `${repo}#${t.number}`))
    for (const key of [...this.quiet.keys()]) if (key.startsWith(`${repo}#`) && !open.has(key)) this.quiet.delete(key)
    for (const task of taken) {
      const key = `${repo}#${task.number}`, touched = Math.max(task.touched, this.waited.get(key) ?? 0)
      // A task GitHub gave no time for is never called quiet.
      if (touched <= 0) continue
      let asked = this.quiet.get(key)
      // Touched after the ask (allowing the ask itself, written a moment after it was decided): it is moving again.
      if (asked && touched > asked.askedAt + 2 * 60_000) { this.quiet.delete(key); asked = undefined }
      const since = asked?.since ?? touched
      if (!asked && now - since >= QUIET_ASK_MS) {
        // Asked before this daemon restarted (a release restarts every PM's): the ask is then the issue's last touch.
        const before = await this.quietAskedAt(repo, task.number, task.name, touched)
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

  /**
   * Tells the builder of a task it took that every piece cut off it is closed (githubSplit.ts), once each time they close:
   * nothing else does, and a builder that waits on its pieces does not look at them (SWARM_BASICS: "Never watch GitHub
   * yourself"). A comment naming it, which GitHub news brings it. What was said before a restart is found among the task's
   * comments of the last day. Notes meanwhile, for the quiet watch, when each task last waited on its pieces or had this said.
   */
  private async sayPiecesDone(repo: string, issues: Json[], crew: Crew): Promise<void> {
    const now = this.now()
    for (const issue of issues) {
      const labels = labelNames(issue), builder = crew.builders.find(b => labels.includes(b.label)), key = `${repo}#${issue.number}`
      const total = Number((issue.sub_issues_summary as Json | undefined)?.total)
      if (issue.pull_request || !builder || !labels.includes('status:taken') || !(total > 0)) continue
      // Waiting now: told again when its pieces next close (one reopened, or more cut).
      if (openPieces(issue)) { this.waited.set(key, now); this.pieces.delete(key); continue }
      if (this.pieces.has(key)) continue
      const line = `${total === 1 ? 'the piece cut off this task is' : `all ${total} pieces cut off this task are`} closed`
      // From the hour a day back, so the same read is asked for an hour and answered unchanged. A line from before the task
      // last waited is of an earlier time its pieces closed.
      const since = new Date(Math.floor((now - PIECES_SAID_MS) / 3_600_000) * 3_600_000).toISOString()
      const comments = await this.reads.current(repo, `/repos/${repo}/issues/${issue.number}/comments?since=${since}&per_page=${PAGE}`, 1)
      const said = comments.find(c => Date.parse(String(c.created_at ?? '')) >= (this.waited.get(key) ?? 0) && ownAsk(c, /^Harness, \d\d:\d\d, to \*\*[^*]+\*\*: (.*)$/m)?.[1]?.startsWith(line))
      // Said before a restart: quiet from that word, which GitHub's list may not show as the task's time yet.
      if (said) this.waited.set(key, Date.parse(String(said.created_at)))
      else {
        // Not quiet while it is being told, and from this word on once it is.
        this.waited.set(key, now)
        const reply = await this.deps.send('POST', `/repos/${repo}/issues/${issue.number}/comments`,
          { body: `${SELF}, ${this.clock()}, to **${builder.name}**: ${line}. It is yours to finish, or to close if nothing is left.` })
        if (reply.status >= 300) { this.once(`[super-tab] Task assignment: ASK_REFUSED ${repo}#${issue.number}: GitHub answered ${reply.status}`); continue }
        this.log(`[super-tab] told ${builder.name} the pieces of ${repo}#${issue.number} are closed`)
      }
      this.pieces.add(key)
    }
  }

  /**
   * A task Harness gave that its builder has not taken in [WAIT_TAKE_MS], while a builder of the team has nothing to build and
   * room for it (assign/crew.ts hasRoom) and could take it, goes back with one line of why, and the next plan gives it to the
   * builder who can start it soonest (Swarm plan, step 1, item 6: "Nobody waits on it"). A builder whose turn does not end, or
   * that is on a fix or a read, takes its task late, while others sit with nothing. One its PM or a person gave stands: Harness
   * gave it when its own word "for **Name**" is on it. So does one that comes after a task still open: it can go to that
   * task's builder alone (readProblem), so taken back it would help nobody with nothing.
   * Once a task and builder in a daemon's life, so a plan or a person that gives it back to that builder is not undone.
   */
  private async openWaiting(repo: string, issues: Json[], crew: Crew, read: Read, short: AwayBuilder[], elsewhere: (builder: CrewBuilder) => Promise<boolean>): Promise<void> {
    const idle = crew.builders.filter(b => hasRoom(read, b.id) && !short.some(away => away.label === b.label))
    if (!idle.length) return
    const now = this.now()
    const open = new Set(issues.filter(issue => !issue.pull_request).map(issue => Number(issue.number)))
    // One task back for each builder with nothing, the oldest first: on the sandbox (2026-11-11) one free builder took two back,
    // and the next plan had two to give it.
    for (const issue of [...issues].sort((a, b) => Number(a.number) - Number(b.number))) {
      if (!idle.length) return
      const labels = labelNames(issue)
      const builder = crew.builders.find(b => labels.includes(b.label))
      if (issue.pull_request || !builder || labels.includes('status:taken') || this.backs.has(`${repo}#${issue.number}:back:${builder.label}`)
        || dependsOn(issue.body).some(number => open.has(number))) continue
      const task = read.problem.tasks.find(t => t.id === `#${issue.number}`)
      const taker = idle.find(b => b !== builder && !task?.notBuilders.includes(b.id))
      if (!task || !taker) continue
      const comments = await this.reads.current(repo, `/repos/${repo}/issues/${issue.number}/comments?per_page=${PAGE}`, 1)
      const gave = Math.max(0, ...comments.filter(c => readerKey(ownAsk(c, /^Harness, \d\d:\d\d: for \*\*([^*]+)\*\*: /)?.[1] ?? '\n') === readerKey(builder.name))
        .map(c => Date.parse(String(c.created_at ?? ''))).filter(Number.isFinite))
      if (!gave || now - gave < WAIT_TAKE_MS) continue
      idle.splice(idle.indexOf(taker), 1)
      // The builder it would go to may build in another project: read as just before a give, it then has no room here.
      if (await elsewhere(taker)) continue
      await this.takeBack(repo, [issue], [{ name: builder.name, label: builder.label, why: 'stopping' }],
        `${builder.name} has not started it in ${Math.round((now - gave) / 60_000)} minutes, and ${taker.name} has nothing to do`)
    }
  }

  /** When Harness asked [name] about quiet task [number], if that ask is its last touch (the comments since [touched]). */
  private async quietAskedAt(repo: string, number: number, name: string, touched: number): Promise<number | null> {
    const since = new Date(touched - 60_000).toISOString()
    const comments = await this.reads.current(repo, `/repos/${repo}/issues/${number}/comments?since=${since}&per_page=${PAGE}`, 1)
    const asks = comments.filter(c => {
      const found = ownAsk(c, /^Harness, \d\d:\d\d, to \*\*([^*]+)\*\*: (.*)$/m)
      return !!found?.[1] && readerKey(found[1]) === readerKey(name) && found[2]!.startsWith(QUIET_ASKED)
    }).map(c => Date.parse(String(c.created_at ?? ''))).filter(Number.isFinite)
    return asks.length ? Math.max(...asks) : null
  }

  /** Tells the PM, once on the task, why nobody can start it (a failure is shown to someone who can act on it), counting
   *  what was said before a restart from the task's comments. Whether it was said now. */
  private async sayBlocked(project: LedProject, number: number, blocked: string): Promise<boolean> {
    const { repo } = project
    const key = `${repo}#${number}:blocked:${blocked}`
    if (this.blocked.has(key)) return false
    const line = `nobody can start this yet: ${blocked}`
    const comments = await this.reads.current(repo, `/repos/${repo}/issues/${number}/comments?per_page=${PAGE}`, 1)
    if (comments.some(c => ownAsk(c, new RegExp(`^Harness, \\d\\d:\\d\\d, to \\*\\*[^*]+\\*\\*: ${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)))) {
      this.blocked.add(key)
      return false
    }
    const reply = await this.deps.send('POST', `/repos/${repo}/issues/${number}/comments`, { body: `${SELF}, ${this.clock()}, to **${project.pm}**: ${line}.` })
    if (reply.status >= 300) { this.once(`[super-tab] Task assignment: ASK_REFUSED ${repo}#${number}: GitHub answered ${reply.status}`); return false }
    this.blocked.add(key)
    this.log(`[super-tab] told ${project.pm} why nobody can start ${repo}#${number}: ${blocked}`)
    return true
  }

  /** Tells the PM, once on the task, of a sized task nobody holds that is given to nobody for a reason that may last for ever
   *  (assign/crew.ts readProblem): its pieces are still open, which a piece nobody builds would make for ever; or it is one of
   *  the [looped], whose "after #N" lines wait on each other. */
  private async sayWaiting(project: LedProject, issues: Json[], looped: readonly string[]): Promise<void> {
    let told = 0
    for (const issue of issues) {
      const labels = labelNames(issue)
      if (issue.pull_request || !openPieces(issue) || labels.includes('status:taken') || labels.some(label => label.startsWith('builder:'))
        || !labels.some(label => /^size:[sml]$/.test(label))) continue
      if (told < BLOCKED_PER_PASS && await this.sayBlocked(project, Number(issue.number), 'pieces cut off it are still open')) told++
    }
    for (const task of looped) if (told < BLOCKED_PER_PASS && await this.sayBlocked(project, Number(task.slice(1)), LOOPED)) told++
  }

  /** One ask of a reader, once per pull request, head and reader: a comment naming it, with the command that makes its
   *  verdict on the head it reads (githubVerdict.ts). One GitHub refuses is said, and asked again next pass. */
  private async ask(repo: string, number: number, head: string, name: string, what: string, nth = 0): Promise<void> {
    const key = `${repo}#${number}@${head}:${readerKey(name)}${nth ? `:${nth}` : ''}`
    if (this.asks.has(key)) return
    const reply = await this.deps.send('POST', `/repos/${repo}/issues/${number}/comments`, { body: `${SELF}, ${this.clock()}, to **${name}**: ${what}, `
      + `then run \`harness super-tab read ok ${repo}#${number} ${head.slice(0, 7)} 'what you found'\`. For a HOLD, read hold in place of read ok, with the file, line and fix.` })
    if (reply.status >= 300) { this.once(`[super-tab] Task assignment: ASK_REFUSED ${repo}#${number}: GitHub answered ${reply.status}`); return }
    this.asks.add(key)
    this.log(`[super-tab] asked ${name} to read ${repo}#${number} at ${head.slice(0, 7)}`)
  }

  /** Labels the task for its builder and says why on it, as Harness, in its PM's person's name. Whether it was given. */
  private async give(project: LedProject, read: Read, pick: Pick): Promise<boolean> {
    const builder = read.builders.get(pick.builder)
    const number = Number(pick.task.slice(1))
    if (!builder || !Number.isSafeInteger(number)) return false
    const { name, label } = builder
    const labelled = await this.deps.send('POST', `/repos/${project.repo}/issues/${number}/labels`, { labels: [label] })
    if (labelled.status !== 200) {
      this.once(`[super-tab] Task assignment: LABEL_REFUSED ${project.repo}#${number}: GitHub answered ${labelled.status}`)
      return false
    }
    this.given.set(`${project.repo}#${number}`, label)
    // One that comes after tasks whose pull requests are up says which branches it is built on.
    const bases = read.bases.get(pick.task)
    const said = await this.deps.send('POST', `/repos/${project.repo}/issues/${number}/comments`,
      { body: `${SELF}, ${this.clock()}: for **${name}**: ${reasonOf(pick, read)}.${bases ? ` ${builtOn(bases)}.` : ''}` })
    // Given all the same: its label is on, and its builder's turn's end types it (nextThing.ts). Its line held or refused is said here.
    if (said.status >= 300) this.once(`[super-tab] Task assignment: LINE_REFUSED ${project.repo}#${number}: GitHub answered ${said.status}`)
    this.log(`[super-tab] gave ${project.repo}#${number} to ${name} (${reasonOf(pick, read)})`)
    return true
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

/** How many PMs are told per pass why a task cannot start: a backlog of them is said over a few passes. */
const BLOCKED_PER_PASS = 5
/** What its PM is told of a task whose "after #N" lines lead back to itself. */
const LOOPED = 'its "after #N" lines wait on each other'

/**
 * Why nobody can start a sized task, said so its PM can act on it, or null for a wait that passes (a builder busy, quota
 * spent, a task it waits on): a need no builder's machine meets, a task larger than every machine, or "after #N" lines that
 * wait on each other. `needs:` labels are what the PM writes (lib/swarmSkills.ts PM_BASICS), and a tool no machine has keeps
 * its task waiting for ever, which only the PM's person can change.
 */
export function blockedWhy(issue: Json | undefined, why: string, crew: Crew, read: Read, task: string): string | null {
  if (why === 'its dependencies wait on each other') return LOOPED
  const needs = issue ? labelNames(issue).filter(name => name.startsWith('needs:')).map(name => name.slice('needs:'.length)) : []
  const machines = crew.machines.filter(machine => crew.builders.some(builder => builder.machineId === machine.machineId))
  if (needs.length && !machines.some(machine => needs.every(need => machineHas(machine.observation, need)))) {
    const nowhere = needs.filter(need => !machines.some(machine => machineHas(machine.observation, need)))
    return nowhere.length ? `it needs ${nowhere.join(' and ')}, which no builder's machine has`
      : `it needs ${needs.join(' and ')} on one machine, and no builder's machine has them all`
  }
  const shape = read.problem.tasks.find(t => t.id === task)?.needs
  if (shape && !read.problem.machines.some(m => shape.cpu <= m.capacity.cpu && shape.ram <= m.capacity.ram && shape.disk <= m.capacity.disk)) {
    return 'it needs more than any builder\'s machine has'
  }
  return null
}

/** The first line of a comment Harness may have written, matched by [pattern]: only a member's, as Harness writes with the PM's
 *  person's gh, so nobody outside the team can make Harness believe it asked (and never ask), and only its first 500
 *  characters, as Harness's own are short, so a long comment costs nothing. */
function ownAsk(comment: Json, pattern: RegExp): RegExpExecArray | null {
  if (!TEAM.has(comment.author_association)) return null
  return pattern.exec(String(comment.body ?? '').slice(0, 500))
}

/** What taking a task back answered: GitHub refused it (its status), or it is done, with the status GitHub answered when it kept
 *  status:taken after the builder's label went (null when it did not). */
export type GivenBack = { refused: number } | { takenKept: number | null }

/**
 * Takes task [number] of [repo] back from the builder [label] names (anh Dee's plan, 2026-11-09: "when a builder stops, stalls
 * or runs out of quota, Harness takes the task back and gives it to the next best builder"), for the assigner and for an agent's
 * own computer when it sat idle holding it (nextThing.ts). status:taken first, when it is [taken]: a task left taken with no builder
 * is one nobody plans (readProblem), while one left queued for its builder is taken back again next pass. A label already gone
 * is off; anything else GitHub refuses stops it. Then status:taken once more, after the builder's label: a claim made meanwhile
 * (githubClaim.ts) marks the task taken, and takes its own mark off only when it lands after the label went. Only where this took
 * the label off: one already gone was moved by hand, and its next builder's claim is not this one's to undo.
 */
export async function giveBack(send: GitHubSend, repo: string, number: number, label: string, taken: boolean): Promise<GivenBack> {
  const remove = (name: string) => send('DELETE', `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`)
  let off = false
  for (const name of [...taken ? ['status:taken'] : [], label]) {
    const reply = await remove(name)
    if (reply.status !== 200 && reply.status !== 404) return { refused: reply.status }
    off = name === label && reply.status === 200
  }
  const cleared = off ? await remove('status:taken') : null
  return { takenKept: cleared && cleared.status !== 200 && cleared.status !== 404 ? cleared.status : null }
}

/** The line a task taken back says on it, as Harness at [at] (HH:MM): [why], and where it goes. */
export const backLine = (why: string, at: string): string => `${SELF}, ${at}: ${why}, so this task goes to the builder who can start it next.`

export const labelNames = (issue: Json): string[] =>
  (Array.isArray(issue.labels) ? issue.labels : []).map(label => String((label as Json)?.name ?? ''))

/** The GitHub repositories of a Swarm's projects as [state] lists them (its PM's person's read: every public project, and the
 *  private ones that person is in), each once, in the Swarm's order. Not a closed tab's project: nobody plans it, and its read
 *  would be paid each pass for every tab ever closed. */
export function swarmRepositories(state: Json): string[] {
  const projects = (Array.isArray(state.projects) ? state.projects : []).map(project => project && typeof project === 'object' ? project as Json : {})
  return [...new Set(projects.filter(project => project.archived !== true)
    .map(project => repositorySlug((project.repository as Json | undefined)?.repositoryUrl)).filter((slug): slug is string => slug !== null))]
}
