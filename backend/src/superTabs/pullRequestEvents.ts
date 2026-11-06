// GitHub events on an open task's pull request reach the task's Engineer directly (Dee, #1891, from DeepSeek's Super-agent):
// CI failed or passed, a review or comment, a merge conflict, each once, without waiting for the PM's 30-minute sync. No
// webhook reaches the backend, so the singleton worker reads them every minute with the Harness GitHub App
// (docs/plans/2026-11-03-pr-events-to-engineer-plan.md).
import type { PrismaClient } from '@prisma/client'
import { PULL_PATCH_PERMISSIONS, PULL_WATCH_PERMISSIONS, type GitHubApp } from '../github/app.js'
import { githubRepository, type GitHubRepository } from '../github/repository.js'
import type { SuperTabStore } from './store.js'
import type { PullRequestHead } from './model.js'
import { cleanMainMergeOf } from './mergeCarry.js'
import { patchId } from './pullRequestPatch.js'
import { watchedLinks } from './checkVerdicts.js'
import { logger } from '../utils/logger.js'

/** What GitHub says of one pull request, as the watch reads it (github/app.ts watchPullRequest). */
export interface PullRequestWatch {
  url: string
  number: number
  state: 'open' | 'closed'
  draft: boolean
  /** The head commit's SHA. */
  head: string
  /** The branch it merges into. */
  base: string
  /** False on a merge conflict; null while GitHub is still working it out. */
  mergeable: boolean | null
  /** The head's latest check run of each name. */
  checkRuns: Array<{ name: string; status: string; conclusion: string | null; completedAt: number | null }>
  /** The head's check suites, with how many check runs each has. */
  checkSuites: Array<{ status: string; runs: number }>
  /** Each with its author's tie to the repository, GitHub's author_association (OWNER, MEMBER, COLLABORATOR, NONE...). */
  reviews: Array<{ id: number; login: string; association: string; state: string; body: string; url: string }>
  comments: Array<{ id: number; login: string; association: string; body: string; url: string }>
}

/** One message for the Engineer, and the key it is posted under once. */
export interface PullRequestEvent { key: string; text: string }

export const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'])
const PASSED = new Set(['success', 'neutral', 'skipped'])
/** The keys a group keeps per pull request: its marks, and its newest heads' CI and conflict keys. */
export const SEEN_KEPT = 50
const QUOTE = 300

/** Whether every check run of [watch]'s head is done and passed, and every suite that has runs is done: nothing left to wait for. */
const settledGreen = (watch: PullRequestWatch): boolean => {
  const suites = watch.checkSuites.filter(suite => suite.runs > 0)
  return watch.checkRuns.length > 0 && suites.length > 0 && suites.every(suite => suite.status === 'completed')
    && watch.checkRuns.every(run => run.status === 'completed' && !!run.conclusion && PASSED.has(run.conclusion))
}

/** What a task's pull request shows the board (Conversation.pullRequestChecks, task #3827): `red` once a check failed, `green`
 *  when everything is done and passed (the rule that posts "CI passed"), else `running`: a draft, checks still going, or none read. */
export type ChecksState = 'green' | 'red' | 'running'
export function checksStateOf(watch: PullRequestWatch): ChecksState {
  if (watch.draft) return 'running'
  if (watch.checkRuns.some(run => !!run.conclusion && FAILED.has(run.conclusion))) return 'red'
  return settledGreen(watch) ? 'green' : 'running'
}

const short = (sha: string) => sha.slice(0, 7)
const quoted = (body: string) => {
  const text = body.trim().replace(/\s+/g, ' ')
  return text.length > QUOTE ? `${text.slice(0, QUOTE - 1)}…` : text
}
const REVIEWED: Record<string, string> = { CHANGES_REQUESTED: 'asked for changes on', APPROVED: 'approved' }
/** Whose words reach the Engineer: the repository's own people. Anyone can comment on a public pull request, and the line
 *  reaches an agent as its Lead's, so anyone else's text stays on GitHub behind the link (AGENTS.md standard 7, review of #2750). */
const QUOTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
const said = (association: string, body: string, url: string) => {
  if (!body.trim()) return `. ${url}`
  return QUOTED.has(association) ? `: "${quoted(body)}" ${url}` : `: ${url}`
}

/**
 * What is new in [watch] since the keys in [seen], and the keys to keep from now on. The first read of a pull request
 * ([seen] empty) records what is already there and posts only a merge conflict, which still needs acting on. Nothing from
 * [botLogin], the app's own account, which the Engineer's own comments go out as. While a draft, no CI: a pull request read
 * as a draft (`draft`), whatever its head, is marked when next read as ready (`ready:<ms>`), and a failure finished before
 * that was a draft's own run, still the latest of its name until the ready run starts (review of #2750: a push and Ready
 * in the same minute leave the new head never read as a draft). Reviews and comments are told by their ids: one newer than
 * the highest seen of its kind (`review>:<id>`, `comment>:<id>`) is new, however many came before (review of #2750).
 */
export function pullRequestEvents(watch: PullRequestWatch, seen: readonly string[], botLogin: string | null, now: number): { events: PullRequestEvent[]; keys: string[] } {
  const first = seen.length === 0, known = new Set(seen), events: PullRequestEvent[] = [], found: string[] = []
  const { url, number, head } = watch
  const add = (key: string, text: string, post = !first) => {
    found.push(key)
    if (!known.has(key) && post) events.push({ key, text })
  }
  const readyMark = seen.find(key => key.startsWith('ready:'))
  if (watch.draft) found.push('draft')
  else {
    // Ready since a draft read: from now, unless it was ready already. On the first read everything there is recorded.
    const readyAt = known.has('draft') ? now : readyMark ? Number(readyMark.slice('ready:'.length)) : null
    if (readyAt !== null) found.push(`ready:${readyAt}`)
    const since = !first && readyAt !== null ? readyAt : -Infinity
    const failing = (run: PullRequestWatch['checkRuns'][number]) => !!run.conclusion && FAILED.has(run.conclusion)
    const failed = watch.checkRuns.filter(run => failing(run) && (run.completedAt ?? now) >= since)
    const stale = watch.checkRuns.some(run => failing(run) && (run.completedAt ?? now) < since)
    if (failed.length) add(`ci-red:${head}`, `CI failed on your pull request #${number} (head ${short(head)}): ${failed.map(run => run.name).join(', ')}. ${url}`)
    if (!failed.length && !stale && settledGreen(watch)) {
      add(`ci-green:${head}`, `CI passed on your pull request #${number} (head ${short(head)}). ${url}`)
    }
  }
  if (watch.mergeable === false) {
    add(`conflict:${head}`, `Your pull request #${number} has a merge conflict with ${watch.base} (head ${short(head)}): merge ${watch.base} into its branch and push. ${url}`, true)
  }
  const highest = (kind: string) => Math.max(0, ...seen.filter(key => key.startsWith(`${kind}>:`)).map(key => Number(key.slice(kind.length + 2))))
  const reviewed = highest('review'), commented = highest('comment')
  for (const review of watch.reviews) {
    if (review.login === botLogin || review.id <= reviewed) continue
    add(`review:${review.id}`, `${review.login} ${REVIEWED[review.state] ?? 'reviewed'} your pull request #${number}${said(review.association, review.body, review.url)}`)
  }
  for (const comment of watch.comments) {
    if (comment.login === botLogin || comment.id <= commented) continue
    add(`comment:${comment.id}`, `${comment.login} commented on your pull request #${number}${said(comment.association, comment.body, comment.url)}`)
  }
  // The marks stand for the pull request as it is now and always stay; then its newest CI and conflict keys. A review's or
  // comment's own key is only its message's: the marks say it was told.
  const marks = [...found.filter(key => key === 'draft' || key.startsWith('ready:')),
    `review>:${Math.max(reviewed, ...watch.reviews.map(r => r.id))}`, `comment>:${Math.max(commented, ...watch.comments.map(c => c.id))}`]
  const told = (key: string) => /^(ci-red|ci-green|conflict):/.test(key)
  const kept = [...new Set([...found, ...seen])].filter(told).slice(0, SEEN_KEPT - marks.length)
  return { events, keys: [...marks, ...kept] }
}

