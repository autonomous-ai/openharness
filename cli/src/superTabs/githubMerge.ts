/**
 * Harness merges a Swarm v4 team's pull requests by rule, as lampOS's train bot does (its docs/joining.md, "Trains, reads
 * and promotes"; anh Dee, 2026-11-09: "go build it"). Agents never merge: in the swarm-sandbox run Claude Code's auto mode
 * refused every merge an agent tried after its READ-OK, and switching that check off for agents is not ours to do. The rule
 * is code, run by the Harness of the person whose agent is the project's PM, with that person's own gh login: one merger
 * for a project, as lampOS runs one train bot.
 *
 * A pull request into the default branch is ready to land when
 * - it is not a draft;
 * - its head has a READ-OK from someone other than its writers: `READ-OK <sha>` as a comment's or a review's own, in its first
 *   line (pullTalk, ownVerdict), the reader the name it is signed with ("Juno, 14:20, to **Pip**: READ-OK f6edb44"), or its
 *   GitHub login when unsigned; two from two readers when its text or a comment's first line says TWO READS. A comment signed by
 *   one of its writers (writersOf), in any spelling, is that writer's, and an unsigned READ-OK from the login that opened it
 *   counts for nothing (verdicts);
 * - no reader's last word on it is a HOLD: a HOLD stands until that reader's later READ-OK;
 * - every check on its head passed;
 * - GitHub says it can merge;
 * - and no other open pull request is one it lands after: one whose head is among its commits, or one of the team's for a task
 *   its own task says it comes after.
 * One that cannot, being behind or in conflict, or whose checks failed, is told so on itself, to its author by name, once for
 * each head, so the GitHub news brings it to its author (githubMentions.ts). One that lands after another is told which, and
 * no more. One that touches a file most landings touch which an older one of another builder's touches too is told which, once,
 * as it opens, so its builder reads that one first; it lands as any other (hot files: the allocator's design, package 8).
 *
 * The ready ones land on a train (githubTrain.ts): one branch, one run of the checks on the combined change. Only one that is
 * alone and holds the base's tip, or a fork's whose head GitHub does not take into a train, is merged on its own, squashed, as
 * every one was until 2026-11-10.
 */
import { createHash } from 'node:crypto'
import { dependsOn, labelOf, readerKey, sameKey, tasksOf, teamOf, type Crew } from './assign/crew.js'
import type { GitHubGet, GitHubSend } from './githubRest.js'
import { GitHubReads, GitHubStop, PAGE, retryIn, STOP_ASKING, Waits, waitWords } from './githubRest.js'
import { projectRepositorySlug, TEAM } from './githubMentions.js'
import { APP, GitHubTrain, STATUS, TRAIN_MARK, type TrainPull } from './githubTrain.js'
import { plainPath } from './plainPath.js'
import { COST_NUMBERS, costLine, TASK_NUMBER_MAX, type ReadRow } from './taskTokens.js'
import { identifier, object, within } from './wire.js'

type Json = Record<string, unknown>

export const MERGE_INTERVAL_MS = 30_000
/** Open pull requests are read a hundred a page, the most recently updated first, up to this many pages each pass: a busy shared
 *  repository has over a hundred open (lampOS and openharness about 110 each, 2026-11-10), and the team's own can be any of
 *  them. The newest thirty alone left an older team pull request unread and unmerged for good. */
export const PULL_PAGES = 3
export const openPullsPath = (repo: string): string => `/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${PAGE}`
/** How often the projects whose PM runs here are asked again: each ask reads the PM's Swarm. */
const PROJECTS_FRESH_MS = 60_000
/** A verdict as lampOS's readers write it: `READ-OK <sha>` or `HOLD <sha>`, the sha at least 7 hex digits, in bold or
 *  backticks and with its pull request's `#N` before the sha (markers.py parse_marker). */
