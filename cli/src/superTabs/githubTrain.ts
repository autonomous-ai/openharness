/**
 * Harness's train (docs/plans/2026-11-10-swarm-plan.md, "5. A train"): the ready pull requests of a repository ride one branch,
 * CI runs once on the combined change, and they land only if that run is green on the base it lands on. Merged one at a time
 * as GitHub read each clean (githubMerge.ts until 2026-11-10), a pull request landed on checks from an older base (in the
 * swarm-sandbox a reader wrote "the branch is behind main, so CI only ran the old single job", and it was merged), and one
 * landing for each 15 to 20 minute run could not keep up: this repository's people made 21 batches by hand on 10 November,
 * carrying 80 pull requests. lampOS's train landed 2 to 3 a run, and its one run caught 6 breaks no pull request's own checks
 * could show (docs/research/2026-11-10-swarm-study).
 *
 * Nothing is stored. An open train is an open pull request this computer's login opened from a `harness-train/` branch of
 * this repository into the base, whose body names the tip the train built and each member as `#N at <head>`; a red one is that
 * pull request closed with `Train, red:` in its title; a landed one is it merged, as a merge commit where the repository allows
 * one, so that GitHub marks each member merged under its own author. A daemon restart (each release is one, seven
 * on 2026-11-10) reads them back from GitHub. One train is open at a time. One closed without landing says why in its title
 * (ENDS), as a red one does: nothing else kept why, and the day's numbers count the trains lost by cause (scoreboard.ts).
 *
 * Anyone who can write to the repository can write that body, so before it lands a train is read from its branch: one merge
 * commit for each member the body names, the member's head its second parent, down to the base's tip (`holds`). That reads
 * parents, not content: merge commits made by hand with those same parents, or one more pushed on top for a pull request
 * added to the body, read the same. So the train marks the tip it built with a commit status (TRAIN_MARK), which GitHub signs
 * with the login that made it, and only a tip this login marked is attended: a commit is its content and all under it.
 *
 * It never force-pushes, writes no ref outside `harness-train/`, and merges nothing on an answer it does not expect: any other
 * answer is a GitHubStop, which stops this repository's pass until the merger's next try (githubRest.ts Waits). The GitHub
 * calls are the ones the backend's train made until 8 November (backend/src/github/train.ts before c5c414fa31, reviewed twice
 * for #3226), now as this computer's own gh login.
 */
import type { GitHubReply, GitHubSend } from './githubRest.js'
import { GitHubReads, GitHubStop, PAGE } from './githubRest.js'
import { TEAM } from './githubMentions.js'
import { object } from './wire.js'

type Json = Record<string, unknown>

/** The branches the train builds on. Nothing else in a repository uses the prefix (AGENTS.md: "Never push to a `harness-train/`
 *  branch"), and the train writes and deletes no other ref. */
const TRAIN_BRANCH = 'harness-train/'
/** The most pull requests one train carries: the one of twenty that breaks it is found in five runs more. */
const TRAIN_MAX = 20
/** A train whose checks have not finished in this long, or whose member still waits, is closed and built again: while it is
 *  open nothing else lands, and a check that never reports would hold the repository for good. */
const TRAIN_WAIT_MS = 90 * 60_000
/** How a train's title begins, before its members' numbers: the numbers a project's people read count them by it (pmNumbers.ts). */
export const TRAIN_TITLE = 'Train: '
const TITLE = TRAIN_TITLE
/** How a train closed without landing is titled, by why: its checks failed (which the split reads back, below), the base moved
 *  under it, a pull request it carried was no longer ready at its head, or its checks did not finish in time. One closed for
 *  any other reason (a second train, a branch that is not what the train built) keeps the title it was built with. */
const ENDS = { red: 'Train, red: ', moved: 'Train, base moved: ', changed: 'Train, rider changed: ', late: 'Train, out of time: ' } as const
/** Why a train closed without landing. */
export type TrainEnd = keyof typeof ENDS | 'other'
const RED_TITLE = ENDS.red
/** A train's members as its title lists them: `#4 #5`. */
const MEMBERS = /^#[1-9]\d{0,9}(?: #[1-9]\d{0,9})*$/