/** What a pass asks GitHub: a pull request's watch (null: it cannot say), the patch id of its files at a new head (null: it
 *  cannot say, pullRequestPatch.ts), the app's own login, and `done` once it is over. */
export interface PullRequestReader {
  watch(url: string): Promise<PullRequestWatch | null>
  /** [base]: the branch the watch read it merging into; no id when GitHub's answer for the comparison names another. */
  patch(url: string, head: string, base: string): Promise<string | null>
  /** The head whose verdicts [head] carries, when it is git's own merge of that head and a commit of [base] (mergeCarry.ts,
   *  task #3553), else null: judged from GitHub's comparisons, never from what the pull request says. */
  merge(url: string, head: string, base: string): Promise<string | null>
  botLogin(): Promise<string | null>
  done(): Promise<void>
}

const PULL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/
/** A task quiet this long is not watched: its Engineer is not waiting on its pull request. */
export const WATCH_QUIET_MS = 7 * 24 * 3_600_000
/** The most tasks a pass reads, the most recently active first (AGENTS.md standard 4: no read grows without a bound). */
export const WATCH_GROUPS = 200
/** The most done tasks a pass also reads for their heads (#3394): done before the PM merges, their verdicts must still go
 *  stale on a push, however long the pull request stays open. Production had 31 with links, 11 quiet over a week, of 51
 *  finished, unarchived groups in all (2026-11-05). */
export const WATCH_DONE_GROUPS = 100
/** A head whose patch GitHub could not give is asked again after this long, not every pass. */
export const PATCH_RETRY_MS = 15 * 60_000

/** Whether a pass reads [watch]'s patch id: a head new to the task, or one GitHub could not give a patch for PATCH_RETRY_MS ago.
 *  A new base branch is read again like a new head (security review of #3218, round 3): the id names the branch. */
const patchNeeded = (known: PullRequestHead | undefined, watch: PullRequestWatch, now: number) =>
  known?.head !== watch.head || known.base !== watch.base || (known.patch === null && now - known.at >= PATCH_RETRY_MS)

/** Reads with the Harness GitHub App: one read-only token per repository for the whole pass, revoked when it is done (as the
 *  archive pass's, archive.ts). A repository the app is not installed on, or any GitHub failure, reads as null. */
export function appPullRequestWatch(app: GitHubApp): PullRequestReader {
  // One token per repository and permission set: the watch's, and the patch reads' with contents read (PULL_PATCH_PERMISSIONS).
  const tokens = new Map<string, Promise<string | null>>()
  const token = (repository: GitHubRepository, permissions: typeof PULL_WATCH_PERMISSIONS | typeof PULL_PATCH_PERMISSIONS) => {
    const key = `${repository.fullName.toLowerCase()} ${Object.keys(permissions).sort().join(',')}`
    if (!tokens.has(key)) tokens.set(key, (async () => {
      const installation = await app.installation(repository)
      return installation === null ? null : (await app.createToken(installation, repository, permissions)).token
    })().catch(() => null))
    return tokens.get(key)!
  }
  const read = async <T>(url: string, permissions: typeof PULL_WATCH_PERMISSIONS | typeof PULL_PATCH_PERMISSIONS,
    body: (repository: GitHubRepository, number: number, granted: string) => Promise<T | null>) => {
    const match = PULL.exec(url), repository = match ? githubRepository(`https://github.com/${match[1]}`) : null
    const granted = repository ? await token(repository, permissions) : null
    return granted ? body(repository!, Number(match![2]), granted) : null
  }
  return {
    watch: url => read(url, PULL_WATCH_PERMISSIONS, (repository, number, granted) => app.watchPullRequest(repository, number, granted)),
    // The files at [head], from the comparison of the commits the pull request names: none once it names another head.
    // Against the base the watch saw (review of #3218, round 5): a retarget between the two reads gives no id, so a patch hashed
    // against one branch is never recorded under another; it is read again later.
    patch: (url, head, base) => read(url, PULL_PATCH_PERMISSIONS, async (repository, number, granted) => {
      const read = await app.pullRequestPatchFiles(repository, number, granted, head)
      return read && read.base === base ? patchId(read.files, read.base) : null
    }),
    // Whether the head is git's own merge of its first parent and main, against the base the watch saw: an answer naming
    // another branch carries nothing.
    merge: (url, head, base) => read(url, PULL_PATCH_PERMISSIONS, async (repository, number, granted) => {
      const read = await app.mainMergeSides(repository, number, granted, head)
      return read && read.base === base ? cleanMainMergeOf(read.sides) : null
    }),
    botLogin: () => app.botLogin(),
    async done() {
      for (const granted of tokens.values()) {
        const value = await granted
        if (value) await app.revoke(value).catch(() => {})
      }
      tokens.clear()
    },
  }
}

