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
 * - and GitHub says it can merge.
 * One that cannot, being behind or in conflict, or whose checks failed, is told so on itself, to its author by name, once for
 * each head, so the GitHub news brings it to its author (githubMentions.ts).
 *
 * The ready ones land on a train (githubTrain.ts): one branch, one run of the checks on the combined change. Only one that is
 * alone and holds the base's tip, or a fork's whose head GitHub does not take into a train, is merged on its own, squashed, as
 * every one was until 2026-11-10.
 */
import { createHash } from 'node:crypto'
import { labelOf, readerKey, sameKey, teamOf, type Crew } from './assign/crew.js'
import type { GitHubGet, GitHubSend } from './githubRest.js'
import { GitHubReads, GitHubStop, PAGE, retryIn, Waits, waitWords } from './githubRest.js'
import { repositorySlug, TEAM } from './githubMentions.js'
import { GitHubTrain, type TrainPull } from './githubTrain.js'
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
  blocked: 'GitHub\'s rules for ', stacked: 'it carries open ', red: 'its train failed: ' } as const
type NoteKind = keyof typeof NOTES
const noteStart = (head: string, kind: NoteKind): string => `not merged yet at ${head.slice(0, 7)}: ${NOTES[kind]}`
/** How long after a head is first seen its checks may count as passed, and then only when two looks in a row read them the same:
 *  lampOS's merge-when-green.sh waits for "the same in two looks 30 s apart, from 3 min on". A head just pushed has no checks
 *  yet, which read as all passed, and a job that needs another gets its check only when that one ends. */
const CHECKS_SETTLE_MS = 3 * 60_000
/** How many notes are remembered, as the train bot keeps the last 5,000 lines of its told list. */
const TOLD_MAX = 5_000
/** Records asked for in one request (the backend takes at most 100 ids), how many are remembered, and how long after a comment
 *  was written one with no record is taken as typed by hand: the command records it within seconds of posting it. */
const AUTHORS_PAGE = 100, RECORDED_MAX = 5_000, RECORD_SETTLE_MS = 2 * 60_000
/** How long an answer about a comment is kept before it is asked about again: a record made late (the command run again after
 *  the server refused it) and an agent's new name are read within it, with no restart. */
const RECORD_AGAIN_MS = 10 * 60_000