/** Why a train closed without landing, as the [title] it was closed with says (`other` for the title it was built with, which a
 *  landed one keeps too), or null for a title that is no train's. A title is anyone's to write: it is counted (scoreboard.ts),
 *  and nothing lands or splits by it (genuine). */
export function trainEnd(title: string): TrainEnd | null {
  const end = (Object.keys(ENDS) as Array<keyof typeof ENDS>).find(key => title.startsWith(ENDS[key]))
  const members = end ? title.slice(ENDS[end].length) : title.startsWith(TITLE) ? title.slice(TITLE.length) : ''
  return MEMBERS.test(members) ? end ?? 'other' : null
}
const SHA = /^[0-9a-f]{40}$/
/** A member as a train's body names it. Its readers are there for the note that it landed, which a restart must write the same. */
const MEMBER = /^#([1-9]\d{0,9}) at ([0-9a-f]{40}), READ-OK by ([\w -]{1,200})$/
const BUILT = /\bbuilt to ([0-9a-f]{40})\b/
/** The commit status the train puts on the tip it built. Anyone who can push can add a status, and GitHub says who made each:
 *  only a tip with this one from this computer's login is a train's. It is no check of the train (githubMerge.ts checksOf). */
export const TRAIN_MARK = 'harness/train'
/** Pages of a hundred of a tip's statuses read for the mark, the newest first: under more than these it is not found, and the
 *  train is closed and built again. */
const MARK_PAGES = 10
/** GitHub's closing keywords before an issue of this repository. */
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#([1-9]\d{0,9})\b/gi
/** The most issues one landing closes: a body is anyone's text, and can name any number of them. */
const CLOSES_MAX = 100

/** A ready pull request, as the merger hands it over: `fork` when its branch is in another repository (it rides the train
 *  as any other, and merges on its own only if GitHub does not take its head into the train's branch). */
export interface TrainPull { number: number; head: string; title: string; body: string; readers: readonly string[]; fork: boolean
  /** Whether its head had a check of its own. */
  checked: boolean }
export interface TrainMember { number: number; head: string; readers: string }
/** One of the repository's trains, open or closed, as its pull request says it. `tip` is empty and `members` none when its body
 *  does not read as one the train wrote. */
interface Train { number: number; branch: string; head: string; tip: string; members: TrainMember[]; red: boolean; mergedAs: string | null; openedAt: number; opener: string }

/** What the train asks of the merger: a head's checks as the merger reads a pull request's (passed only once they hold still;
 *  `none` when it has no check at all), this computer's GitHub login, its notes to a pull request's author, each said once for a head, and how a comment of Harness's begins ("Harness, 14:20"). */
export interface TrainHost<T extends TrainPull> {
  checks(number: number, head: string): Promise<{ state: 'passed' | 'running' | 'failed'; none: boolean }>
  login(): Promise<string>
  conflicts(pull: T): Promise<void>
  failedAlone(pull: T, train: number): Promise<void>
  stamp(): string
}

/** A train's body: the tip it built, then each member at its full head with who read it. A name is cut to what [MEMBER] reads, so
 *  a body the train wrote always reads back. */
export const trainBody = (base: string, tip: string, members: readonly TrainMember[]): string =>
  [`Harness's train into ${base}, built to ${tip}. It lands when its checks pass and each pull request below is still ready at its head. Never push to this branch.`,
    '', ...members.map(m => `#${m.number} at ${m.head}, READ-OK by ${m.readers.replace(/[^\w -]/g, '').slice(0, 200) || 'a reader'}`)].join('\n')

/** The tip and members a train's [body] names, or null when it is not one the train wrote: no tip, no member, more than a
 *  train carries, or one named twice. */
export function trainOfBody(body: string): { tip: string; members: TrainMember[] } | null {
  const tip = BUILT.exec(body)?.[1]
  const members = body.split(/\r?\n/).map(line => MEMBER.exec(line)).filter(found => found !== null)
    .map(found => ({ number: Number(found[1]), head: found[2]!, readers: found[3]! }))
  if (!tip || !members.length || members.length > TRAIN_MAX || new Set(members.map(m => m.number)).size !== members.length) return null
  return { tip, members }
}