/**
 * One pass: open tasks (not steps) active in the last [WATCH_QUIET_MS] that link a pull request, at most [limit] of them, the
 * most recently active first, have each open one read once, and what is new goes to its Engineer (store.ts
 * pullRequestSeen). One group's failure is logged and skips that group alone. A pass that posted, or could not read a pull
 * request, says so in one line: the measure of this feature (AGENTS.md standards 6 and 8). The messages posted.
 */
export async function watchPullRequests(db: PrismaClient, store: Pick<SuperTabStore, 'pullRequestSeen' | 'pullRequestHeadsWatched' | 'pullRequestClosed'>, reader: PullRequestReader, now: number,
  limit = WATCH_GROUPS, doneLimit = WATCH_DONE_GROUPS): Promise<number> {
  try {
    // The finished mark's index, [workFinished, archived, lastActivityAt]: equality, equality, then the range, which also
    // gives the sort; the rest filters what it fetches. A step's reviewOf is a string and a task has none (null matches it).
    // Open tasks, then done ones, each read by that index (#3394: a done task's pull request is not merged yet, and its verdicts
    // must go stale on a push however long it waits: no activity range, as only finished, unarchived groups match).
    const since = { lastActivityAt: { $gte: { $date: new Date(now - WATCH_QUIET_MS).toISOString() } } }
    const read = (workFinished: boolean, cap: number, more: Record<string, unknown> = {}) => cap <= 0 ? Promise.resolve([]) : db.swarmGroup.aggregateRaw({ pipeline: [
      { $match: { workFinished, archived: false, ...more, deleted: false, kind: null, 'data.reviewOf': null, 'data.pullRequestUrls.0': { $exists: true } } },
      { $sort: { lastActivityAt: -1 } },
      { $limit: cap },
      { $project: { _id: 0, tabId: 1, key: 1, urls: '$data.pullRequestUrls', heads: '$data.pullRequestHeads', steps: '$data.stepIds' } },
    ] }) as unknown as Promise<Array<{ tabId: string; key: string; urls: string[]; heads?: Record<string, PullRequestHead> | null; steps?: string[] | null }>>
    const rows = [...await read(false, limit, since), ...await read(true, doneLimit, { 'data.assignment.status': 'done' })]
    if (!rows.length) return 0
    const bot = await reader.botLogin()
    // One read per pull request a pass, however many tasks link it.
    const reads = new Map<string, Promise<PullRequestWatch | null>>()
    const watchOf = (url: string) => { if (!reads.has(url)) reads.set(url, reader.watch(url).catch(() => null)); return reads.get(url)! }
    // A patch id is read only for a head the task has not recorded yet, or whose patch GitHub could not give PATCH_RETRY_MS ago
    // (#3394), once a pass whatever links it.
    const patches = new Map<string, Promise<string | null>>()
    const patchOf = (url: string, head: string, base: string) => {
      const key = `${url}@${head}@${base}`
      if (!patches.has(key)) patches.set(key, reader.patch(url, head, base).catch(() => null))
      return patches.get(key)!
    }
    // Each task's newest links (watchedLinks), with their pull request as GitHub has it now and a patch where one is needed.
    // A head new to a task is asked whether it is git's own merge of another head and main (#3553), once a pass.
    const merges = new Map<string, Promise<string | null>>()
    const mergeOf = (url: string, head: string, base: string) => {
      const key = `${url}@${head}@${base}`
      if (!merges.has(key)) merges.set(key, reader.merge(url, head, base).catch(() => null))
      return merges.get(key)!
    }
    const seen: Array<{ row: typeof rows[number]; watch: PullRequestWatch; patch: string | null | undefined; merged: string | null | undefined }> = []
    const closed: Array<{ row: typeof rows[number]; url: string }> = []
    for (const row of rows) {
      for (const url of watchedLinks(row.urls)) {
        const watch = await watchOf(url)
        // A pull request the watch read before and GitHub now shows closed stops capturing the task's checks (task #3953).
        if (watch?.state === 'closed' && row.heads?.[url] && !row.heads[url]!.closed) closed.push({ row, url })
        if (watch?.state !== 'open') continue
        const known = row.heads?.[url] ?? undefined, newHead = known?.head !== watch.head || known.base !== watch.base
        seen.push({ row, watch, patch: patchNeeded(known, watch, now) ? await patchOf(url, watch.head, watch.base) : undefined,
          merged: newHead ? await mergeOf(url, watch.head, watch.base) : undefined })
      }
    }
    // A task whose links moved past a head it keeps (review of #3218, round 3): that head is no longer read, so it is dropped
    // and the task's verdicts on it stop counting, whether or not any head it reads changed.
    const moved = rows.filter(row => {
      const window = new Set(watchedLinks(row.urls))
      return Object.keys(row.heads ?? {}).some(url => !window.has(url))
    })
    // A task from before steps were listed, at a new head or dropping one: its dormant steps are looked up once, then listed.
    const unlisted = [...seen.filter(s => s.patch !== undefined).map(s => s.row), ...moved].filter(row => !Array.isArray(row.steps))
    const listed = await listedSteps(db, unlisted)
    for (const row of moved) {
      try {
        const lookedUp = listed.get(`${row.tabId}:${row.key}`)
        await store.pullRequestHeadsWatched(row.tabId, row.key, row.steps ?? lookedUp ?? [], lookedUp !== undefined)
      } catch (error) {
        logger.warn('[swarm-pr-events] group skipped', { tabId: row.tabId, group: row.key, error: error instanceof Error ? error.message : String(error) })
      }
    }
    for (const { row, url } of closed) {
      try {
        await store.pullRequestClosed(row.tabId, row.key, url)
      } catch (error) {
        logger.warn('[swarm-pr-events] group skipped', { tabId: row.tabId, group: row.key, error: error instanceof Error ? error.message : String(error) })
      }
    }
    let posted = 0
    for (const { row, watch, patch, merged } of seen) {
      try {
        const lookedUp = listed.get(`${row.tabId}:${row.key}`)
        posted += await store.pullRequestSeen(row.tabId, row.key, watch, bot, patch, row.steps ?? lookedUp ?? [], lookedUp !== undefined, merged ?? null)
      } catch (error) {
        logger.warn('[swarm-pr-events] group skipped', { tabId: row.tabId, group: row.key, error: error instanceof Error ? error.message : String(error) })
      }
    }
    const unreadable = (await Promise.all(reads.values())).filter(watch => watch === null).length
    // Heads whose patch GitHub could not give: their verdicts count only at that exact head until a later read gives it.
    const unpatched = (await Promise.all(patches.values())).filter(patch => patch === null).length
    const line = { groups: rows.length, pulls: reads.size, unreadable, patched: patches.size, unpatched, posted }
    if (unreadable || unpatched) logger.warn('[swarm-pr-events] pass', line)
    else if (posted) logger.info('[swarm-pr-events] pass', line)
    return posted
  } finally { await reader.done() }
}