const VERDICT = /(?<![\w-])(READ-OK|HOLD)\*{0,2}\s+(?:#\d+\s+)?`?([0-9a-f]{7,40})(?![0-9a-f])/g

/**
 * The verdict a comment's first line gives as its own, or null. A verdict talked about is none, as lampOS's markers.py reads
 * them, each rule from a pull request held or merged wrongly: one on a quoted line or a line opening a code fence (#5068: an
 * author's "> READ-OK <head>" counted as a second read), named as a noun or as someone's (#3371: "your HOLD 889b694ea",
 * #5068: "the Reviewer-lead's READ-OK"), in brackets (#3608: "(HOLD 3e741c220)"), right after a backtick or a quotation mark
 * (#3781: "`HOLD 73aa8b23f`"), or inside quotation marks on the line (swarm-sandbox #24: "as in "Juno, HH:MM: READ-OK
 * 239a631"", an ask's example).
 */
function ownVerdict(line: string): { verdict: 'READ-OK' | 'HOLD'; sha: string } | null {
  if (/^\s*>/.test(line) || /^ {0,3}(?:`{3,}|~{3,})/.test(line)) return null
  for (const found of line.matchAll(VERDICT)) {
    const before = line.slice(0, found.index)
    if (/(?:\b(?:your|for|the|that|this|their|his|her|its|my|our)|['’]s)\s+\**$/i.test(before)) continue
    if (/[(\[]\**`?$/.test(before) || /[`"“”'‘]\**$/.test(before)) continue
    if ((before.match(/["“”]/g) ?? []).length % 2 === 1) continue
    return { verdict: found[1] as 'READ-OK' | 'HOLD', sha: found[2]! }
  }
  return null
}

/** A comment's first line with words: where its verdict is read. */
const firstLine = (comment: Json): string => String(comment.body ?? '').split('\n').find(line => line.trim()) ?? ''

/** The verdict a comment of the team's gives as its own (ownVerdict), or null: for what counts verdicts by their time and not
 *  by their reader, the day's scoreboard (scoreboard.ts). */
export const verdictOf = (comment: Json): 'READ-OK' | 'HOLD' | null => TEAM.has(comment.author_association) ? ownVerdict(firstLine(comment))?.verdict ?? null : null

/** A pull request's comments and its reviews' bodies, as one list in time order. A review's body reads exactly as a comment's
 *  (lampOS #5212: El posted its reads as reviews, and four pull requests each counted one read short), its state (APPROVED,
 *  CHANGES_REQUESTED, ...) is never a read, and a review with no words, not submitted or dismissed counts for nothing
 *  (markers.py merge_reviews). A list that cannot be read stops the pass, as any read: nothing merges on half of it. */
export async function pullTalk(reads: GitHubReads, repo: string, number: number): Promise<Json[]> {
  const comments = await reads.current(repo, `/repos/${repo}/issues/${number}/comments?per_page=${PAGE}`, 3)
  const reviews = (await reads.current(repo, `/repos/${repo}/pulls/${number}/reviews?per_page=${PAGE}`, 3))
    .filter(r => String(r.body ?? '').trim() && typeof r.submitted_at === 'string' && r.submitted_at && !['PENDING', 'DISMISSED'].includes(String(r.state)))
    .map(r => ({ body: r.body, user: r.user, author_association: r.author_association, created_at: r.submitted_at, review: true }))
  // Stable: a comment and a review of one time keep the comment first, as markers.py does.
  return [...comments, ...reviews].sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
}
/** A post's signature: its writer's name first, then a comma, colon or bracket ("Juno, 14:20:", "**Faye** (PM):"). A name
 *  after an @ is the one spoken to ("@Pip, HOLD ..."), not the writer. */
const SIGNATURE = /^[^\w@＠﹫]*([A-Za-z][\w-]*(?: [A-Za-z][\w-]*)?)\**\s*[,:(]/
const SELF = 'Harness'
/** How each note to a pull request's author begins, after "not merged yet at <head>: ". A note is said once for each pull
 *  request, kind and head, as lampOS's train bot keys what it told (`<PR> <kind> <head>`, train-bot.sh), never by its words:
 *  swarm-sandbox #24-#26 got one note 46 times each when its words carried the time (2026-11-10), and the failing checks of one
 *  head can change and change order. A restart finds a note said by these first words. */
const NOTES = { unsigned: 'the READ-OK from ', held: 'the HOLD from ', checks: 'checks failed: ', behind: 'it is behind ', dirty: 'it conflicts with ',
  blocked: 'GitHub\'s rules for ', stacked: 'it lands after ', red: 'its train failed: ', left: 'its builder ', unreported: 'its train never got ' } as const
type NoteKind = keyof typeof NOTES
/** How the `stacked` note began until 2026-11-12, when it ended "then update it from main": one posted then is still its head's
 *  note, so a restart does not say it again in today's words. These can go after 2026-12-12. */
const STACKED_BEFORE = 'it carries open '
/** The first words a note of [kind] may begin with, today's first. */
const startsOf = (kind: NoteKind): string[] => kind === 'stacked' ? [NOTES.stacked, STACKED_BEFORE] : [NOTES[kind]]
const noteStart = (head: string, words: string): string => `not merged yet at ${head.slice(0, 7)}: ${words}`
/** Which of these notes a comment of the team's is, on whatever head, or null: the day's scoreboard counts the pull requests
 *  told they were behind or in conflict (scoreboard.ts). Read where `said` reads one: in its first 500 characters. */
export function noteOf(comment: Json): NoteKind | null {
  const rest = TEAM.has(comment.author_association) ? /not merged yet at [0-9a-f]{7}: (.*)/s.exec(String(comment.body ?? '').slice(0, 500))?.[1] : undefined
  return rest === undefined ? null : (Object.keys(NOTES) as NoteKind[]).find(kind => startsOf(kind).some(words => rest.startsWith(words))) ?? null
}
/** The most tasks of one pull request whose text is read for what they come after (earlierPull): a pull request is one task's
 *  work, and its text can name any number of them. */
const TASKS_READ_MAX = 5
/** How many of the older pull requests on files most landings touch the note names (tellNear); it counts the rest. */
const NEAR_NAMED = 3
/** Whether one of the team's [comments] is the note of the older pull requests on files most landings touch (tellNear), by how it
 *  begins, read whole: one that named every older one grew past what a restart read of it (review of #4177). */
const nearSaid = (comments: readonly Json[]): boolean =>
  comments.some(comment => TEAM.has(comment.author_association) && /^Harness, \d\d:\d\d, to \*\*.+?\*\*: #\d+ already touches `/.test(String(comment.body ?? '')))
/** Whether [pull] is one of the [team]'s: its branch or label names a builder, and GitHub says its author is a member of the
 *  repository, as every word Harness takes from a comment: anyone can name a fork's branch `pip/2` (review of #4121). */
function ofTeam(pull: Json, team: ReadonlySet<string>): boolean {
  const author = authorOf(pull)
  return author !== null && team.has(labelOf(author)) && TEAM.has(pull.author_association)
}
/** An older open pull request of another builder's on a file most landings touch, which a newer one touches too: its number and
 *  the first such file. */
interface Near { number: number; file: string }
/** The most heads whose files are kept, the ones read longest ago going first: a busy repository has a few hundred open. */
const FILES_KEPT = 1_000
/** How long after a head is first seen its checks may count as passed, and then only when two looks in a row read them the same:
 *  lampOS's merge-when-green.sh waits for "the same in two looks 30 s apart, from 3 min on". A head just pushed has no checks
 *  yet, which read as all passed, and a job that needs another gets its check only when that one ends. */
const CHECKS_SETTLE_MS = 3 * 60_000
/** How the assigner's word on a task begins when it gives it (githubAssign.ts give): "Harness, 09:30: for **Pip**: ...". */
const GAVE = /^Harness, \d\d:\d\d: for \*\*([^*]+)\*\*: /
/** How many notes are remembered, as the train bot keeps the last 5,000 lines of its told list. */
const TOLD_MAX = 5_000
/** Records asked for in one request (the backend takes at most 100 ids), how many are remembered, and how long after a comment
 *  was written one with no record is taken as typed by hand: the command records it within seconds of posting it. */
const AUTHORS_PAGE = 100, RECORDED_MAX = 5_000
export const RECORD_SETTLE_MS = 2 * 60_000
/** How long an answer about a comment is kept before it is asked about again: a record made late (the command run again after
 *  the server refused it) and an agent's new name are read within it, with no restart. */
const RECORD_AGAIN_MS = 10 * 60_000

/** How long the comment that says a change landed waits for the server's word on what it cost (taskTokens.ts): the change has
 *  landed, and its comment is what tells its author and closes it. */
export const COST_WAIT_MS = 5_000
/** How long a repository's costs are not asked for again after the server did not give one. */
export const COST_AGAIN_MS = 15 * 60_000

/** A ready pull request, with what a note to its author takes (tellOnce). */
interface Ready extends TrainPull { author: string; comments: Json[] }
/** The label a person puts on a pull request to keep Harness from landing it (AGENTS.md). */
const HOLD_LABEL = 'hold'
/** Whether a person put [pull] on hold: the label in any case, as GitHub keeps one label whatever its case. The merger merges
 *  none, the assigner asks no reader for one, and its builder is typed nothing of it (nextThing.ts). */
export const isHeld = (pull: Json): boolean => (Array.isArray(pull.labels) ? pull.labels.map(object) : []).some(label => String(label.name).toLowerCase() === HOLD_LABEL)

/** A project whose PM runs on this computer as its person: the merger merges its repository's pull requests, and the
 *  assigner gives its tasks (githubAssign.ts). Its Swarm, its PM and the project, to read its crew as the PM. */
export interface LedProject { repo: string; pm: string; tabId: string; pmAgentId: string; projectId: string }

/** Who the backend recorded as the writer of each of a project's GitHub comments [ids] (`issue:<id>`, at most 100), read as the
 *  project's PM through [ask], the backend's GET (backend superTabs/githubComments.ts). Ids with no record are left out. */
export const recordedAuthors = (ask: (path: string) => Promise<unknown>) => async (project: LedProject, ids: string[]): Promise<Record<string, { name: string }>> => {
  const answer = object(await ask(`/api/super-tabs/${project.tabId}/github-comments?repository=${encodeURIComponent(project.repo)}`
    + `&ids=${ids.map(encodeURIComponent).join(',')}&asAgentId=${project.pmAgentId}`))
  return Object.fromEntries(Object.entries(object(answer.authors)).map(([id, author]) => [id, { name: String(object(author).name ?? '') }]))
}

/** Whether [project]'s PM runs on this computer: the session of its roster row's agent is registered here ([running], by its
 *  harness id). A project is led here while its PM is stopped too (ledProjects). */
export function pmRunsHere(roster: Json[], project: LedProject, running: (harnessId: string) => boolean): boolean {
  const agent = roster.map(row => object(row.agent)).find(agent => agent.id === project.pmAgentId)
  return typeof agent?.harnessId === 'string' && running(agent.harnessId)
}

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
    const repo = projectRepositorySlug(project)
    if (repo && identifier(project?.id) && !found.has(repo)) {
      found.set(repo, { repo, pm: String(agent.displayName ?? agent.name ?? 'PM'), tabId: row.tabId, pmAgentId: agent.id, projectId: project.id })
    }
  }
  return [...found.values()]
}

/** Who a pull request's verdicts can be from: its [writers] (writersOf), the GitHub [opener] that opened it, and its [team]'s
 *  builder labels (teamOf). */
export interface PullPeople { writers: readonly string[]; opener: string; team: ReadonlySet<string> }

/** A verdict's own words where a signature would be ("READ-OK f6edb44: looks good"): no one's name. */
const VERDICT_FIRST = /^(?:READ-OK|HOLD)\b/

/** What one pull request's comments say: each reader's last verdict, by its name as `sameKey` reads it, with the name as it signs,
 *  and whether it asks for two reads. A comment signed by one of its writers (`signedAs`) is that writer's, by the name the
 *  pull request gives it: the signature pattern reads one or two plain words, and a name it cannot read (three words, another
 *  script, an apostrophe, an emoji) fell back to the GitHub login every agent of a person shares, so the author read as a reader.
 *  From the login that opened it, which every agent of the author's person posts as, a signature is one only when it names one
 *  of the team; any other is unsigned, its reader that login, and its READ-OK is `ownLogin`: it counts for no read. */
export function verdicts(comments: Json[], body: string, people: PullPeople):
  { readers: Map<string, Verdict>; twoReads: boolean } {
  // Each reader's HOLDs that stand, its last READ-OK made by command, and its last typed one, by its name as sameKey reads it.
  const said = new Map<string, { holds: Said[]; ok?: Said; typed?: Said }>()
  let twoReads = /\bTWO READS\b/.test(body)
  // The team's names as sameKey reads them, from its builder labels: a team agent is known however it signs.
  const team = new Set([...people.team].map(label => sameKey(label.replace(/^builder:/i, ''))))
  for (const comment of comments) {
    if (!TEAM.has(comment.author_association)) continue
    const first = firstLine(comment)
    if (/\bTWO READS\b/.test(first)) twoReads = true
    const found = ownVerdict(first)
    if (!found) continue
    const login = String(object(comment.user).login ?? '')
    const fromOpener = people.opener !== '' && login.toLowerCase() === people.opener.toLowerCase()
    const pattern = SIGNATURE.exec(first)?.[1]
    // The agent the backend recorded as this comment's writer (VerdictRecords) is its reader, whatever the comment
    // opens with: the command that made it knew the agent from its session, and a name can be typed by anyone.
    // From the login that opened the pull request it is one of the team's, as a typed signature must be: any other agent of
    // that person (review of #3906: its Buddy's record merged what its typed name did not) reads as that login.
    const named = typeof comment.recorded === 'string' && comment.recorded.trim() ? comment.recorded.trim() : undefined
    const recorded = named && (!fromOpener || team.has(sameKey(named))) ? named : undefined
    const signature = recorded ?? people.writers.find(writer => signedAs(first, writer))
      ?? (pattern && !VERDICT_FIRST.test(pattern) && (!fromOpener || team.has(sameKey(pattern))) ? pattern : undefined)
    const reader = signature ?? login
    if (!reader || reader === SELF) continue
    // One reader however it writes its name (a HOLD as "Kai Lee" is lifted by its READ-OK as "kai-lee"); a name of no letters
    // or digits, as written.
    const key = readerKey(reader)
    const mine = said.get(key) ?? { holds: [] }
    said.set(key, mine)
    const writer = isWriter(people.writers, reader), ownLogin = !signature && fromOpener
    const one: Said = { verdict: found.verdict, sha: found.sha, name: reader, ownLogin, recorded: !!recorded, byCommand: !!named, retyped: false,
      at: String(comment.created_at ?? ''), login: login.toLowerCase(), unsigned: !signature, own: writer || ownLogin }
    // A HOLD, typed or made by command, stands until a READ-OK made by command lifts it.
    if (found.verdict === 'HOLD') { mine.holds.push(one); continue }
    // A typed READ-OK is no read and lifts nothing: a name can be typed by anyone, from any login (plan item 3; review of #3708:
    // a writer's READ-OK from another login read as a reader's, and a HOLD was lifted by a login that reads as its reader's name).
    // Only its own unsigned HOLDs does a login take back by typing: none of another's, and none of the login that opened it,
    // which its writer posts as. A person has no command to run.
    if (!recorded) {
      mine.typed = one
      if (!ownLogin) mine.holds = mine.holds.filter(hold => !(hold.unsigned && !hold.own && hold.login === one.login && hold.at <= one.at))
      continue
    }
    mine.ok = one
    if (writer) continue
    // A READ-OK made by command lifts, made after them (so on their head or a later one: the command reads the head): its own
    // reader's HOLDs, typed or not; the HOLDs of the pull request's own side, which no reader is asked to lift (its writers' own,
    // and unsigned ones from the login that opened it, which every agent of its person posts as); and the unsigned HOLDs of the
    // login it was posted from.
    const lifts = (holder: string, hold: Said) => hold.own || (hold.unsigned ? hold.login === one.login : holder === key)
    for (const [holder, theirs] of said) theirs.holds = theirs.holds.filter(hold => hold.at > one.at || !lifts(holder, hold))
  }
  const readers = new Map<string, Verdict>()
  for (const [key, mine] of said) {
    const last = mine.holds.at(-1) ?? mine.ok ?? mine.typed
    // A HOLD its reader answered with a typed READ-OK: it is asked to make that by command (githubAssign.ts).
    const retyped = last?.verdict === 'HOLD' && !!mine.typed && mine.typed.at > last.at
    if (last) readers.set(key, { verdict: last.verdict, sha: last.sha, name: last.name, ownLogin: last.ownLogin, recorded: last.recorded, byCommand: last.byCommand, retyped, at: last.at })
  }
  return { readers, twoReads }
}
/** A reader's verdict as `verdicts` reads it: whether it counts as made by command (`recorded`) or was made by one whose agent is
 *  no teammate (`byCommand` alone), whether it is an unsigned one from the login that opened the pull request (`ownLogin`), and,
 *  for a HOLD, whether its reader answered it with a typed READ-OK (`retyped`). */
export interface Verdict { verdict: 'READ-OK' | 'HOLD'; sha: string; name: string; ownLogin: boolean; recorded: boolean; byCommand: boolean; retyped: boolean; at: string }
interface Said extends Verdict { login: string; unsigned: boolean; own: boolean }


/** Who made each of a project's verdicts by command, as the backend recorded it (backend superTabs/githubComments.ts), for the
 *  merger and the assigner alike. */
export class VerdictRecords {
  /** Who the backend recorded as the writer of a verdict's comment, by `<repo>#<comment id>`; null for one it has no record of
   *  (typed by hand). A record never changes, so each comment is asked about once. */
  private readonly recorded = new Map<string, { name: string | null; at: number }>()
  /** Each repository whose records the backend did not give: left alone, longer each time (retryIn), and said once. */
  private readonly down = new Map<string, { misses: number; againAt: number }>()

  constructor(private readonly authors: (project: LedProject, ids: string[]) => Promise<Record<string, { name: string }>>,
    private readonly now: () => number, private readonly log: (line: string) => void) {}

  /**
   * [comments] with the agent the backend recorded for each verdict among them (`recorded`), which `verdicts` counts as its
   * reader. Only a comment that gives a verdict is asked about, once: a record is made as the comment is, so one with none two
   * minutes after it was written was typed by hand. Null while a verdict among them was never answered for and the backend
   * cannot be asked: only a READ-OK made by command is a read, so it cannot be told from a typed one. Said once per repository.
   */
  async named(project: LedProject, comments: Json[]): Promise<Json[] | null> {
    const key = (comment: Json) => `${project.repo}#${String(comment.id)}`
    // A comment changed since it was written is not the words its record was made for (the command never edits): typed by hand.
    const asWritten = (comment: Json) => comment.updated_at === undefined || comment.updated_at === comment.created_at
    const given = comments.filter(comment => Number.isSafeInteger(comment.id) && comment.review !== true && asWritten(comment)
      && ownVerdict(firstLine(comment)))
    const unknown = given.filter(comment => this.now() - (this.recorded.get(key(comment))?.at ?? -Infinity) >= RECORD_AGAIN_MS)
    for (let from = 0; from < unknown.length && this.now() >= (this.down.get(project.repo)?.againAt ?? 0); from += AUTHORS_PAGE) {
      const page = unknown.slice(from, from + AUTHORS_PAGE)
      try {
        const authors = await this.authors(project, page.map(comment => `issue:${String(comment.id)}`))
        for (const comment of page) {
          const name = authors[`issue:${String(comment.id)}`]?.name
          const settled = this.now() - Date.parse(String(comment.created_at ?? '')) >= RECORD_SETTLE_MS
          this.recorded.delete(key(comment))
          if (typeof name === 'string' && name.trim()) this.recorded.set(key(comment), { name, at: this.now() })
          else if (settled) this.recorded.set(key(comment), { name: null, at: this.now() })
        }
        if (this.down.delete(project.repo)) this.log(`[super-tab] verdicts' records are read again · ${project.repo}`)
      } catch (error) {
        const misses = (this.down.get(project.repo)?.misses ?? 0) + 1
        if (misses === 1) this.log(`[super-tab] verdicts' records cannot be read: nothing merges and no reader is asked · AUTHORS_UNREAD ${project.repo}: ${error instanceof Error ? error.message : 'the server did not answer'}`)
        this.down.set(project.repo, { misses, againAt: this.now() + retryIn(misses) })
      }
    }
    while (this.recorded.size > RECORDED_MAX) this.recorded.delete(this.recorded.keys().next().value!)
    // A verdict never answered for while the backend cannot be asked: nothing can be read of this pull request yet.
    if (this.down.has(project.repo) && given.some(comment => !this.recorded.has(key(comment)))) return null
    return comments.map(comment => {
      const name = Number.isSafeInteger(comment.id) && asWritten(comment) ? this.recorded.get(key(comment))?.name : undefined
      return name ? { ...comment, recorded: name } : comment
    })
  }
}

/** The most files GitHub lists in one compare: a change of that many or more cannot be read whole. */
const COMPARE_FILES_MAX = 300
/** Changes kept by each merger and assigner: what a commit changes since its merge base does not change. */
const PATCHES_MAX = 1_000

/** A hunk's line numbers, which a rebase moves; what follows them (the heading the hunk is under) stays. */
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/
/** A submodule's whole patch: the commit it points at. */
const SUBMODULE = /^[+-]Subproject commit [0-9a-f]{40,64}$/

/** One hunk of a patch: where it begins in the file it was made from and how many of that file's lines it stands on, and each
 *  run of rows it changes: the line of that file it is at, how many lines it removes there and how many it adds. */
interface Hunk { start: number; was: number; runs: Array<[at: number, removed: number, added: number]> }
/** What a commit changes since the commit of the base it stands on ([from]): its change in one word, and each file's hunks,
 *  by the name the file had there. */
interface Change { hash: string; from: string; hunks: Map<string, Hunk[]> }

/** A patch's hunks, in order. */
function hunksOf(rows: readonly string[]): Hunk[] {
  const hunks: Hunk[] = []
  let line = 0, run: Hunk['runs'][number] | null = null
  for (const row of rows) {
    const head = HUNK.exec(row)
    if (head) { hunks.push({ start: Number(head[1]), was: Number(head[2] ?? 1), runs: [] }); line = Number(head[1]); run = null; continue }
    const hunk = hunks.at(-1)
    if (!hunk) continue
    if (row.startsWith('+') || row.startsWith('-')) {
      if (!run) hunk.runs.push(run = [line, 0, 0])
      if (row.startsWith('-')) { run[1]++; line++ } else run[2]++
    } else if (row.startsWith(' ')) { run = null; line++ }
  }
  return hunks
}

/**
 * A compare's files as one change: each file's status and names and its patch as GitHub gives it, without each hunk's line
 * numbers. The lines around the added and removed ones count, and the heading each hunk is under: read without them, as
 * lampOS's `git diff -U0 | git patch-id` did, the same line added in another function was the same change, and a READ-OK
 * carried to code nobody had read. A rebase onto a base that changed those very lines is read again. Where each hunk is, is
 * given beside it (sameChange counts it: the same lines may stand in several places of a file).
 *
 * A file GitHub gives no patch for and counts no changed lines in (a binary, a rename alone, an empty file) is its content, by
 * its blob: two heads that differ only in a binary are two changes.
 *
 * Null, so a verdict counts only on its own head: when a file with changed lines has no patch (too large for GitHub to
 * give); when one with no lines names no blob (a mode change alone: GitHub sends none); when a file may be a symbolic link or
 * a submodule (the compare does not say a file's kind; a link's patch is its target with no newline at its end and no line
 * around it, a submodule's its commit: a regular file with that text would read the same); or when the list may be cut short.
 * Not told apart, as the compare carries no mode: an executable bit on a file that is added or edited.
 */
function changeOf(files: Json[]): { hash: string; hunks: Map<string, Hunk[]> } | null {
  if (files.length >= COMPARE_FILES_MAX) return null
  const parts: string[] = [], hunks = new Map<string, Hunk[]>()
  for (const file of [...files].sort((a, b) => String(a.filename ?? '').localeCompare(String(b.filename ?? '')))) {
    const rows = String(file.patch ?? '').split('\n')
    const lines = rows.filter(row => row.startsWith('+') || row.startsWith('-'))
    const whole = lines.length > 0
    if (!whole && (Number(file.changes ?? 0) > 0 || !/^[0-9a-f]{40,64}$/.test(String(file.sha ?? '')))) return null
    const link = whole && rows.some(row => row.startsWith('\\')) && !rows.some(row => row.startsWith(' '))
    if (link || (whole && lines.every(line => SUBMODULE.test(line)))) return null
    parts.push(JSON.stringify([String(file.status ?? ''), String(file.previous_filename ?? ''), String(file.filename ?? ''),
      whole ? rows.map(row => row.replace(HUNK, '@@')) : [String(file.sha)]]))
    // By the name it had on the base: its hunks are numbered in that file. A name listed twice is not read.
    const was = String(file.previous_filename || file.filename || '')
    if (hunks.has(was)) return null
    hunks.set(was, hunksOf(rows))
  }
  return { hash: createHash('sha256').update(parts.join('\n')).digest('hex'), hunks }
}

/** One compare, kept in [kept] under its two ends: null when GitHub cannot give it, or does not know a commit. A commit's
 *  change since another does not change. */
async function compared<T>(reads: GitHubReads, kept: Map<string, unknown>, repo: string, kind: 'change' | 'moved', from: string, to: string,
  read: (compare: Json) => T | null): Promise<T | null> {
  const key = `${kind}\n${repo}\n${from}\n${to}`
  if (kept.has(key)) return kept.get(key) as T | null
  let found: T | null
  try {
    // The base with itself may be hundreds of commits: its files are on the first page, and one commit of them is asked for.
    found = read(await reads.one(repo, `/repos/${repo}/compare/${from}...${to}${kind === 'moved' ? '?per_page=1' : ''}`))
  } catch (error) {
    if (!(error instanceof GitHubStop) || error.everywhere) throw error
    found = null
  }
  kept.set(key, found)
  if (kept.size > PATCHES_MAX) kept.delete(kept.keys().next().value!)
  return found
}

/**
 * What [sha] changes since its merge base with [base], as lampOS's lib.sh patch_of reads it (`git diff <merge base> <sha> |
 * git patch-id`), from GitHub's compare, kept in [kept]. Null when GitHub cannot give it whole, or does not know the commit: no
 * failure of the repository, and a verdict on it then counts only on its own head. Whitespace counts here, where patch-id drops
 * it: a change of spaces alone is read again.
 */
const patchOf = (reads: GitHubReads, kept: Map<string, unknown>, repo: string, base: string, sha: string): Promise<Change | null> =>
  compared(reads, kept, repo, 'change', base, sha, compare => {
    const change = Array.isArray(compare.files) ? changeOf(compare.files.map(object)) : null
    const from = String(object(compare.merge_base_commit).sha ?? '')
    return change && /^[0-9a-f]{40,64}$/.test(from) ? { ...change, from } : null
  })

/** How the base itself changed each file from its commit [from] to its later commit [to]: the hunks of each, by the name it
 *  had and the name it has, null for a file GitHub gives no patch for. Null when [to] does not hold [from], when the list may
 *  be cut short, or when it names a file twice. */
const movedBy = (reads: GitHubReads, kept: Map<string, unknown>, repo: string, from: string, to: string): Promise<Map<string, Hunk[] | null> | null> =>
  compared(reads, kept, repo, 'moved', from, to, compare => {
    const files = Array.isArray(compare.files) ? compare.files.map(object) : null
    if (!files || files.length >= COMPARE_FILES_MAX || compare.behind_by !== 0) return null
    const moved = new Map<string, Hunk[] | null>()
    for (const file of files) {
      for (const name of new Set([String(file.filename ?? ''), String(file.previous_filename || file.filename || '')])) {
        if (moved.has(name)) return null
        moved.set(name, typeof file.patch === 'string' ? hunksOf(file.patch.split('\n')) : null)
      }
    }
    return moved
  })

/** Whether each hunk of [now] is where [then] had it: at the same line when both stand on the same commit of the base, else
 *  further by what the base itself added or removed above it between the two. The lines around a change do not say where it
 *  is when the same lines stand in several places: a step added to one job of a workflow, and the same step added to another. */
async function inPlace(reads: GitHubReads, kept: Map<string, unknown>, repo: string, then: Change, now: Change): Promise<boolean> {
  const moved = then.from === now.from ? new Map<string, Hunk[] | null>() : await movedBy(reads, kept, repo, then.from, now.from)
  if (!moved) return false
  for (const [file, hunks] of now.hunks) {
    const were = then.hunks.get(file), base = moved.get(file)
    if (!were || were.length !== hunks.length || base === null) return false
    // Each run of lines the base changed by itself: a hunk of its patch joins runs within six lines of each other, one of
    // which may be above a change and one below.
    const runs = (base ?? []).flatMap(hunk => hunk.runs)
    for (const [at, hunk] of hunks.entries()) {
      const { start, was } = were[at]!
      let shift = 0
      for (const [line, removed, added] of runs) {
        // Wholly above the lines the hunk stands on: it moves them by what it added or removed. Among them: they are no
        // longer the lines that were read around the change. Below: nothing.
        if (line + removed <= start) shift += added - removed
        else if (line < start + was) return false
      }
      if (hunk.start !== start + shift) return false
    }
  }
  return true
}

/** Which of the verdicts' commits [shas] change what [head] changes (patchOf), where it changes it (inPlace): lampOS counts a
 *  READ-OK for the head "or a head whose diff from its merge base is the same patch, i.e. a plain rebase" (train-bot.sh).
 *  Updated from main with nothing of its own changed, a pull request waited on a reader who had read it all. Read only when a
 *  verdict is on an earlier head. */
export async function sameChange(reads: GitHubReads, kept: Map<string, unknown>, repo: string, base: string, head: string,
  shas: Iterable<string>): Promise<Set<string>> {
  const same = new Set<string>()
  const earlier = [...new Set(shas)].filter(sha => !head.startsWith(sha))
  if (!earlier.length) return same
  const now = await patchOf(reads, kept, repo, base, head)
  if (now === null) return same
  for (const sha of earlier) {
    const then = await patchOf(reads, kept, repo, base, sha)
    if (then && then.hash === now.hash && await inPlace(reads, kept, repo, then, now)) same.add(sha)
  }
  return same
}

/** Whether [name] is one of a pull request's [writers] (writersOf), however either is written. */
export const isWriter = (writers: readonly string[], name: string): boolean => writers.some(writer => sameKey(writer) === sameKey(name))

/** How much of a first line is read for a writer's name: enough for any name and its markup, and a line of 60,000 of one
 *  character costs nothing. */
const SIGNATURE_SCAN = 200

/** A character as a name is compared, one at a time: in lower case (a final sigma as any other), and nothing unless a letter or
 *  a digit. Its text is NFKC first, so letters typed in parts (Hangul jamo, an accent after its letter) are whole. */
const nameChar = (char: string): string => char.toLowerCase().replace(/ς/g, 'σ').replace(/[^\p{L}\p{N}]/gu, '')

/** Whether [line] is signed [name], however the name is written: the line's first letters and digits are the name's, then,
 *  before any other letter or digit, a comma, colon or bracket ("Đức Anh, 14:20:", "**Pip Two** (builder):", "Atlas Reed Two 🐝,").
 *  The name is read against the line, not the line by a pattern, so a name of any length, script or punctuation is known; one
 *  pass over at most 200 characters, stopped at the first letter that is not the name's. A name after an @ is the one spoken
 *  to: "@Pip, HOLD ..." from a reader was Pip's own, and Pip's READ-OK lifted it (review of #3708). */
export function signedAs(line: string, name: string): boolean {
  const want = [...name.normalize('NFKC')].map(nameChar).join('')
  if (!want) return false
  const text = line.slice(0, SIGNATURE_SCAN).normalize('NFKC')
  let key = '', at = 0
  for (const char of text) {
    at += char.length
    if (char === '@' && !key) return false
    const part = nameChar(char)
    if (!want.startsWith(part, key.length)) return false
    key += part
    if (key === want) return /^[^\p{L}\p{N}]*?[,:(]/u.test(text.slice(at))
  }
  return false
}

/** Every agent a pull request names as its writer: each builder label's name (`Builder:` in any case) and its branch's first part
 *  (`pip/12`). A task taken over can carry one agent's branch and another's label; neither of them reads it. */
export function writersOf(pull: Json): string[] {
  const labels = (Array.isArray(pull.labels) ? pull.labels.map(object) : []).map(l => String(l.name ?? '')).filter(name => /^builder:/i.test(name))
  const branch = String(object(pull.head).ref ?? '')
  return [...labels.map(name => name.slice('builder:'.length)), ...branch.includes('/') ? [branch.split('/')[0]!.toLowerCase()] : []]
}

/** A pull request's people for `verdicts`, with its [team]. */
export const pullPeople = (pull: Json, team: ReadonlySet<string>): PullPeople => ({ writers: writersOf(pull), opener: String(object(pull.user).login ?? ''), team })

/** The pull request's author by name: its builder label, else its branch's first part (`pip/12`). */
export const authorOf = (pull: Json): string | null => writersOf(pull)[0] ?? null

/** Whether every check on a head passed (none at all passes), is still running, or failed with which names; what made them
 *  (`sources`: each check run's app, each status by its context), which a train's tip must show of its riders' (githubTrain.ts
 *  attend); and what was read, in one line, to tell two looks apart. */
export function checksOf(runs: Json[], status: Json): { state: 'passed' | 'running' | 'failed'; failed: string[]; sources: string[]; summary: string } {
  const failed: string[] = [], seen: string[] = [], sources = new Set<string>()
  let running = false
  // GitHub lists each check's latest run (check-runs' filter=latest): two of one name are two checks, two workflows' jobs, and
  // either failing fails the head (code review of #4060).
  for (const run of runs) {
    seen.push(`${String(run.name ?? '')}:${String(run.status ?? '')}:${String(run.conclusion ?? '')}`)
    sources.add(`${APP}${String(object(run.app).slug ?? '')}`)
    if (run.status !== 'completed') { running = true; continue }
    if (!['success', 'neutral', 'skipped'].includes(String(run.conclusion))) failed.push(String(run.name ?? 'a check'))
  }
  for (const each of Array.isArray(status.statuses) ? status.statuses.map(object) : []) {
    // The train's own mark on the tip it built is no check of it: counted, a train whose CI had not started read as passed.
    if (each.context === TRAIN_MARK) continue
    seen.push(`${String(each.context ?? '')}:${String(each.state ?? '')}`)
    sources.add(`${STATUS}${String(each.context ?? '')}`)
    if (each.state === 'pending') running = true
    else if (each.state !== 'success') failed.push(String(each.context ?? 'a status'))
  }
  // Each named once: a workflow's check run and the status it sets share a name (#4055: "ci/required, process-checks, ci/required").
  return { state: failed.length ? 'failed' : running ? 'running' : 'passed', failed: [...new Set(failed)], sources: [...sources], summary: seen.sort().join('|') }
}

/** [head]'s checks as [reads] has them: its check runs and its combined status (checksOf). */
export async function headChecks(reads: GitHubReads, repo: string, head: string): Promise<ReturnType<typeof checksOf>> {
  const runs = object(await reads.one(repo, `/repos/${repo}/commits/${head}/check-runs?per_page=${PAGE}`)).check_runs
  return checksOf(Array.isArray(runs) ? runs.map(object) : [], await reads.one(repo, `/repos/${repo}/commits/${head}/status`))
}

/** How long a head found failing its checks is taken as failing without reading them again, and the most heads kept so. */
const FAILING_KEPT_MS = 10 * 60_000, FAILING_MAX = 500

/** The heads found failing their checks (headChecks), each taken as failing for [FAILING_KEPT_MS] without reading them again: only
 *  a check run again changes one, and each pass, or each turn's end, would read it again meanwhile. */
export class FailingHeads {
  private readonly at = new Map<string, number>()
  private readonly said = new Set<string>()

  constructor(private readonly reads: GitHubReads, private readonly now: () => number, private readonly log: (line: string) => void) {}

  /** Whether [head]'s checks failed. Checks this login cannot read hold nothing back, as before Harness read them to ask for a read
   *  or type one: the merger reads them again before it merges. A stop for every repository (GitHub limiting this computer, its gh
   *  signed out, GitHub down) stops the pass that asked, as any read's. */
  async failing(repo: string, head: string): Promise<boolean> {
    const key = `${repo}@${head}`, at = this.at.get(key)
    if (at !== undefined && this.now() - at < FAILING_KEPT_MS) return true
    let failed: boolean
    try {
      failed = (await headChecks(this.reads, repo, head)).state === 'failed'
    } catch (error) {
      if (!(error instanceof GitHubStop) || error.everywhere) throw error
      const line = `[super-tab] CHECKS_UNREAD ${repo}: ${error.code}`
      if (!this.said.has(line)) { this.said.add(line); this.log(line) }
      return false
    }
    this.at.delete(key)
    if (failed) this.at.set(key, this.now())
    // The one found longest ago goes first.
    if (this.at.size > FAILING_MAX) this.at.delete(this.at.keys().next().value!)
    return failed
  }
}

export class GitHubMerge {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private readonly reads: GitHubReads
  /** How long each repository is left alone after it failed: one this login cannot read, or one whose pass failed. */
  private readonly waits = new Waits()
  /** The notes said, as `<repo>#<number> <kind> <head>` (NOTES), so each is said once. */
  private readonly told = new Set<string>()
  /** For each pull request off the team at a head, the builder Harness here gave its task and the task, or null: read once. */
  private readonly givenLeft = new Map<string, { name: string; task: number } | null>()
  private me: string | null = null
  /** When each open team pull request's head (`<repo>#<number>@<head>`) was first seen, and its checks as last read: they count as
   *  passed only once they hold still (CHECKS_SETTLE_MS). Kept for the heads open now, so the memory is the open work. */
  private readonly seenAt = new Map<string, number>()
  private readonly looked = new Map<string, string>()
  /** What commits change (sameChange). */
  private readonly patches = new Map<string, unknown>()
  /** The paths each open pull request's head touches (filesOf). */
  private readonly files = new Map<string, ReadonlySet<string>>()
  private projects: { at: number; list: LedProject[] } | null = null
  /** What GitHub names each project's repository now, as its last pass read it: a renamed one's reads are kept under both. */
  private readonly named = new Map<string, string>()
  private offUntil = 0
  private logged = ''
  /** Each repository whose landed changes' costs the server did not give, and when it is asked again: said once. */
  private readonly costless = new Map<string, number>()
  private readonly now: () => number
  private readonly log: (line: string) => void


  constructor(private readonly deps: { projects: () => Promise<LedProject[]>; crew: (project: LedProject) => Promise<Crew>; get: GitHubGet
    send: GitHubSend; now?: () => number; log?: (line: string) => void; intervalMs?: number
    /** Who made each verdict by command (githubVerdict.ts), as the backend recorded it: only such a READ-OK is a read. One for
     *  the merger and the assigner. */
    records: VerdictRecords
    /** What the server keeps of what a project's issues and pull requests [numbers] cost their builders (taskTokens.ts
     *  readTaskTokens), read as the project's PM. */
    costs: (project: LedProject, numbers: number[]) => Promise<ReadRow[]>
    /** The files most landings of [project] touch, as its day's scoreboard named them and its numbers keep them (pmNumbers.ts). */
    hot: (project: LedProject) => readonly string[] }) {
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
    // Whether a repository is being left alone: the pass then says nothing of running again.
    let held = false
    try {
      for (const project of this.projects.list) {
        if (this.waits.held(project.repo, this.now())) { held = true; continue }
        try { await this.mergeReady(project); this.waits.ok(project.repo) } catch (error) {
          this.reads.forget(project.repo)
          // And what the train read under the name GitHub has for it now, for a repository renamed since its project was made.
          const now = this.named.get(project.repo)
          if (now) this.reads.forget(now)
          if (error instanceof GitHubStop && error.everywhere) throw error
          held = true
          // This repository waits, 30 seconds and doubling to 15 minutes (longer if GitHub says so).
          const wait = this.waits.miss(project.repo, this.now(), error instanceof GitHubStop ? error.until - this.now() : 0)
          this.note(error instanceof GitHubStop ? error.code : 'MERGE_FAILED', `${project.repo}: ${error instanceof Error ? error.message : String(error)} (again in ${waitWords(wait)})`)
        }
      }
      this.waits.ran()
      if (!held) this.note('', '')
    } catch (error) {
      if (!(error instanceof GitHubStop)) throw error
      const wait = this.waits.stop(error.until - this.now())
      this.offUntil = this.now() + wait
      this.note(error.code, `${error.message} (again in ${waitWords(wait)})`)
    }
  }

  private async mergeReady(project: LedProject): Promise<void> {
    const { repo } = project
    // GitHub answers a repository renamed since its project was made under its new name: a pull request's own branch is in
    // that one, and compared with the project's name every one read as a fork and no train as one (code review of #4056).
    const about = await this.reads.one(repo, `/repos/${repo}`)
    const base = String(about.default_branch ?? ''), current = String(about.full_name ?? repo).toLowerCase()
    this.named.set(repo, current)
    // Every open pull request, drafts too, for what one may carry of another's or come after (carriedPull, earlierPull); the ones that may merge.
    const listed = await this.reads.current(repo, openPullsPath(repo), PULL_PAGES)
    const pulls = listed.filter(pull => pull.draft !== true && object(pull.base).ref === base)
    // The team, read of the PM's Swarm (a changes read on the backend), only when a pull request could merge.
    if (!pulls.length) { this.forgetHeads(repo, new Set()); return }
    const team = teamOf(await this.deps.crew(project), project.pm)
    const open = new Set<string>()
    const conflicts = (pull: { number: number; head: string; author: string; comments: Json[] }) =>
      this.tellOnce(repo, pull.number, pull.head, pull.author, 'dirty', `${base}: rebase it on ${base} and push.`, pull.comments)
    // What a landed change cost its builder is said on a private repository only, as GitHub's answer above says it: on a public
    // one the builder's model and what the change used of its person's subscription would be public in that person's name (anh
    // Dee's call, 12 November). By its visibility: GitHub calls an internal repository, which its whole enterprise reads,
    // private too (review of #4143). Its rows stay on the server, for the project's members, and are not asked for.
    const cost = about.visibility === 'private' ? (number: number) => this.cost(project, listed, number) : async () => ''
    const train = new GitHubTrain<Ready>({ reads: this.reads, send: this.deps.send, now: this.now, log: this.log }, current, base, listed, {
      checks: (number, head) => this.checks(repo, this.see(open, `${repo}#${number}@${head}`), head),
      login: () => this.login(repo),
      conflicts,
      failedAlone: (pull, carried) => this.tellOnce(repo, pull.number, pull.head, pull.author, 'red',
        `#${carried} carried it alone on ${base}, and its checks failed there. Fix it and push.`, pull.comments),
      unreported: (pull, carried, sources) => this.tellOnce(repo, pull.number, pull.head, pull.author, 'unreported', `${sources.slice(0, 3).join(', ')}, `
        + `which this head has: #${carried} waited 90 min for it. It sits out of trains until it has a new head, or your person lands it.`, pull.comments),
      stamp: () => `${SELF}, ${this.clock()}`,
      cost,
    })
    // What a merged train carried is closed by it and read no more: to GitHub it now conflicts with the base that holds it.
    const landed = await train.landed()
    const hot = this.deps.hot(project)
    const ready: Ready[] = []
    // Read, and not ready only for now: a train that carries one keeps its green run (githubTrain.ts attend).
    const waiting = new Set<string>()
    for (const pull of pulls) {
      const number = Number(pull.number), head = String(object(pull.head).sha ?? '')
      if (!Number.isSafeInteger(number) || !/^[0-9a-f]{40}$/.test(head) || landed.has(number)) continue
      const author = authorOf(pull)
      if (author === null || isHeld(pull)) continue
      // The team's own pull requests only (assign/crew.ts teamOf): a person's merges as that person's repository does it.
      if (!team.has(labelOf(author))) {
        // Nor a task Harness here gave a builder who has left the team since: its PM is told, or it waits for good with nobody
        // told (#3787: swarm-sandbox #15, READ-OK and green for hours after Attach renamed its builder). Only such a task: a shared
        // repository carries dozens of builder: labels from older teams and tools, and none of them is this PM's to hear of.
        const gave = await this.gaveLeft(repo, number, head, pull, author)
        if (gave) {
          await this.tellOnce(repo, number, head, project.pm, 'left', `${gave.name} is not on the team: Harness lands only the team's `
            + `pull requests. Put ${gave.name} back on it, or give #${gave.task} to one of its builders.`, await pullTalk(this.reads, repo, number))
        }
        continue
      }
      // Seen from now, whatever it waits for: a read that comes minutes after a push finds the head long settled.
      const at = this.see(open, `${repo}#${number}@${head}`)
      // Only a READ-OK made by command is a read: while the records cannot be read, nothing merges (said once, VerdictRecords).
      const comments = await this.deps.records.named(project, await pullTalk(this.reads, repo, number))
      if (!comments) continue
      // Another builder's older open changes on files most landings touch which this one touches too: its builder is told of
      // them, once, as it opens, so it reads them before it changes those files again (the allocator's design, package 8).
      if (hot.length) await this.tellNear(repo, number, author, comments, () => this.near(repo, pull, listed, team, base, hot, labelOf(author)))
      const people = pullPeople(pull, team)
      const { readers, twoReads } = verdicts(comments, String(pull.body ?? ''), people)
      const holds = [...readers].filter(([, r]) => r.verdict === 'HOLD')
      if (holds.length) {
        // Only HOLDs of its own side stand (its writers' own, or unsigned ones from the login that opened it): no reader of
        // theirs is asked to lift them, so it is said, once for the head (review of #3708). A reader's HOLD is the reader's to say.
        // "READ-OK made by command on <sha>" reads as no verdict (ownVerdict).
        const own = (reader: string, r: Verdict) => r.ownLogin || isWriter(people.writers, reader)
        const held = holds.every(([reader, r]) => own(reader, r)) ? holds[0]![1] : null
        if (held) {
          await this.tellOnce(repo, number, head, author, 'held', `${held.name} on ${held.sha.slice(0, 7)} is `
            + `${held.ownLogin ? 'unsigned, from the login that opened it' : 'a writer\'s own'}: another agent's READ-OK made by command on ${head.slice(0, 7)} lifts it.`, comments)
        }
        continue
      }
      // A READ-OK on an earlier head whose change is the head's is one on it (sameChange).
      const same = await sameChange(this.reads, this.patches, repo, base, head, [...readers.values()].filter(r => r.verdict === 'READ-OK').map(r => r.sha))
      // Only READ-OKs made by command count, its writers' own never, and a reader who signs two ways is one.
      const onHead = [...readers].filter(([reader, r]) => r.verdict === 'READ-OK' && (head.startsWith(r.sha) || same.has(r.sha)) && !isWriter(people.writers, reader))
      const reads = new Map(onHead.filter(([, r]) => r.recorded))
      if (reads.size < (twoReads ? 2 : 1)) {
        // A typed READ-OK from the login that opened it is no one Harness can ask again (githubAssign.ts asks a named reader
        // again): said on the pull request, once for its head. Not before its record can be there: a verdict made by command a
        // moment ago reads as typed until it is (review of #3906).
        const typed = onHead.find(([, r]) => r.ownLogin && !r.byCommand)?.[1]
        if (typed && this.now() - Date.parse(typed.at) >= RECORD_SETTLE_MS) {
          await this.tellOnce(repo, number, head, author, 'unsigned', `${typed.name} is typed, and only a READ-OK made by command counts: `
            + `its reader runs \`harness super-tab read ok ${repo}#${number} ${head.slice(0, 7)}\`.`, comments)
        }
        continue
      }
      const checks = await this.checks(repo, at, head)
      if (checks.state === 'running') { waiting.add(`${number}@${head}`); continue }
      if (checks.state === 'failed') { await this.tellOnce(repo, number, head, author, 'checks', `${checks.failed.slice(0, 3).join(', ')}. Fix them and push.`, comments); continue }
      const detail = await this.reads.one(repo, `/repos/${repo}/pulls/${number}`)
      const state = String(detail.mergeable_state ?? 'unknown')
      if (state === 'behind') { await this.tellOnce(repo, number, head, author, 'behind', `${base}: update the branch and push.`, comments); continue }
      if (state === 'dirty') { await conflicts({ number, head, author, comments }); continue }
      if (state === 'blocked') { await this.tellOnce(repo, number, head, author, 'blocked', `${base} block the merge. Ask your person.`, comments); continue }
      if (!['clean', 'has_hooks', 'unstable'].includes(state)) { waiting.add(`${number}@${head}`); continue }
      // The note says what it waits for, and no more. Until 2026-11-12 it ended "then update it from main", and for one stack of
      // three in the scratch repository a builder did, three times: three pushes and runs of the checks, a note more and a read
      // again, where a pull request built on another that nobody touched landed by itself. It promises nothing either: where
      // the base requires branches up to date, or the other lands squashed after a fix, its builder is told of that when it is so.
      const carried = await this.carriedPull(repo, number, head, listed)
      if (carried) {
        await this.tellOnce(repo, number, head, author, 'stacked', `#${carried.number}, whose commits it carries (its head ${carried.head.slice(0, 7)}).`, comments)
        continue
      }
      // Nor while a pull request of the team's is open for a task its own task comes after, whichever of its commits it holds.
      // One note for both: told for this head that it lands after another, it is not told again when the reason becomes the other.
      const earlier = await this.earlierPull(repo, number, pull, listed, team)
      if (earlier) {
        await this.tellOnce(repo, number, head, author, 'stacked', `#${earlier.pull}, which is open for #${earlier.after}: its own task #${earlier.task} comes after that one.`, comments)
        continue
      }
      // A train carried it alone at this head and failed, or waited out its time for what this head has and no train gets: it sits
      // out until its head changes. Its note says so for good, where GitHub lists a train only among the hundred pull requests
      // closed last (githubTrain.ts landed and attend).
      if (this.said(comments, head, 'red') || this.said(comments, head, 'unreported')) continue
      ready.push({ number, head, title: String(pull.title ?? ''), body: String(pull.body ?? ''), readers: [...reads.values()].map(r => r.name),
        fork: String(object(object(pull.head).repo).full_name ?? '').toLowerCase() !== current, sources: checks.sources, author, comments })
    }
    for (const pull of await train.carry(ready, waiting)) {
      // A fork GitHub took neither into a train nor on its own: tried again with the merger's waits, not every pass (each
      // try makes and deletes a branch).
      if (!await this.mergeAlone(repo, pull, cost) && pull.fork) {
        throw new GitHubStop('FORK_REFUSED', `GitHub takes #${pull.number} neither into a train nor on its own.`, false, this.now())
      }
    }
    this.forgetHeads(repo, open)
  }

  /**
   * The builder Harness on this computer gave [pull]'s task, when that builder is [author], with the task: its last word "for
   * **Name**" on one of the pull request's tasks, posted with this computer's login (the PM's person's, as Harness posts). Read
   * once for each head, and at most [TASKS_READ_MAX] tasks.
   */
  private async gaveLeft(repo: string, number: number, head: string, pull: Json, author: string): Promise<{ name: string; task: number } | null> {
    const key = `${repo}#${number}@${head}`
    if (this.givenLeft.has(key)) return this.givenLeft.get(key)!
    const tasks = tasksOf(pull).slice(0, TASKS_READ_MAX)
    const me = tasks.length ? (await this.login(repo)).toLowerCase() : ''
    let found: { name: string; task: number } | null = null
    for (const task of tasks) {
      // A number the pull request names that is no issue's has no words: never a repository this login cannot read (#4233).
      const words = (await this.reads.currentIfThere(repo, `/repos/${repo}/issues/${task}/comments?per_page=${PAGE}`, 3))
        .filter(c => TEAM.has(c.author_association) && String(object(c.user).login ?? '').toLowerCase() === me)
        .map(c => GAVE.exec(String(c.body ?? '').slice(0, 500))?.[1]).filter((name): name is string => !!name)
      const last = words.at(-1)
      if (last && labelOf(last) === labelOf(author)) { found = { name: last, task }; break }
    }
    this.givenLeft.set(key, found)
    if (this.givenLeft.size > TOLD_MAX) this.givenLeft.delete(this.givenLeft.keys().next().value!)
    return found
  }

  /** Merges one pull request on its own, squashed at its head, as every ready one was before the train. */
  private async mergeAlone(repo: string, pull: Ready, cost: (number: number) => Promise<string>): Promise<boolean> {
    const merged = await this.deps.send('PUT', `/repos/${repo}/pulls/${pull.number}/merge`, { merge_method: 'squash', sha: pull.head })
    // Merged, its head moved (409) or refused by GitHub (405): the repository is read again next pass, by either name.
    this.reads.forget(repo)
    const now = this.named.get(repo)
    if (now && now !== repo) this.reads.forget(now)
    if (merged.status !== 200) { this.note('MERGE_REFUSED', `${repo}#${pull.number}: GitHub answered ${merged.status}`); return false }
    const by = pull.readers.join(' and ')
    await this.comment(repo, pull.number, `${SELF}, ${this.clock()}: merged. READ-OK on ${pull.head.slice(0, 7)} by ${by}, checks green.${await cost(pull.number)}`)
    this.log(`[super-tab] merged ${repo}#${pull.number} on ${pull.head.slice(0, 7)} (READ-OK by ${by})`)
    return true
  }

  /**
   * What pull request [number] cost its builder, as the sentence the comment that says it landed gains (taskTokens.ts costLine):
   * from the server's rows for it and the tasks it closes, written by its builder's own daemon. Empty when that daemon wrote
   * none (an older one, or a pull request that is no agent's), and when the server gives none within COST_WAIT_MS: a landing
   * never waits on its cost or fails for it. That is said once for a repository, and once more when it is read again; for
   * COST_AGAIN_MS it is not asked again, so a train of twenty waits on a server that is down once, not twenty times.
   */
  private async cost(project: LedProject, listed: Json[], number: number): Promise<string> {
    const pull = listed.find(one => Number(one.number) === number), author = pull ? authorOf(pull) : null
    const againAt = this.costless.get(project.repo)
    if (!pull || !author || (againAt !== undefined && this.now() < againAt)) return ''
    // Its branch may name its own number (`pip/4` for #4): each number is asked once. A number no issue can have ("Closes #0")
    // would have the server refuse the whole read, and the repository's comments go without the sentence for COST_AGAIN_MS.
    const numbers = [...new Set([number, ...tasksOf(pull)])].filter(task => task >= 1 && task <= TASK_NUMBER_MAX).slice(0, COST_NUMBERS)
    const rows = await within(this.deps.costs(project, numbers), COST_WAIT_MS)
    if (!rows) {
      if (againAt === undefined) this.log(`[super-tab] a landed change's cost could not be read: it is not said · COST_UNREAD ${project.repo}`)
      this.costless.set(project.repo, this.now() + COST_AGAIN_MS)
      return ''
    }
    if (this.costless.delete(project.repo)) this.log(`[super-tab] landed changes' costs are read again · ${project.repo}`)
    return costLine(rows, author, this.now())
  }

  /** This computer's GitHub login, asked once: the train takes only the pull requests it opened for its own (githubTrain.ts). */
  private async login(repo: string): Promise<string> {
    if (!this.me) {
      const login = (await this.reads.one(repo, '/user')).login
      if (typeof login !== 'string' || !login) throw new GitHubStop('LOGIN_UNREAD', 'GitHub did not say this computer\'s login.', false, this.now())
      this.me = login
    }
    return this.me
  }

  /** Notes that head [at] (`<repo>#<number>@<head>`) is open now, and first seen now if never before. Returns [at]. */
  private see(open: Set<string>, at: string): string {
    open.add(at)
    if (!this.seenAt.has(at)) this.seenAt.set(at, this.now())
    return at
  }

  /** The checks of [head], seen as [at] (checksOf): passed only once they hold still (CHECKS_SETTLE_MS), and running until then.
   *  A pull request's and a train's alike. */
  private async checks(repo: string, at: string, head: string): Promise<ReturnType<typeof checksOf>> {
    const checks = await headChecks(this.reads, repo, head)
    if (checks.state !== 'passed') return checks
    // Passed, or none yet.
    const before = this.looked.get(at)
    this.looked.set(at, checks.summary)
    return this.now() - this.seenAt.get(at)! < CHECKS_SETTLE_MS || before !== checks.summary ? { ...checks, state: 'running' } : checks
  }

  /** Another open pull request (a draft too) whose head is among [number]'s commits, or null: merging [number] would merge that one's
   *  commits with it, unread or held. lampOS's train bot leaves such a pull request out until the one under it is merged
   *  (train-bot.sh unstacked: #3014 and #3391 carried #3064's commit under their own). Read only when it could merge now. */
  private async carriedPull(repo: string, number: number, head: string, open: Json[]): Promise<{ number: number; head: string } | null> {
    const others = new Map(open.filter(pull => Number(pull.number) !== number).map(pull => [String(object(pull.head).sha ?? ''), Number(pull.number)]))
    // Its own head is no other's: two pull requests of one head are the same commits, not one carried by the other.
    others.delete('')
    others.delete(head)
    if (!others.size) return null
    for (const commit of await this.reads.current(repo, `/repos/${repo}/pulls/${number}/commits?per_page=${PAGE}`, 3)) {
      const under = others.get(String(commit.sha ?? ''))
      if (under !== undefined) return { number: under, head: String(commit.sha) }
    }
    return null
  }

  /**
   * Another open pull request of the [team]'s (a draft too) that is for a task one of [pull]'s own tasks says it comes after
   * ("after #12" in the task's text: assign/crew.ts tasksOf, dependsOn), with the two tasks; or null. `carriedPull` holds a pull
   * request only while it holds the other's head as it is now. Built on #A at one head, then #A held by a reader and fixed with
   * a push, #B held #A's earlier commits alone: nothing was found, and the held code landed through #B before its fix. The
   * assigner gives such a task to be built on that branch (the allocator's design, package 3), so the order is the tasks' own,
   * whatever the commits.
   *
   * Only a pull request of the team's is waited for, known as the one that may land is (authorOf, teamOf) and, as no landing
   * asks, by GitHub's word that its author is a member of the repository (author_association): on a public
   * repository anyone opens a pull request that says it closes a task, and that is data, never a word on what lands.
   *
   * Read only when [pull] could merge now: one read for each task it names, [TASKS_READ_MAX] at most, a 304 while the task is
   * unchanged. A number that is no issue's (a branch named `pip/2026`), or a pull request's, is no task: nothing says what it
   * comes after, as when the task's text is gone. A read GitHub refuses or fails stops the pass, as every read of it. A task
   * that names itself comes after nothing: two pull requests for it would each wait for the other. Two tasks that name each
   * other hold both: no order lands both, each is told which it waits for, and the lines are their PM's to change.
   */
  private async earlierPull(repo: string, number: number, pull: Json, open: Json[], team: ReadonlySet<string>): Promise<{ pull: number; task: number; after: number } | null> {
    // The task each other open pull request of the team's is for (ofTeam), made only once a task says it comes after another.
    let others: Map<number, number> | null = null
    for (const task of tasksOf(pull).slice(0, TASKS_READ_MAX)) {
      const issue = await this.reads.ifThere(repo, `/repos/${repo}/issues/${task}`)
      if (!issue || issue.pull_request) continue
      for (const after of dependsOn(issue.body)) {
        if (after === task) continue
        others ??= new Map(open.filter(other => Number(other.number) !== number && ofTeam(other, team))
          .flatMap(other => tasksOf(other).map(theirs => [theirs, Number(other.number)] as const)))
        const under = others.get(after)
        if (under !== undefined) return { pull: under, task, after }
      }
    }
    return null
  }

  /**
   * The older open pull requests of other builders of the team's (ofTeam, not [mine]) into [base] that are on their way to land
   * (no draft, not on hold) and touch a file most landings touch ([hot]) which [pull] touches too, each with the first such file.
   * Not its own builder's, which it knows, nor one for a task [pull] is for: two pull requests for one task are one taken over or
   * begun again. A file is matched by its path as GitHub gives it. Each head's files are read once (filesOf), [pull]'s only
   * while such an older one is open, and theirs only once [pull] touches such a file. Asked of each pull request each pass until
   * it is told, so the first such one found is enough to read [pull]'s files: at 200 open, a pass took 46 ms more for it where
   * none shared a file.
   */
  private async near(repo: string, pull: Json, open: Json[], team: ReadonlySet<string>, base: string, hot: readonly string[], mine: string): Promise<Near[]> {
    const number = Number(pull.number), own = new Set(tasksOf(pull))
    const onItsWay = (other: Json) => Number.isSafeInteger(other.number) && Number(other.number) < number && object(other.base).ref === base
      && other.draft !== true && /^[0-9a-f]{40}$/.test(String(object(other.head).sha ?? '')) && !isHeld(other) && ofTeam(other, team)
      && labelOf(authorOf(other)!) !== mine && !tasksOf(other).some(task => own.has(task))
    if (!open.some(onItsWay)) return []
    const touched = await this.filesOf(repo, number, String(object(pull.head).sha))
    const shared = hot.filter(path => touched.has(path))
    if (!shared.length) return []
    const near: Near[] = []
    for (const other of open.filter(onItsWay)) {
      const theirs = await this.filesOf(repo, Number(other.number), String(object(other.head).sha))
      const file = shared.find(path => theirs.has(path))
      if (file) near.push({ number: Number(other.number), file })
    }
    return near
  }

  /** The paths [number]'s [head] touches (its first hundred files, one renamed by both its names), read once for each head: a
   *  head's files do not change, and a push is a new head. Asked outright (freshPages): a hundred files with their patches are
   *  hundreds of kilobytes, which kept under their ETag would push out the reads each pass makes. One GitHub does not give (an
   *  answer cut off on its way, a 500, a timeout) is taken as none for that head, and said: a note is no reason to stop landing,
   *  and held for it, every landing of the repository waited while that head stood (review of #4177). GitHub's word to stop
   *  asking stops the pass, as at every read. */
  private async filesOf(repo: string, number: number, head: string): Promise<ReadonlySet<string>> {
    const key = `${repo}#${number}@${head}`
    const known = this.files.get(key)
    if (known) return known
    let files: ReadonlySet<string>
    try {
      files = new Set((await this.reads.freshPages(repo, `/repos/${repo}/pulls/${number}/files?per_page=${PAGE}`, 1))
        .flatMap(file => [String(file.filename ?? ''), String(file.previous_filename ?? '')]).filter(Boolean))
    } catch (error) {
      if (!(error instanceof GitHubStop) || STOP_ASKING.has(error.code)) throw error
      this.log(`[super-tab] FILES_UNREAD ${repo}#${number}: ${error.message}`)
      files = new Set()
    }
    this.files.set(key, files)
    if (this.files.size > FILES_KEPT) this.files.delete(this.files.keys().next().value!)
    return files
  }

  /** Tells [number]'s author once, the first time it touches a file most landings touch that older ones of other builders touch
   *  too ([near], asked only until it is said), which they are: the oldest [NEAR_NAMED], each with the file, and how many more, so
   *  its builder reads them before it changes those files again. It promises no order: the train lands changes that do not
   *  conflict together, and tells a real conflict to its author. Once for the pull request, as a note that named every one could
   *  not be read back whole: one said before is found among its [comments] after a restart. */
  private async tellNear(repo: string, number: number, author: string, comments: Json[], near: () => Promise<Near[]>): Promise<void> {
    if (this.told.has(`${repo}#${number} near`) || nearSaid(comments)) return
    const oldest = (await near()).sort((a, b) => a.number - b.number)
    if (!oldest.length) return
    const named = oldest.slice(0, NEAR_NAMED), more = oldest.length - named.length
    const each = named.map((other, at) => `#${other.number}${at ? '' : ' already touches'} \`${plainPath(other.file)}\``)
    await this.comment(repo, number, `${SELF}, ${this.clock()}, to **${author}**: ${each.length === 1 ? each[0] : `${each.slice(0, -1).join(', ')} and ${each.at(-1)}`}`
      + `, which most changes touch${more ? `, and ${more} more do too` : ''}: read ${oldest.length === 1 ? 'it before you change that file' : 'them before you change those files'} again.`)
    this.told.add(`${repo}#${number} near`)
    while (this.told.size > TOLD_MAX) this.told.delete(this.told.values().next().value!)
  }

  /** Lets go of [repo]'s heads no longer open, as `<repo>#<number>@<head>`. */
  private forgetHeads(repo: string, open: ReadonlySet<string>): void {
    for (const key of [...this.seenAt.keys()]) if (key.startsWith(`${repo}#`) && !open.has(key)) { this.seenAt.delete(key); this.looked.delete(key) }
  }

  /** Says once for a pull request, [kind] and head why it is not merged (NOTES). It names the head, and a restart finds it among
   *  the pull request's comments by its first words: remembered only in memory, every release (each restarts the PM's daemon,
   *  seven on 2026-11-10) said it again. */
  private async tellOnce(repo: string, number: number, head: string, author: string | null, kind: NoteKind, rest: string, comments: Json[]): Promise<void> {
    const key = `${repo}#${number} ${kind} ${head}`
    if (this.told.has(key)) return
    if (!this.said(comments, head, kind)) {
      const taken = await this.comment(repo, number, `${SELF}, ${this.clock()}${author ? `, to **${author}**` : ''}: ${noteStart(head, NOTES[kind])}${rest}`)
      // The note that sits a pull request out of trains is all that keeps it out (mergeReady): one GitHub did not take is not taken
      // as said, and is said again when a train next waits out its time on that pull request, every 90 minutes at most (review 2
      // of #4139). Any other note is said each pass it applies, so a refused one is not tried again.
      if (!taken && kind === 'unreported') return
    }
    // Once GitHub has answered: a comment that never reached it (the pass failed, and is tried again) is not told.
    this.told.add(key)
    if (this.told.size > TOLD_MAX) this.told.delete(this.told.values().next().value!)
  }

  /** Whether one of the team's [comments] is the note of [kind] on [head], in any words it has begun with (startsOf). */
  private said(comments: Json[], head: string, kind: NoteKind): boolean {
    const starts = startsOf(kind).map(words => noteStart(head, words))
    return comments.some(c => TEAM.has(c.author_association) && starts.some(start => String(c.body ?? '').slice(0, 500).includes(start)))
  }

  /** Posts [body] on [number]; whether GitHub took it. */
  private async comment(repo: string, number: number, body: string): Promise<boolean> {
    const reply = await this.deps.send('POST', `/repos/${repo}/issues/${number}/comments`, { body })
    if (reply.status !== 201) this.note('COMMENT_FAILED', `${repo}#${number}: GitHub answered ${reply.status}`)
    return reply.status === 201
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