/** A ready pull request, with what a note to its author takes (tellOnce). */
interface Ready extends TrainPull { author: string; comments: Json[] }
/** The label a person puts on a pull request to keep Harness from landing it (AGENTS.md). */
const HOLD_LABEL = 'hold'

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
  { readers: Map<string, { verdict: 'READ-OK' | 'HOLD'; sha: string; name: string; ownLogin: boolean; at: string }>; twoReads: boolean } {
  const readers = new Map<string, { verdict: 'READ-OK' | 'HOLD'; sha: string; name: string; ownLogin: boolean; kind: 'recorded' | 'signed' | 'login'; at: string }>()
  let twoReads = /\bTWO READS\b/.test(body)
  // The team's names as sameKey reads them, from its builder labels: a team agent is known however it signs.
  const team = new Set([...people.team].map(label => sameKey(label.replace(/^builder:/i, ''))))
  for (const comment of comments) {
    if (!TEAM.has(comment.author_association)) continue
    const first = String(comment.body ?? '').split('\n').find(line => line.trim()) ?? ''
    if (/\bTWO READS\b/.test(first)) twoReads = true
    const found = ownVerdict(first)
    if (!found) continue
    const login = String(object(comment.user).login ?? '')
    const fromOpener = people.opener !== '' && login.toLowerCase() === people.opener.toLowerCase()
    const pattern = SIGNATURE.exec(first)?.[1]
    // The agent the backend recorded as this comment's writer (GitHubMerge recordedNames) is its reader, whatever the comment
    // opens with: the command that made it knew the agent from its session, and a name can be typed by anyone.
    // From the login that opened the pull request it is one of the team's, as a typed signature must be: any other agent of
    // that person (review of #3906: its Buddy's record merged what its typed name did not) reads as that login.
    const named = typeof comment.recorded === 'string' && comment.recorded.trim() ? comment.recorded.trim() : undefined
    const recorded = named && (!fromOpener || team.has(sameKey(named))) ? named : undefined
    const signature = recorded ?? people.writers.find(writer => signedAs(first, writer))
      ?? (pattern && !VERDICT_FIRST.test(pattern) && (!fromOpener || team.has(sameKey(pattern))) ? pattern : undefined)
    const reader = signature ?? login
    if (!reader || reader === SELF) continue
    const at = String(comment.created_at ?? '')
    // One reader however it writes its name (a HOLD as "Kai Lee" is lifted by its READ-OK as "kai-lee"); a name of no letters
    // or digits, as written.
    const key = readerKey(reader)
    const last = readers.get(key)
    // A HOLD is lifted only by its own kind: a signature's by a signature, a login's (unsigned) by that login. A person whose
    // login reads as an agent's name is not that agent. A HOLD made by command (recorded) is lifted only by a READ-OK made
    // by command: anyone can type its reader's name (review of #3906). A typed HOLD is lifted by its reader's command too.
    const kind = recorded ? 'recorded' : signature ? 'signed' : 'login'
    if (last?.verdict === 'HOLD' && found.verdict === 'READ-OK' && last.kind !== kind && !(last.kind === 'signed' && kind === 'recorded')) continue
    if (!last || at >= last.at) readers.set(key, { verdict: found.verdict, sha: found.sha, name: reader, ownLogin: !signature && fromOpener, kind, at })
  }
  return { readers: new Map([...readers].map(([k, v]) => [k, { verdict: v.verdict, sha: v.sha, name: v.name, ownLogin: v.ownLogin, at: v.at }])), twoReads }
}


/** The most files GitHub lists in one compare: a change of that many or more cannot be read whole. */
const COMPARE_FILES_MAX = 300
/** Changes kept by each merger and assigner: what a commit changes since its merge base does not change. */
const PATCHES_MAX = 1_000

/** A compare's files as one change: each file's status and names and its added and removed lines, without context or line numbers;
 *  null when one file has no patch (binary, or too large for GitHub to give) or the list may be cut short. */