/** A task whose pull requests a command needs read now (store.ts headsReadNow): its key, its heads as recorded, its steps. */
export interface TaskHeads { key: string; heads?: Record<string, PullRequestHead> | null; steps?: string[] | null }

/**
 * Reads [urls], pull requests the task [task] links, now, as a pass reads them, and records what GitHub says (store.ts
 * pullRequestSeen) before the command that needs it is judged (task #3628): a verdict at the pull request's real head was not
 * counted while the minute's pass had not read the push yet (#3561). The pass's own reads, its own write: the head, its patch
 * when new, whether it is git's own main merge, and the events, each posted once whichever read sees it first. A closed pull
 * request is left to the pass. The pull requests GitHub could not say anything of.
 */
export async function readPullRequestsNow(db: PrismaClient, store: Pick<SuperTabStore, 'pullRequestSeen'>, reader: PullRequestReader, tabId: string,
  task: TaskHeads, urls: readonly string[], now: number): Promise<string[]> {
  try {
    const unread: string[] = []
    let bot: string | null | undefined, listed: string[] | undefined
    for (const url of urls) {
      const watch = await reader.watch(url).catch(() => null)
      if (!watch) unread.push(url)
      if (watch?.state !== 'open') continue
      const known = task.heads?.[url] ?? undefined, newHead = known?.head !== watch.head || known.base !== watch.base
      const patch = patchNeeded(known, watch, now) ? await reader.patch(url, watch.head, watch.base).catch(() => null) : undefined
      const merged = newHead ? await reader.merge(url, watch.head, watch.base).catch(() => null) : null
      // A task from before steps were listed looks its dormant steps up once, as the pass does at a new head.
      if (patch !== undefined && !Array.isArray(task.steps) && listed === undefined) listed = (await listedSteps(db, [{ tabId, key: task.key }])).get(`${tabId}:${task.key}`)
      if (bot === undefined) bot = await reader.botLogin().catch(() => null)
      await store.pullRequestSeen(tabId, task.key, watch, bot, patch, task.steps ?? listed ?? [], listed !== undefined, merged)
    }
    return unread
  } finally { await reader.done() }
}