/** How a red train of [members] runs again: its two halves, one after the other; a train of one runs no more (it failed on its
 *  own). By halves and never by a guess at the culprit: lampOS's bot blamed by crate and was wrong 8 times in 22. */
export function splitRed<T>(members: readonly T[]): T[][] {
  if (members.length <= 1) return []
  const half = Math.ceil(members.length / 2)
  return [members.slice(0, half), members.slice(half)]
}

/**
 * Who rides the next train, from the [ready] pull requests and the [red] trains GitHub still lists. One a red train carried at
 * this head rides only with the others of its half of the smallest such train, the split's lowest number first, so the half that
 * passes lands and the half that fails splits again; a pull request no red train carried waits until the split has run. One
 * that failed alone at this head rides no more (`alone`, with its train). No split to run: every ready one, in number order, up
 * to [TRAIN_MAX].
 */
export function nextTrain<T extends { number: number; head: string }>(ready: readonly T[], red: ReadonlyArray<{ number: number; members: readonly TrainMember[] }>):
  { riders: T[]; alone: Array<{ pull: T; train: number }> } {
  const carried = (pull: T, member: TrainMember) => member.number === pull.number && member.head === pull.head
  const alone: Array<{ pull: T; train: number }> = [], split: Array<{ pull: T; train: { number: number; members: readonly TrainMember[] } }> = [], fresh: T[] = []
  for (const pull of [...ready].sort((a, b) => a.number - b.number)) {
    // The smallest red train that carried it, the later of two the same size: what is known most narrowly of it.
    const train = red.filter(t => t.members.some(m => carried(pull, m)))
      .sort((a, b) => a.members.length - b.members.length || b.number - a.number)[0]
    if (!train) fresh.push(pull)
    else if (train.members.length === 1) alone.push({ pull, train: train.number })
    else split.push({ pull, train })
  }
  const first = split[0]
  if (!first) return { riders: fresh.slice(0, TRAIN_MAX), alone }
  const half = splitRed(first.train.members).find(part => part.some(m => carried(first.pull, m)))!
  return { riders: split.filter(s => s.train === first.train && half.some(m => carried(s.pull, m))).map(s => s.pull), alone }
}

/** What a train's commit on the base says: `Train: #a #b` and each member's title and number, then a `Closes #N` for every issue
 *  a member's body closes, so GitHub closes them as it would have on that member's own merge. Only this repository's issues, by
 *  number, and never a body's own line: a body is anyone's text. */
export function landingMessage(pulls: ReadonlyArray<{ number: number; title: string; body: string }>): { commit_title: string; commit_message: string } {
  const closes = [...new Set(pulls.flatMap(pull => [...pull.body.matchAll(CLOSES)].map(found => Number(found[1]))))].slice(0, CLOSES_MAX)
  return { commit_title: `${TITLE}${pulls.map(pull => `#${pull.number}`).join(' ')}`,
    commit_message: [...pulls.map(pull => `* ${pull.title.replace(/\s+/g, ' ').trim().slice(0, 200)} (#${pull.number})`),
      ...closes.length ? ['', ...closes.map(issue => `Closes #${issue}`)] : []].join('\n') }
}

/** A branch the train may write or delete: under its prefix, and a plain name. Not one with a percent sign: `%2e%2e` is a
 *  name git takes and a path reads as `..`, so a delete of `harness-train/%2e%2e/pip/12` would be a delete of `pip/12`. */