function changeOf(files: Json[]): string | null {
  if (files.length >= COMPARE_FILES_MAX) return null
  const parts: string[] = []
  for (const file of [...files].sort((a, b) => String(a.filename ?? '').localeCompare(String(b.filename ?? '')))) {
    if (typeof file.patch !== 'string' && Number(file.changes ?? 0) > 0) return null
    const lines = String(file.patch ?? '').split('\n').filter(line => line.startsWith('+') || line.startsWith('-'))
    parts.push(JSON.stringify([String(file.status ?? ''), String(file.previous_filename ?? ''), String(file.filename ?? ''), lines]))
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

/**
 * What [sha] changes since its merge base with [base], as lampOS's lib.sh patch_of reads it (`git diff -U0 <merge base> <sha> |
 * git patch-id`), from GitHub's compare, kept in [kept]. Null when GitHub cannot give it whole, or does not know the commit: no
 * failure of the repository, and a verdict on it then counts only on its own head. Whitespace counts here, where patch-id drops
 * it: a change of spaces alone is read again.
 */
async function patchOf(reads: GitHubReads, kept: Map<string, string | null>, repo: string, base: string, sha: string): Promise<string | null> {
  const key = `${repo}\n${base}\n${sha}`
  if (kept.has(key)) return kept.get(key)!
  let change: string | null
  try {
    const files = (await reads.one(repo, `/repos/${repo}/compare/${base}...${sha}`)).files
    change = Array.isArray(files) ? changeOf(files.map(object)) : null
  } catch (error) {
    if (!(error instanceof GitHubStop) || error.everywhere) throw error
    change = null
  }
  kept.set(key, change)
  if (kept.size > PATCHES_MAX) kept.delete(kept.keys().next().value!)
  return change
}

/** Which of the verdicts' commits [shas] change what [head] changes (patchOf): lampOS counts a READ-OK for the head "or a head whose
 *  diff from its merge base is the same patch, i.e. a plain rebase" (train-bot.sh). Updated from main with nothing of its own
 *  changed, a pull request waited on a reader who had read it all. Read only when a verdict is on an earlier head. */
export async function sameChange(reads: GitHubReads, kept: Map<string, string | null>, repo: string, base: string, head: string,
  shas: Iterable<string>): Promise<Set<string>> {
  const same = new Set<string>()
  const earlier = [...new Set(shas)].filter(sha => !head.startsWith(sha))
  if (!earlier.length) return same
  const now = await patchOf(reads, kept, repo, base, head)
  if (now === null) return same
  for (const sha of earlier) if (await patchOf(reads, kept, repo, base, sha) === now) same.add(sha)
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

/** Whether every check on a head passed (none at all passes), is still running, or failed with which names, and what was read,
 *  in one line, to tell two looks apart. */
export function checksOf(runs: Json[], status: Json): { state: 'passed' | 'running' | 'failed'; failed: string[]; summary: string } {
  const failed: string[] = [], seen: string[] = []
  let running = false
  for (const run of runs) {
    seen.push(`${String(run.name ?? '')}:${String(run.status ?? '')}:${String(run.conclusion ?? '')}`)
    if (run.status !== 'completed') { running = true; continue }
    if (!['success', 'neutral', 'skipped'].includes(String(run.conclusion))) failed.push(String(run.name ?? 'a check'))
  }
  for (const each of Array.isArray(status.statuses) ? status.statuses.map(object) : []) {
    seen.push(`${String(each.context ?? '')}:${String(each.state ?? '')}`)
    if (each.state === 'pending') running = true
    else if (each.state !== 'success') failed.push(String(each.context ?? 'a status'))
  }
  return { state: failed.length ? 'failed' : running ? 'running' : 'passed', failed, summary: seen.sort().join('|') }
}

export class GitHubMerge {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private readonly reads: GitHubReads
  /** How long each repository is left alone after it failed: one this login cannot read, or one whose pass failed. */
  private readonly waits = new Waits()
  /** The notes said, as `<repo>#<number> <kind> <head>` (NOTES), so each is said once. */
  private readonly told = new Set<string>()
  private me: string | null = null
  /** When each open team pull request's head (`<repo>#<number>@<head>`) was first seen, and its checks as last read: they count as
   *  passed only once they hold still (CHECKS_SETTLE_MS). Kept for the heads open now, so the memory is the open work. */
  private readonly seenAt = new Map<string, number>()
  private readonly looked = new Map<string, string>()
  /** What commits change (sameChange). */
  private readonly patches = new Map<string, string | null>()
  private projects: { at: number; list: LedProject[] } | null = null
  private offUntil = 0
  private logged = ''
  private readonly now: () => number
  private readonly log: (line: string) => void

  /** Who the backend recorded as the writer of a verdict's comment, by `<repo>#<comment id>`; null for one it has no record of
   *  (typed by hand). A record never changes, so each comment is asked about once. */
  private readonly recorded = new Map<string, { name: string | null; at: number }>()
  /** While the backend does not answer for records it is left alone, longer each time (retryIn), and said once. */
  private authorsDown = 0
  private authorsAgainAt = 0

  constructor(private readonly deps: { projects: () => Promise<LedProject[]>; crew: (project: LedProject) => Promise<Crew>; get: GitHubGet
    send: GitHubSend; now?: () => number; log?: (line: string) => void; intervalMs?: number
    /** The agents the backend recorded as the writers of a project's GitHub comments, by `issue:<id>` (backend
     *  superTabs/githubComments.ts): a verdict made by command (githubVerdict.ts) is its agent's. */
    authors?: (project: LedProject, ids: string[]) => Promise<Record<string, { name: string }>> }) {
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
    const base = String((await this.reads.one(repo, `/repos/${repo}`)).default_branch ?? '')
    // Every open pull request, drafts too, for what one may carry of another's (carriedPull); the ones that may merge.
    const listed = await this.reads.current(repo, openPullsPath(repo), PULL_PAGES)
    const pulls = listed.filter(pull => pull.draft !== true && object(pull.base).ref === base)
    // The team, read of the PM's Swarm (a changes read on the backend), only when a pull request could merge.
    if (!pulls.length) { this.forgetHeads(repo, new Set()); return }
    const team = teamOf(await this.deps.crew(project), project.pm)
    const open = new Set<string>()
    const conflicts = (pull: { number: number; head: string; author: string; comments: Json[] }) =>
      this.tellOnce(repo, pull.number, pull.head, pull.author, 'dirty', `${base}: rebase it on ${base} and push.`, pull.comments)
    const train = new GitHubTrain<Ready>({ reads: this.reads, send: this.deps.send, now: this.now, log: this.log }, repo, base, listed, {
      checks: (number, head) => this.checks(repo, this.see(open, `${repo}#${number}@${head}`), head),
      login: () => this.login(repo),
      conflicts,
      failedAlone: (pull, carried) => this.tellOnce(repo, pull.number, pull.head, pull.author, 'red',
        `#${carried} carried it alone on ${base}, and its checks failed there. Fix it and push.`, pull.comments),
      stamp: () => `${SELF}, ${this.clock()}`,
    })
    // What a merged train carried is closed by it and read no more: to GitHub it now conflicts with the base that holds it.
    const landed = await train.landed()
    const ready: Ready[] = []
    // Read, and not ready only for now: a train that carries one keeps its green run (githubTrain.ts attend).
    const waiting = new Set<string>()
    for (const pull of pulls) {
      const number = Number(pull.number), head = String(object(pull.head).sha ?? '')
      if (!Number.isSafeInteger(number) || !/^[0-9a-f]{40}$/.test(head) || landed.has(number)) continue
      const author = authorOf(pull)
      // The team's own pull requests only (assign/crew.ts teamOf): a person's merges as that person's repository does it.
      if (author === null || !team.has(labelOf(author))) continue
      if ((Array.isArray(pull.labels) ? pull.labels : []).some(label => object(label).name === HOLD_LABEL)) continue
      // Seen from now, whatever it waits for: a read that comes minutes after a push finds the head long settled.
      const at = this.see(open, `${repo}#${number}@${head}`)
      const comments = await this.recordedNames(project, await pullTalk(this.reads, repo, number))
      const people = pullPeople(pull, team)
      const { readers, twoReads } = verdicts(comments, String(pull.body ?? ''), people)
      const holds = [...readers].filter(([, r]) => r.verdict === 'HOLD')
      if (holds.length) {
        // Only its writers' own HOLDs stand: no reader is asked to lift them (githubAssign.ts askReaders), so it is said, once for
        // the head (review of #3708). A reader's HOLD is the reader's to say. "READ-OK on <sha>" reads as no verdict (ownVerdict).
        const writers = holds.map(([reader, r]) => isWriter(people.writers, reader) ? r : null)
        const held = writers.every(r => r !== null) ? writers[0] : null
        if (held) {
          await this.tellOnce(repo, number, head, author, 'held', `${held.name} on ${held.sha.slice(0, 7)} is a writer's own: `
            + `${held.name} lifts it with a READ-OK on ${head.slice(0, 7)}.`, comments)
        }
        continue
      }
      // A READ-OK on an earlier head whose change is the head's is one on it (sameChange).
      const same = await sameChange(this.reads, this.patches, repo, base, head, [...readers.values()].filter(r => r.verdict === 'READ-OK').map(r => r.sha))
      // Its writers' own READ-OKs and its login's unsigned ones count for nothing, and a reader who signs two ways is one.
      const onHead = [...readers].filter(([reader, r]) => r.verdict === 'READ-OK' && (head.startsWith(r.sha) || same.has(r.sha)) && !isWriter(people.writers, reader))
      const reads = new Map(onHead.filter(([, r]) => !r.ownLogin))
      if (reads.size < (twoReads ? 2 : 1)) {
        // Said on the pull request, once for its head, so the reader signs it: the readers' count asks another meanwhile.
        const unsigned = onHead.find(([, r]) => r.ownLogin)?.[1]
        // Not before its record can be there, nor while records cannot be read: a verdict made by command a moment ago
        // read as unsigned, and its reader was told to sign what the command had just signed (review of #3906).
        const settled = !this.deps.authors || (!this.authorsDown && this.now() - Date.parse(unsigned?.at ?? '') >= RECORD_SETTLE_MS)
        if (unsigned && settled) await this.tellOnce(repo, number, head, author, 'unsigned', `${unsigned.name} is unsigned, and every agent of its person posts as that `
          + `login: its reader signs it, as in "<name>, HH:MM: READ-OK ${head.slice(0, 7)}".`, comments)
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
      const carried = await this.carriedPull(repo, number, head, listed)
      if (carried) {
        await this.tellOnce(repo, number, head, author, 'stacked', `#${carried.number}'s commits (its head ${carried.head.slice(0, 7)}), so merging it would `
          + `merge them too. It waits until #${carried.number} merges; then update it from ${base}.`, comments)
        continue
      }
      // A train carried it alone at this head and failed: it sits out until its head changes. Its note says so for good, where
      // GitHub lists a red train only among the hundred pull requests closed last (githubTrain.ts landed).
      if (this.said(comments, head, 'red')) continue
      ready.push({ number, head, title: String(pull.title ?? ''), body: String(pull.body ?? ''), readers: [...reads.values()].map(r => r.name),
        fork: String(object(object(pull.head).repo).full_name ?? '').toLowerCase() !== repo.toLowerCase(), checked: !checks.none, author, comments })
    }
    for (const pull of await train.carry(ready, waiting)) {
      // A fork GitHub took neither into a train nor on its own: tried again with the merger's waits, not every pass (each
      // try makes and deletes a branch).
      if (!await this.mergeAlone(repo, pull) && pull.fork) {
        throw new GitHubStop('FORK_REFUSED', `GitHub takes #${pull.number} neither into a train nor on its own.`, false, this.now())
      }
    }
    this.forgetHeads(repo, open)
  }

  /** Merges one pull request on its own, squashed at its head, as every ready one was before the train. */
  private async mergeAlone(repo: string, pull: Ready): Promise<boolean> {
    const merged = await this.deps.send('PUT', `/repos/${repo}/pulls/${pull.number}/merge`, { merge_method: 'squash', sha: pull.head })
    // Merged, its head moved (409) or refused by GitHub (405): the repository is read again next pass.
    this.reads.forget(repo)
    if (merged.status !== 200) { this.note('MERGE_REFUSED', `${repo}#${pull.number}: GitHub answered ${merged.status}`); return false }
    const by = pull.readers.join(' and ')
    await this.comment(repo, pull.number, `${SELF}, ${this.clock()}: merged. READ-OK on ${pull.head.slice(0, 7)} by ${by}, checks green.`)
    this.log(`[super-tab] merged ${repo}#${pull.number} on ${pull.head.slice(0, 7)} (READ-OK by ${by})`)
    return true
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
  private async checks(repo: string, at: string, head: string): Promise<{ state: 'passed' | 'running' | 'failed'; failed: string[]; none: boolean }> {
    const runs = object(await this.reads.one(repo, `/repos/${repo}/commits/${head}/check-runs?per_page=${PAGE}`)).check_runs
    const checks = checksOf(Array.isArray(runs) ? runs.map(object) : [], await this.reads.one(repo, `/repos/${repo}/commits/${head}/status`))
    // No check and no status at all: a repository with no CI, or CI that has not started on this head.
    const none = checks.summary === ''
    if (checks.state !== 'passed') return { ...checks, none }
    // Passed, or none yet.
    const before = this.looked.get(at)
    this.looked.set(at, checks.summary)
    return this.now() - this.seenAt.get(at)! < CHECKS_SETTLE_MS || before !== checks.summary ? { state: 'running', failed: [], none } : { ...checks, none }
  }

  /**
   * [comments] with the agent the backend recorded for each verdict among them (`recorded`), which `verdicts` counts as its
   * reader. Only a comment that gives a verdict is asked about, once: a record is made as the comment is, so one with none two
   * minutes after it was written was typed by hand. While the backend cannot be asked, names are read as typed, as before, and
   * that is said once.
   */
  private async recordedNames(project: LedProject, comments: Json[]): Promise<Json[]> {
    if (!this.deps.authors) return comments
    const key = (comment: Json) => `${project.repo}#${String(comment.id)}`
    // A comment changed since it was written is not the words its record was made for (the command never edits): typed by hand.
    const asWritten = (comment: Json) => comment.updated_at === undefined || comment.updated_at === comment.created_at
    const given = comments.filter(comment => Number.isSafeInteger(comment.id) && comment.review !== true && asWritten(comment)
      && ownVerdict(String(comment.body ?? '').split('\n').find(line => line.trim()) ?? ''))
    const unknown = given.filter(comment => this.now() - (this.recorded.get(key(comment))?.at ?? -Infinity) >= RECORD_AGAIN_MS)
    for (let from = 0; from < unknown.length && this.now() >= this.authorsAgainAt; from += AUTHORS_PAGE) {
      const page = unknown.slice(from, from + AUTHORS_PAGE)
      try {
        const authors = await this.deps.authors(project, page.map(comment => `issue:${String(comment.id)}`))
        for (const comment of page) {
          const name = authors[`issue:${String(comment.id)}`]?.name
          const settled = this.now() - Date.parse(String(comment.created_at ?? '')) >= RECORD_SETTLE_MS
          this.recorded.delete(key(comment))
          if (typeof name === 'string' && name.trim()) this.recorded.set(key(comment), { name, at: this.now() })
          else if (settled) this.recorded.set(key(comment), { name: null, at: this.now() })
        }
        if (this.authorsDown) this.log('[super-tab] verdicts are read by their record again')
        this.authorsDown = 0
      } catch (error) {
        if (!this.authorsDown) this.log(`[super-tab] verdicts are read as typed · AUTHORS_UNREAD ${project.repo}: ${error instanceof Error ? error.message : 'the server did not answer'}`)
        this.authorsAgainAt = this.now() + retryIn(++this.authorsDown)
      }
    }
    while (this.recorded.size > RECORDED_MAX) this.recorded.delete(this.recorded.keys().next().value!)
    return comments.map(comment => {
      const name = Number.isSafeInteger(comment.id) && asWritten(comment) ? this.recorded.get(key(comment))?.name : undefined
      return name ? { ...comment, recorded: name } : comment
    })
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
      await this.comment(repo, number, `${SELF}, ${this.clock()}${author ? `, to **${author}**` : ''}: ${noteStart(head, kind)}${rest}`)
    }
    // Once GitHub has answered: a comment that never reached it (the pass failed, and is tried again) is not told.
    this.told.add(key)
    if (this.told.size > TOLD_MAX) this.told.delete(this.told.values().next().value!)
  }

  /** Whether one of the team's [comments] is the note of [kind] on [head]. */
  private said(comments: Json[], head: string, kind: NoteKind): boolean {
    return comments.some(c => TEAM.has(c.author_association) && String(c.body ?? '').slice(0, 500).includes(noteStart(head, kind)))
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