/** The dormant steps of [tasks] that list none (Conversation.stepIds absent: tasks from before steps were listed), by
 *  `tabId:key`, an empty list for one with none: one read for the pass, by the awake-groups index's tabId, dormant and
 *  deleted, examining a Swarm's dormant groups once (production's largest Swarm had 3,060 groups, 2026-11-05). Each task then
 *  lists its steps (store.ts pullRequestSeen), so this runs again only for another task from before, at its first new head.
 *  Awake steps need no lookup: they load with the task. */
export async function listedSteps(db: PrismaClient, tasks: ReadonlyArray<{ tabId: string; key: string }>): Promise<Map<string, string[]>> {
  const listed = new Map<string, string[]>()
  if (!tasks.length) return listed
  for (const task of tasks) listed.set(`${task.tabId}:${task.key}`, [])
  const rows = await db.swarmGroup.aggregateRaw({ pipeline: [
    { $match: { tabId: { $in: [...new Set(tasks.map(t => t.tabId))] }, dormant: true, deleted: false, 'data.reviewOf': { $in: [...new Set(tasks.map(t => t.key))] } } },
    { $project: { _id: 0, tabId: 1, key: 1, task: '$data.reviewOf' } },
  ] }) as unknown as Array<{ tabId: string; key: string; task: string }>
  for (const step of rows) listed.get(`${step.tabId}:${step.task}`)?.push(step.key)
  return listed
}

/** Runs the pass every minute in the singleton worker, one at a time. */
export function startPullRequestWatch(db: PrismaClient, store: Pick<SuperTabStore, 'pullRequestSeen' | 'pullRequestHeadsWatched' | 'pullRequestClosed'>, reader: () => PullRequestReader, everyMs = 60_000): () => void {
  let running = false
  const run = () => {
    if (running) return
    running = true
    void watchPullRequests(db, store, reader(), Date.now())
      .catch(error => logger.warn('[swarm-pr-events] failed', { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { running = false })
  }
  run()
  const timer = setInterval(run, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