const own = (branch: string): boolean => branch.startsWith(TRAIN_BRANCH) && branch.length > TRAIN_BRANCH.length && !/\.\.|[\s~^:?*[\\%]/.test(branch)

/** One repository's train for one pass of the merger: `landed` before the merger reads the open pull requests, `carry` with the
 *  ones it found ready. */
export class GitHubTrain<T extends TrainPull> {
  /** [pulls]: every open pull request of [repo], as the merger listed them. */
  constructor(private readonly deps: { reads: GitHubReads; send: GitHubSend; now: () => number; log: (line: string) => void },
    private readonly repo: string, private readonly base: string, private readonly pulls: readonly Json[], private readonly host: TrainHost<T>) {}

  /**
   * Finishes the trains that landed: a member still open at the head its merged train names is told and closed. Their numbers,
   * for the merger to leave alone: the note or the close of an earlier pass failed, the train is merged all the same, and to
   * GitHub its member now conflicts with the base that holds it.
   */
  async landed(): Promise<Set<number>> {
    const done = new Set<number>()
    for (const train of await this.closed()) if (train.mergedAs) for (const number of await this.finish(train, train.mergedAs)) done.add(number)
    return done
  }

  /** The repository's closed trains among the hundred pull requests closed last: a split runs over a few trains and a landing
   *  is finished on the next pass, both well within them. One page, so the read does not grow with the repository. */
  private async closed(): Promise<Train[]> {
    return this.mine(await this.deps.reads.current(this.repo, `/repos/${this.repo}/pulls?state=closed&base=${encodeURIComponent(this.base)}&sort=updated&direction=desc&per_page=${PAGE}`, 1))
  }

  /** The trains among [pulls]: the ones this computer's login opened. A builder can push a branch under the train's prefix
   *  and write its pull request as a train's; only the login that builds trains is asked for when one reads as a train. */
  private async mine(pulls: readonly Json[]): Promise<Train[]> {
    const trains = pulls.map(pull => this.trainOf(pull)).filter(train => train !== null)
    if (!trains.length) return []
    const login = (await this.host.login()).toLowerCase()
    return trains.filter(train => train.opener === login)
  }

  /** One step for the repository's train with the [ready] pull requests: the open one waits, lands or is closed; with none
   *  open, the next is built. [waiting]: each pull request, as `<number>@<head>`, that is read and may yet be ready at this
   *  head. Returns the ones to merge directly, as before the train: nothing was built then. */
  async carry(ready: readonly T[], waiting: ReadonlySet<string>): Promise<T[]> {
    const [train, ...others] = (await this.mine(this.pulls)).sort((a, b) => a.number - b.number)
    // One train at a time: a second would be tested on a base the first is about to move.
    for (const other of others) await this.close(other, 'other', `#${train!.number} is open`)
    if (train) { await this.attend(train, ready, waiting); return [] }
    // Nothing to carry: nothing more is read (the merger passes every 30 seconds).
    if (!ready.length) return []
    // A closed train is red by its title, which anyone can write: only one this login built whose checks did fail is, and
    // only one that carried a pull request ready now is read.
    const red: Train[] = []
    for (const closed of await this.closed()) {
      if (!closed.red || closed.mergedAs || !closed.members.some(member => ready.some(pull => pull.number === member.number && pull.head === member.head))) continue
      if (await this.genuine(closed) && (await this.host.checks(closed.number, closed.head)).state === 'failed') red.push(closed)
    }
    const { riders, alone } = nextTrain(ready, red)
    for (const { pull, train: carried } of alone) await this.host.failedAlone(pull, carried)
    if (!riders.length) return []
    // Alone, and it holds the base's tip: its own checks ran on what will land. Not a fork's: whether GitHub compares its
    // head here is not yet seen, and a read it refuses would hold the pass; a train of one is taken or refused by the merges API.
    if (ready.length === 1 && !riders[0]!.fork && (await this.deps.reads.one(this.repo, `/repos/${this.repo}/compare/${this.base}...${riders[0]!.head}`)).behind_by === 0) return riders
    return this.build(riders, new Set(red.flatMap(closed => closed.members.map(member => `${member.number}@${member.head}`))))
  }

  /** The open [train]: its checks running, it waits; failed, it is closed as red; passed, it lands if every member is still
   *  ready at its head and what the base gained since changes nothing it tested. */
  private async attend(train: Train, ready: readonly T[], waiting: ReadonlySet<string>): Promise<void> {
    // Its branch is not at the tip its body says the train built: someone pushed to it, or wrote the body.
    if (train.head !== train.tip) return this.close(train, 'other', 'its branch is not at the tip the train built')
    // Nor at a tip this login never built, whatever its body and its parents say: its checks are not waited for.
    if (!await this.marked(train.head)) return this.close(train, 'other', 'its tip is not one the train built')
    // What it was tested on is the base as it is: a run on a base that moved lands nothing, so it is not waited for. Not even
    // when the base gained only documentation: suites read some of it (scripts/ci-plan.py).
    const ahead = await this.deps.reads.one(this.repo, `/repos/${this.repo}/compare/${this.base}...${train.head}`)
    if (ahead.behind_by !== 0) return this.close(train, 'moved', `${this.base} moved under it`)
    const checks = await this.host.checks(train.number, train.head)
    if (checks.state === 'failed') return this.close(train, 'red', 'its checks failed')
    // No check of its own where a member had its own: CI has not started on it (Actions can take minutes to make a run), and
    // none at all would read as passed.
    const unstarted = checks.none && ready.some(pull => pull.checked && train.members.some(member => member.number === pull.number))
    if (checks.state === 'running' || unstarted) {
      if (this.deps.now() - train.openedAt > TRAIN_WAIT_MS) await this.close(train, 'late', 'its checks did not finish in 90 min')
      return
    }
    // Read again right before landing: a HOLD since, a new head or a closed one, and the train is built again without it.
    const riders = train.members.map(member => ready.find(pull => pull.number === member.number && pull.head === member.head))
    if (!riders.every(pull => pull !== undefined)) {
      // One that only waits at its head (its own check runs again, GitHub has not yet said whether it merges, a daemon just
      // started has not seen its checks hold still) keeps the train's green run, for as long as a train may wait.
      const waits = train.members.every((member, at) => riders[at] || waiting.has(`${member.number}@${member.head}`))
      if (waits && this.deps.now() - train.openedAt < TRAIN_WAIT_MS) return
      return this.close(train, 'changed', 'a pull request it carries is no longer ready at its head')
    }
    if (!await this.holds(train, String(object(ahead.merge_base_commit).sha ?? ''))) return this.close(train, 'other', 'its branch does not hold what its body names')
    // A merge commit where the repository allows one: each member's own commits reach the base, so GitHub marks each merged
    // under its author, and the work counts as theirs (shippingRead.ts). Squashed, the members are only closed and the one
    // commit is this login's. Else a squash, else a rebase, which takes no message. The next way is tried too when GitHub
    // refuses one (405): a base that requires a linear history or signed commits refuses a merge commit the settings allow,
    // and the same tree lands squashed.
    const settings = await this.deps.reads.one(this.repo, `/repos/${this.repo}`)
    const ways = (['merge', 'squash', 'rebase'] as const).filter(way => settings[way === 'merge' ? 'allow_merge_commit' : `allow_${way}_merge`] !== false)
    let reply: GitHubReply | undefined, method: typeof ways[number] | undefined
    for (method of ways) {
      // GitHub refuses a merge as the base moves, too: the next way is never sent onto a base the train was not tested on.
      if (reply && (await this.deps.reads.one(this.repo, `/repos/${this.repo}/compare/${this.base}...${train.head}`)).behind_by !== 0) {
        return this.close(train, 'moved', `${this.base} moved under it`)
      }
      // Pinned to the head its checks passed: a push since is a 409, and nothing lands.
      reply = await this.sent('PUT', `/pulls/${train.number}/merge`, [200, 405],
        { sha: train.head, merge_method: method, ...method === 'rebase' ? {} : landingMessage(riders) })
      if (reply.status !== 405) break
    }
    if (!reply || reply.status === 405) {
      // A rule of the repository the train does not meet any way. It stays open, as building the next would only run the checks
      // to be refused again; said once on the train itself, for a person, and tried again with the merger's waits.
      const said = 'GitHub refuses to merge this train'
      const comments = await this.deps.reads.current(this.repo, `/repos/${this.repo}/issues/${train.number}/comments?per_page=${PAGE}`, 1)
      if (!comments.some(comment => TEAM.has(comment.author_association) && String(comment.body ?? '').slice(0, 200).includes(said))) {
        await this.sent('POST', `/issues/${train.number}/comments`, [201],
          { body: `${this.host.stamp()}: ${said} (405). Nothing else lands in ${this.base} while it is open: lift what blocks it, or close it and the next is built.` })
      }
      throw this.stop('TRAIN_REFUSED', `GitHub answered PUT /pulls/${train.number}/merge with 405.`)
    }
    const merged = object(reply.body)
    // Merged or not, an answer that does not say so writes nothing more: a merged train is finished on the next pass (landed).
    if (merged.merged !== true || !SHA.test(String(merged.sha))) throw this.stop('TRAIN_UNREADABLE', `GitHub's answer to the merge of #${train.number} is not one the train reads.`)
    this.deps.log(`[super-tab] train ${this.repo}#${train.number} landed ${train.members.map(m => `#${m.number}`).join(' ')} as ${String(merged.sha).slice(0, 7)}`)
    await this.finish(train, String(merged.sha), method === 'merge')
    // Its members stay open until GitHub marks them (finish): the branch goes here.
    if (method === 'merge') await this.drop(train.branch)
  }

  /** Whether this computer's login marked [tip] as a train it built (TRAIN_MARK). */
  private async marked(tip: string): Promise<boolean> {
    const login = (await this.host.login()).toLowerCase()
    const statuses = await this.deps.reads.current(this.repo, `/repos/${this.repo}/commits/${tip}/statuses?per_page=${PAGE}`, MARK_PAGES)
    return statuses.some(status => status.context === TRAIN_MARK && String(object(status.creator).login ?? '').toLowerCase() === login)
  }

  /** The commit [train]'s members stand on: from its head down, one merge commit for each member its body names, the member's
   *  head its second parent. Null when its branch is not that. A commit is read once: it never changes. */
  private async under(train: Train): Promise<string | null> {
    let at = train.head
    for (const member of train.members.toReversed()) {
      const commit = await this.deps.reads.one(this.repo, `/repos/${this.repo}/git/commits/${at}`)
      const parents = Array.isArray(commit.parents) ? commit.parents.map(parent => String(object(parent).sha ?? '')) : []
      if (parents.length !== 2 || parents[1] !== member.head) return null
      at = parents[0]!
    }
    return at
  }

  /** Whether [train]'s branch is what its body names and nothing else: its members (under), on the commit of the base it
   *  stands on ([from]). */
  private async holds(train: Train, from: string): Promise<boolean> {
    return SHA.test(from) && await this.under(train) === from
  }

  /** Whether closed [train] is one this login built that carried what its body names: its head the tip its body names, and
   *  marked; its members under it; and they on a commit of the base. Its title and body are anyone's to write after it closed
   *  as before, and are believed for nothing else. */
  private async genuine(train: Train): Promise<boolean> {
    if (train.head !== train.tip || !await this.marked(train.head)) return false
    const on = await this.under(train)
    return on !== null && (await this.deps.reads.one(this.repo, `/repos/${this.repo}/compare/${this.base}...${on}`)).ahead_by === 0
  }

  /** Builds the next train of [riders] on the base's tip with the merges API (no checkout, so no branch's code runs here), and
   *  opens its pull request. A fork's pull request rides as any other: GitHub keeps its head in this repository
   *  (refs/pull/N/head) and merges it by its SHA. Returns the fork whose head GitHub did not take (404), to merge on its own
   *  checks as before the train; no train is opened then, as its merge moves the base under it. Not one a red train
   *  carried at this head ([carried], as `<number>@<head>`): GitHub took it then, and its own checks are not what failed. */
  private async build(riders: readonly T[], carried: ReadonlySet<string>): Promise<T[]> {
    // No train is open, so every train branch is one left behind (a build that failed part way, a daemon stopped between two
    // calls): deleted before the next, never opened later. GitHub matches by the start of the name, so a branch that only
    // begins like the train's (`harness-trains`) is listed too, and left alone.
    for (const ref of await this.deps.reads.current(this.repo, `/repos/${this.repo}/git/matching-refs/heads/${TRAIN_BRANCH.slice(0, -1)}?per_page=${PAGE}`, 1)) {
      const left = String(ref.ref ?? '').replace(/^refs\/heads\//, '')
      if (own(left)) await this.drop(left)
    }
    const ref = await this.deps.reads.one(this.repo, `/repos/${this.repo}/git/ref/heads/${this.base}`), from = String(object(ref.object).sha ?? '')
    if (ref.ref !== `refs/heads/${this.base}` || object(ref.object).type !== 'commit' || !SHA.test(from)) throw this.stop('TRAIN_UNREADABLE', `GitHub's answer for ${this.base} is not one the train reads.`)
    const branch = `${TRAIN_BRANCH}${this.deps.now()}`
    await this.sent('POST', '/git/refs', [201], { ref: `refs/heads/${branch}`, sha: from })
    let tip = from
    const members: T[] = [], untaken: T[] = []
    for (const pull of riders) {
      const reply = await this.sent('POST', '/merges', pull.fork && !carried.has(`${pull.number}@${pull.head}`) ? [201, 204, 409, 404] : [201, 204, 409],
        { base: branch, head: pull.head, commit_message: `${TITLE}#${pull.number}` })
      // Nothing is opened this pass, so no more is asked.
      if (reply.status === 404) { untaken.push(pull); break }
      // A conflict with the base or with a member before it: left out, and its author told once for this head.
      if (reply.status === 409) { await this.host.conflicts(pull); continue }
      // The branch holds it already (merged by hand meanwhile): nothing of it to carry.
      if (reply.status === 204) continue
      const merge = object(reply.body), parents = Array.isArray(merge.parents) ? merge.parents.map(parent => object(parent).sha) : []
      // Always a merge commit of its own, with exactly the tip the train built as its first parent and the member as its
      // second: a commit anyone pushed onto the branch meanwhile never gets into a train (review 1 of #3226).
      if (!SHA.test(String(merge.sha)) || merge.sha === pull.head || parents.length !== 2 || parents[0] !== tip || parents[1] !== pull.head) {
        throw this.stop('TRAIN_PUSHED', `the merge of #${pull.number} into ${branch} is not on the tip the train built.`)
      }
      tip = String(merge.sha)
      members.push(pull)
    }
    // The same 404 answers a merge into a branch that is gone: with the train's own branch deleted under the build, it was
    // no word on the fork's head, and nothing merges on its own.
    if (untaken.length || !members.length) return await this.drop(branch) ? untaken : []
    // Marked as this login's build before the pull request exists: what is pushed to the branch from here on is not.
    await this.sent('POST', `/statuses/${tip}`, [201], { state: 'success', context: TRAIN_MARK, description: 'Built by Harness from pull requests that were read.' })
    const opened = object((await this.sent('POST', '/pulls', [201], { head: branch, base: this.base, draft: false, title: `${TITLE}${members.map(m => `#${m.number}`).join(' ')}`,
      body: trainBody(this.base, tip, members.map(m => ({ number: m.number, head: m.head, readers: m.readers.join(' and ') }))) })).body)
    const [train] = await this.mine([opened])
    if (!train) throw this.stop('TRAIN_UNREADABLE', `GitHub's answer to opening the train on ${branch} is not one the train reads.`)
    // Opened at another head than the tip built: someone pushed onto the branch between the last merge and here.
    if (train.head !== tip) { await this.close(train, 'other', 'its branch is not at the tip the train built'); return [] }
    this.deps.log(`[super-tab] train ${this.repo}#${train.number} built on ${from.slice(0, 7)}: ${members.map(m => `#${m.number}`).join(' ')}`)
    return []
  }

  /** Tells the members of merged [train] still open at the head it names; their numbers. Landed as a merge commit, GitHub
   *  marks each merged by itself, a moment later: closed here first, one would stay closed and never read as merged. Landed
   *  any other way, each is closed here and the train's branch deleted. A member already told is not told again. [kept]: whether
   *  it landed as a merge commit, when this pass landed it; a train found merged is read from its landing commit, whose
   *  second parent is then the train's tip. */
  private async finish(train: Train, sha: string, kept?: boolean): Promise<number[]> {
    const open = train.members.filter(member => this.pulls.some(pull => Number(pull.number) === member.number && object(pull.head).sha === member.head))
    if (!open.length) return []
    if (kept === undefined) {
      // Found merged, not landed by this pass: its body may have been written since.
      if (!await this.genuine(train)) return []
      const landing = await this.deps.reads.one(this.repo, `/repos/${this.repo}/git/commits/${sha}`)
      kept = Array.isArray(landing.parents) && landing.parents.length === 2 && object(landing.parents[1]).sha === train.tip
    }
    const said = `landed in #${train.number} as `
    for (const member of open) {
      const comments = await this.deps.reads.current(this.repo, `/repos/${this.repo}/issues/${member.number}/comments?per_page=${PAGE}`, 3)
      if (!comments.some(comment => TEAM.has(comment.author_association) && String(comment.body ?? '').slice(0, 500).includes(said))) {
        await this.sent('POST', `/issues/${member.number}/comments`, [201],
          { body: `${this.host.stamp()}: ${said}${sha.slice(0, 7)}. READ-OK on ${member.head.slice(0, 7)} by ${member.readers}, checks green.` })
      }
      if (!kept) await this.sent('PATCH', `/pulls/${member.number}`, [200], { state: 'closed' })
    }
    if (!kept) await this.drop(train.branch)
    return open.map(member => member.number)
  }

  /** Closes [train]'s pull request, titled by why it [end]ed (ENDS), and deletes its branch. */
  private async close(train: Train, end: TrainEnd, why: string): Promise<void> {
    await this.sent('PATCH', `/pulls/${train.number}`, [200], { state: 'closed', ...end === 'other' ? {} : { title: `${ENDS[end]}${train.members.map(m => `#${m.number}`).join(' ')}` } })
    await this.drop(train.branch)
    this.deps.log(`[super-tab] train ${this.repo}#${train.number} closed: ${why}`)
  }

  /** Deletes a train's [branch], and says whether it was there; one already gone (422) is done. Never a ref that is not the
   *  train's own. */
  private async drop(branch: string): Promise<boolean> {
    if (!own(branch)) throw this.stop('TRAIN_UNREADABLE', 'a branch to delete is not one of the train\'s.')
    return (await this.sent('DELETE', `/git/refs/heads/${branch}`, [204, 422])).status === 204
  }

  /** [pull] as a train, or null when it is none of this repository's: another branch, another base, or a fork's, which may
   *  take any branch name, and closing it would delete the live train's branch here (review 2 of #3226). */
  private trainOf(pull: Json): Train | null {
    const head = object(pull.head), branch = String(head.ref ?? ''), number = Number(pull.number)
    if (!own(branch) || String(object(head.repo).full_name ?? '').toLowerCase() !== this.repo.toLowerCase() || object(pull.base).ref !== this.base
      || !Number.isSafeInteger(number)) return null
    const built = trainOfBody(String(pull.body ?? ''))
    return { number, branch, head: String(head.sha ?? ''), tip: built?.tip ?? '', members: built?.members ?? [], red: String(pull.title ?? '').startsWith(RED_TITLE),
      mergedAs: typeof pull.merged_at === 'string' && SHA.test(String(pull.merge_commit_sha)) ? String(pull.merge_commit_sha) : null,
      openedAt: Date.parse(String(pull.created_at ?? '')), opener: String(object(pull.user).login ?? '').toLowerCase() }
  }

  /** A write to [repo], answered with one of [statuses]: any other answer stops the repository's pass. What was read before it
   *  is read again. */
  private async sent(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, statuses: readonly number[], body?: unknown): Promise<GitHubReply> {
    const reply = await this.deps.send(method, `/repos/${this.repo}${path}`, body)
    this.deps.reads.forget(this.repo)
    if (reply.resetAt !== null) throw new GitHubStop('RATE_LIMITED', 'GitHub is limiting this computer\'s requests.', true, reply.resetAt)
    if (!statuses.includes(reply.status)) throw new GitHubStop('TRAIN_REFUSED', `GitHub answered ${method} ${path} with ${reply.status}.`, reply.status >= 500, this.deps.now())
    return reply
  }

  private stop(code: string, message: string): GitHubStop { return new GitHubStop(code, message, false, this.deps.now()) }
}
