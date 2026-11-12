import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { authorOf, checksOf, COST_AGAIN_MS, COST_WAIT_MS, GitHubMerge, ledProjects, noteOf, pmRunsHere, recordedAuthors, verdictOf, VerdictRecords, verdicts, type LedProject } from './githubMerge.js'
import type { ReadRow } from './taskTokens.js'
import type { Crew } from './assign/crew.js'
import type { GitHubGet, GitHubSend } from './githubRest.js'
import { commandRecords } from './commandRecords.fake.js'

type Json = Record<string, unknown>
const HEAD = 'f6edb44c0ffee0000000000000000000000000ab'
const OLD = 'a1b2c3d4e5f60000000000000000000000000000'
/** The commit of main a pull request stands on, and two more of main's, one after the other. */
const FORK = 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0', M1 = '1'.repeat(40), M2 = '2'.repeat(40)
/** The head of a pull request another is built on, and its head once a fix is pushed to it. */
const UNDER = 'b0b0b0b0c0ffee000000000000000000000000ab', FIXED = 'c1c1c1c1c0ffee000000000000000000000000ab'
const comment = (body: string, extra: Json = {}): Json => ({ body, author_association: 'MEMBER', user: { login: 'deehw' }, created_at: '2026-11-09T12:00:00Z', ...extra })
/** A pull request of the repository's own branch, as GitHub lists it. */
const pull = ({ head, ...extra }: Json = {}): Json => ({ number: 4, draft: false, base: { ref: 'main' }, labels: [{ name: 'builder:pip' }], body: 'Closes #2', author_association: 'MEMBER', ...extra,
  head: { sha: HEAD, ref: 'pip/2', repo: { full_name: 'acme/app' }, ...head as Json } })

/** One repository as GitHub's REST API answers for it, with ETags, and what was sent to it. */
function fakeGitHub() {
  const records = commandRecords()
  const repo = { pulls: [pull()], comments: new Map<number, Json[]>([[4, [comment('Juno, 14:20, to **Pip**: READ-OK f6edb44')]]]), reviews: new Map<number, Json[]>(), commits: new Map<number, Json[]>(), compare: new Map<string, Json>(),
    runs: new Map<string, Json[]>([[HEAD, [{ name: 'test', status: 'completed', conclusion: 'success' }]]]), statuses: new Map<string, Json[]>(),
    // The tasks, as issues: #2 is the one `pull()` closes. And the status GitHub answers with for a task it does not give.
    issues: new Map<number, Json>([[2, { number: 2, body: 'Say a quote a day.' }]]), refused: new Map<number, number>(),
    state: 'clean', mergeAnswer: 200, signedOut: false, down: false, status: 0, sendFails: 0,
    // Whether GitHub says the repository is private: a public one unless a test says.
    private: false as boolean | undefined }
  const sent: Array<{ method: string; path: string; body: unknown }> = []
  /** Every read asked, and whether it carried the last answer's ETag. */
  const asked: string[] = []
  const get: GitHubGet = async (path, etag) => {
    asked.push(`${path}${etag ? ' (with an ETag)' : ''}`)
    if (repo.signedOut) throw Object.assign(new Error('gh is not signed in on this computer: run `gh auth login`.'), { code: 'GH_SIGNED_OUT' })
    if (repo.down) throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })
    if (repo.status) return { status: repo.status, etag: null, body: null, resetAt: null }
    const url = new URL(`https://api.github.com${path}`)
    const p = url.pathname
    const refused = repo.refused.get(Number(/\/issues\/(\d+)$/.exec(p)?.[1]))
    if (refused) return { status: refused, etag: null, body: null, resetAt: null }
    // Each pull request here is alone and holds main's tip (`behind_by` 0), so it merges on its own; the train is githubTrain.spec.ts.
    const compared = p.split('...').at(-1)!
    const body = p === '/repos/acme/app' ? { default_branch: 'main', private: repo.private }
      : p === '/repos/acme/app/pulls' && url.searchParams.get('state') === 'closed' ? []
      // A page of the list, as GitHub pages it.
      : p === '/repos/acme/app/pulls' ? repo.pulls.slice((Number(url.searchParams.get('page') ?? 1) - 1) * Number(url.searchParams.get('per_page') ?? 30),
        Number(url.searchParams.get('page') ?? 1) * Number(url.searchParams.get('per_page') ?? 30))
      : /\/issues\/\d+\/comments$/.test(p) ? (repo.comments.get(Number(p.split('/').at(-2))) ?? []).map(records.served)
      : /\/issues\/\d+$/.test(p) ? repo.issues.get(Number(p.split('/').at(-1))) ?? null
      : /\/pulls\/\d+\/reviews$/.test(p) ? repo.reviews.get(Number(p.split('/').at(-2))) ?? []
      : /\/pulls\/\d+\/commits$/.test(p) ? repo.commits.get(Number(p.split('/').at(-2))) ?? [{ sha: HEAD }]
      // A head against main, from the commit of main it stands on (FORK unless the test says another); and main's own change
      // between two of its commits.
      : /\/compare\/main\.\.\.[0-9a-f]+$/.test(p) ? repo.compare.has(compared) ? { behind_by: 0, merge_base_commit: { sha: FORK }, ...repo.compare.get(compared) }
        : compared === HEAD ? { behind_by: 0, merge_base_commit: { sha: FORK }, files: [] } : null
      : /\/compare\/[0-9a-f]+\.\.\.[0-9a-f]+$/.test(p) ? repo.compare.has(p.split('/compare/')[1]!) ? { behind_by: 0, ...repo.compare.get(p.split('/compare/')[1]!) } : null
      : /\/commits\/[0-9a-f]+\/check-runs$/.test(p) ? { check_runs: repo.runs.get(p.split('/').at(-2)!) ?? [] }
      : /\/commits\/[0-9a-f]+\/status$/.test(p) ? { statuses: repo.statuses.get(p.split('/').at(-2)!) ?? [] }
      : /\/pulls\/\d+$/.test(p) ? { mergeable_state: repo.state }
      : null
    if (body === null) return { status: 404, etag: null, body: null, resetAt: null }
    const tag = `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`
    return etag === tag ? { status: 304, etag: tag, body: null, resetAt: null } : { status: 200, etag: tag, body, resetAt: null }
  }
  const send: GitHubSend = async (method, path, body) => {
    if (method === 'POST' && repo.sendFails > 0) { repo.sendFails--; throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }) }
    sent.push({ method, path, body })
    if (method === 'PUT') return { status: repo.mergeAnswer, etag: null, body: { merged: repo.mergeAnswer === 200 }, resetAt: null }
    return { status: 201, etag: null, body: {}, resetAt: null }
  }
  return { repo, sent, asked, get, send, authors: records.authors }
}

function setup() {
  const github = fakeGitHub()
  const log = vi.fn()
  // Pip builds; Juno is the PM.
  const crew: Crew = { builders: [{ id: 'pip', name: 'Pip', label: 'builder:pip', machineId: 'mac', engine: 'claude' }], machines: [] }
  const team = vi.fn(async () => crew)
  const clock = { now: Date.parse('2026-11-09T07:31:00Z') }
  // What the server keeps of what each change cost its builder (taskTokens.ts): nothing, unless a test says.
  const costs = vi.fn(async (_project: LedProject, _numbers: number[]): Promise<ReadRow[]> => [])
  const merger = new GitHubMerge({ projects: async () => [{ repo: 'acme/app', pm: 'Juno', tabId: 'tab', pmAgentId: 'juno', projectId: 'app' }],
    crew: team, get: github.get, send: github.send, now: () => clock.now, log, records: new VerdictRecords(github.authors, () => clock.now, log), costs })
  const merges = () => github.sent.filter(s => s.method === 'PUT')
  const comments = () => github.sent.filter(s => s.method === 'POST').map(s => String((s.body as Json).body))
  return { github, merger, log, merges, comments, clock, crew: team, costs }
}

/** Two passes three minutes apart: a head's checks count as passed only once they hold still (githubMerge.ts CHECKS_SETTLE_MS), so
 *  each merge decision, yes or no, is made where a merge could happen. */
async function settle(f: { merger: GitHubMerge; clock: { now: number } }): Promise<void> {
  await f.merger.tick()
  f.clock.now += 3 * 60_000
  await f.merger.tick()
}

describe('Harness merges by rule, as lampOS\'s train bot does (githubMerge.ts)', () => {
  it('merges a pull request whose head has a READ-OK from another reader and green checks, squashed at that head', async () => {
    const f = setup()
    await settle(f)
    expect(f.merges()).toEqual([{ method: 'PUT', path: '/repos/acme/app/pulls/4/merge', body: { merge_method: 'squash', sha: HEAD } }])
    expect(f.comments()).toEqual([expect.stringMatching(/^Harness, \d\d:\d\d: merged\. READ-OK on f6edb44 by Juno, checks green\.$/)])
  })

  // Swarm allocator, package 12: the comment that says a change landed carries what it cost its builder, from the rows its
  // builder's own daemon wrote (taskTokens.ts). The same comment: nothing more is written to GitHub.
  it('says in the comment that it merged what the change cost its builder: its model, minutes, tokens and fix rounds', async () => {
    const f = setup()
    f.github.repo.private = true
    const taken = f.clock.now - 39 * 60_000
    const tokens = [{ model: 'claude-sonnet-5-5', input: 1_200, output: 3_400, cacheRead: 0, cacheWrite: 0 }]
    f.costs.mockResolvedValue([{ number: 2, kind: 'build', name: 'Pip', tokens, rounds: 0, startedAt: taken, endedAt: taken + 60_000 },
      { number: 4, kind: 'fix', name: 'Pip', tokens, rounds: 1, startedAt: taken + 120_000, endedAt: taken + 180_000 },
      { number: 4, kind: 'read', name: 'Juno', tokens, rounds: 1, startedAt: taken, endedAt: taken }])
    await settle(f)
    expect(f.comments()).toEqual([expect.stringMatching(/^Harness, \d\d:\d\d: merged\. READ-OK on f6edb44 by Juno, checks green\. Built by pip on `claude-sonnet-5-5`: 42 min, 9k tokens, 1 fix round\.$/)])
    // Asked once, as the project's PM, for the pull request and the task it closes.
    expect(f.costs.mock.calls).toEqual([[{ repo: 'acme/app', pm: 'Juno', tabId: 'tab', pmAgentId: 'juno', projectId: 'app' }, [4, 2]]])
    expect(f.github.sent.filter(s => s.method === 'POST')).toHaveLength(1)
  })

  // anh Dee's call, 12 November: on a public repository the builder's model and what the change used of its person's
  // subscription would be public in that person's name. Its rows stay on the server, for the project's members.
  it('says nothing of what a change cost on a repository GitHub does not say is private, and asks the server nothing for it', async () => {
    for (const visibility of [false, undefined]) {
      const f = setup()
      f.github.repo.private = visibility
      f.costs.mockResolvedValue([{ number: 4, kind: 'build', name: 'Pip', rounds: 0, startedAt: f.clock.now, endedAt: f.clock.now,
        tokens: [{ model: 'claude-sonnet-5-5', input: 9_000, output: 0, cacheRead: 0, cacheWrite: 0 }] }])
      await settle(f)
      expect(f.comments(), String(visibility)).toEqual([expect.stringMatching(/^Harness, \d\d:\d\d: merged\. READ-OK on f6edb44 by Juno, checks green\.$/)])
      expect(f.costs).not.toHaveBeenCalled()
      // Its privacy is in the read of the repository each pass makes already.
      expect(f.github.asked.filter(path => path.startsWith('/repos/acme/app ') || path === '/repos/acme/app')).toHaveLength(2)
    }
  })

  it('merges and says so as before when the cost cannot be read, says that once, leaves the server alone a quarter of an hour after each miss, and says once when it is read again', async () => {
    const f = setup()
    f.github.repo.private = true
    /** The next pull request, alone and ready, merged at [at]: seen a pass before, its checks holding still since. */
    const mergeNext = async (number: number, at: number) => {
      f.github.repo.pulls = [pull({ number, head: { ref: `pip/${number + 100}` }, body: '' })]
      f.github.repo.comments.set(number, [comment('Juno, 14:20, to **Pip**: READ-OK f6edb44')])
      await f.merger.tick()
      f.clock.now = at
      await f.merger.tick()
    }
    const unread = () => f.log.mock.calls.map(([line]) => String(line)).filter(line => line.includes('cost'))
    const MIN = 60_000
    f.costs.mockRejectedValue(new Error('the server did not answer'))
    await settle(f)
    const first = f.clock.now
    expect(unread()).toEqual(['[super-tab] a landed change\'s cost could not be read: it is not said · COST_UNREAD acme/app'])
    // Within the quarter it is not asked again. As the quarter ends it is, and misses again: nothing more is said.
    await mergeNext(5, first + 10 * MIN)
    expect(f.costs).toHaveBeenCalledTimes(1)
    await mergeNext(6, first + COST_AGAIN_MS)
    expect(f.costs).toHaveBeenCalledTimes(2)
    // The quarter counts again from that miss.
    await mergeNext(7, first + 2 * COST_AGAIN_MS - 1)
    expect(f.costs).toHaveBeenCalledTimes(2)
    expect(unread()).toHaveLength(1)
    f.costs.mockResolvedValue([])
    await mergeNext(8, first + 2 * COST_AGAIN_MS + 5 * MIN)
    expect(f.costs).toHaveBeenCalledTimes(3)
    expect(unread()).toEqual([expect.stringContaining('COST_UNREAD'), '[super-tab] landed changes\' costs are read again · acme/app'])
    // Each merged and said so as before; by its branch alone, a pull request names its task too.
    expect(f.comments()).toHaveLength(5)
    for (const said of f.comments()) expect(said).toMatch(/merged\. READ-OK on f6edb44 by Juno, checks green\.$/)
    expect(f.costs.mock.calls.at(-1)![1]).toEqual([8, 108])
    // Read again, the next miss is said anew.
    f.costs.mockRejectedValue(new Error('the server did not answer'))
    await mergeNext(9, f.clock.now + 5 * MIN)
    expect(unread()).toHaveLength(3)
  })

  it('asks the server about no more than twenty numbers, however many issues a pull request says it closes', async () => {
    const f = setup()
    f.github.repo.private = true
    f.github.repo.pulls = [pull({ body: Array.from({ length: 30 }, (_, i) => `Closes #${100 + i}`).join('\n') })]
    await settle(f)
    expect(f.costs.mock.calls[0]![1]).toEqual([4, ...Array.from({ length: 19 }, (_, i) => 100 + i)])
  })

  it('asks about each number once, though a pull request\'s branch names its own', async () => {
    const f = setup()
    f.github.repo.private = true
    f.github.repo.pulls = [pull({ head: { ref: 'pip/4' } })]
    await settle(f)
    expect(f.costs.mock.calls.map(([, numbers]) => numbers)).toEqual([[4, 2]])
  })

  it('does not hold the comment for a server that never answers: past the wait it is posted without the cost', async () => {
    vi.useFakeTimers()
    try {
      const f = setup()
      f.github.repo.private = true
      f.costs.mockReturnValue(new Promise<ReadRow[]>(() => {}))
      await f.merger.tick()
      f.clock.now += 3 * 60_000
      const pass = f.merger.tick()
      await vi.advanceTimersByTimeAsync(COST_WAIT_MS - 1)
      expect(f.merges()).toHaveLength(1)
      expect(f.comments()).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await pass
      expect(f.comments()).toEqual([expect.stringMatching(/merged\. READ-OK on f6edb44 by Juno, checks green\.$/)])
    } finally { vi.useRealTimers() }
  })

  // lampOS merge-when-green.sh: checks count as passed only once they are "the same in two looks 30 s apart, from 3 min on". A
  // head just pushed has no checks yet, which read as all passed; and a job that needs another gets its check only when that one
  // ends, so for a moment every check there is has passed.
  it('merges only once the head\'s checks hold still: none yet is no pass, nor the first job of two', async () => {
    const f = setup()
    f.github.repo.runs.set(HEAD, [])
    await f.merger.tick()
    expect(f.merges()).toEqual([])
    // The first job ends; the one that needs it is only now made.
    f.clock.now += 60_000
    f.github.repo.runs.set(HEAD, [{ name: 'build', status: 'completed', conclusion: 'success' }])
    await f.merger.tick()
    expect(f.merges()).toEqual([])
    f.clock.now += 30_000
    f.github.repo.runs.set(HEAD, [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'queued' }])
    await f.merger.tick()
    f.clock.now += 60_000
    f.github.repo.runs.set(HEAD, [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'completed', conclusion: 'success' }])
    await f.merger.tick()
    // Both passed, but the checks changed since the last look.
    expect(f.merges()).toEqual([])
    // Half a minute later they read the same, three minutes after the head was first seen.
    f.clock.now += 30_000
    await f.merger.tick()
    expect(f.merges()).toHaveLength(1)
  })

  // lampOS train-bot.sh (25 Oct, #3014 and #3391 carried #3064's commit under their own): a pull request that carries another open
  // one's commits would merge them with it, unread or held. It waits until that one merges, told once. The note says what it
  // waits for and no more: until 2026-11-12 it ended "then update it from main", and for one stack of three a builder did,
  // three times, each a push and a run of the checks, and one a read again, where one nobody touched landed by itself.
  it('merges no pull request that carries another open one\'s commits, and tells its author once what it waits for, and no more', async () => {
    const f = setup()
    f.github.repo.pulls = [pull(), pull({ number: 5, draft: true, labels: [], head: { sha: UNDER, ref: 'ken/base' }, user: { login: 'kenmore' } })]
    f.github.repo.commits.set(4, [{ sha: UNDER }, { sha: HEAD }])
    await settle(f)
    f.clock.now += 30_000
    await f.merger.tick()
    expect(f.merges()).toEqual([])
    expect(f.comments()).toEqual([expect.stringMatching(/^Harness, \d\d:\d\d, to \*\*pip\*\*: not merged yet at f6edb44: it lands after #5, whose commits it carries \(its head b0b0b0b\)\.$/)])
    // Once #5 is merged it is no longer open, and this one merges.
    f.github.repo.pulls = [pull()]
    f.clock.now += 30_000
    await f.merger.tick()
    expect(f.merges()).toHaveLength(1)
  })

  // lampOS lib.sh patch_of and train-bot.sh: a READ-OK counts for the head, "or a head whose diff from its merge base is the same
  // patch, i.e. a plain rebase" (git diff -U0 | git patch-id). Updated from main with nothing of its own changed, a pull request
  // waited on a reader who had read it all.
  const changed = (lines: string[], at = 4) => ({ files: [{ filename: 'sandbox/quotes.py', status: 'modified', changes: lines.length,
    patch: [`@@ -${at},3 +${at},${2 + lines.length} @@ def quote():`, '     today = date.today()', ...lines, '     return pick(today)'].join('\n') }] })
  // Main grew by five lines above the change between the two heads' bases: the same lines, five further down.
  const grew = (file = 'sandbox/quotes.py') => ({ files: [{ filename: file, status: 'modified', changes: 5, patch: '@@ -1,2 +1,7 @@\n import os\n+a\n+b\n+c\n+d\n+e\n import sys' }] })
  const rebased = (f: ReturnType<typeof setup>, at: number, main: Json | null = grew()) => {
    f.github.repo.comments.set(4, [comment('Juno, 14:20, to **Pip**: READ-OK a1b2c3d')])
    f.github.repo.compare.set('a1b2c3d', { merge_base_commit: { sha: M1 }, ...changed(['+    days = int(n)', '-    days = 1']) })
    f.github.repo.compare.set(HEAD, { merge_base_commit: { sha: M2 }, ...changed(['+    days = int(n)', '-    days = 1'], at) })
    if (main) f.github.repo.compare.set(`${M1}...${M2}`, main)
  }
  it('counts a READ-OK on an earlier head whose change is the same as the head\'s, as lampOS\'s patch_of reads it', async () => {
    const f = setup()
    // Main moved under it: the same lines among the same lines, further down by what main added above them.
    rebased(f, 9)
    await settle(f)
    expect(f.merges()).toHaveLength(1)
  })

  // Review of #3993. The lines around a change do not say where it is when the same lines stand in several places: a step
  // added to one job of a workflow and the same step added to another read the same, numbers aside (11 of this repository's
  // 51 workflow files have such places). So the place counts too: where each change begins, moved only by what the base
  // itself added or removed above it between the two heads' bases.
  it.each<[string, (f: ReturnType<typeof setup>) => void]>([
    ['at another place on the same base', f => {
      f.github.repo.comments.set(4, [comment('Juno, 14:20, to **Pip**: READ-OK a1b2c3d')])
      f.github.repo.compare.set('a1b2c3d', changed(['+    days = int(n)', '-    days = 1']))
      f.github.repo.compare.set(HEAD, changed(['+    days = int(n)', '-    days = 1'], 9))
    }],
    ['moved by more than main added above them', f => rebased(f, 12)],
    ['moved though main changed another file alone', f => rebased(f, 9, grew('sandbox/other.py'))],
    ['on a base whose own change GitHub does not give', f => rebased(f, 9, null)],
    ['on a base whose change to that file GitHub gives no patch for', f => rebased(f, 9, { files: [{ filename: 'sandbox/quotes.py', status: 'modified', changes: 5 }] })],
    ['on a base that does not hold the earlier one', f => rebased(f, 9, { ...grew(), behind_by: 2 })],
  ])('takes no READ-OK on an earlier head whose same lines, among the same lines, are %s', async (_case, arrange) => {
    const f = setup()
    arrange(f)
    await settle(f)
    expect(f.merges()).toEqual([])
  })
  // The second review of #3993: what the base did to the file between the two heads' bases, case by case. `at` is where the
  // head's change begins; the earlier head's begins at line 4 and stands on lines 4 to 6.
  const base = (patch: string, extra: Json = {}) => ({ files: [{ filename: 'sandbox/quotes.py', status: 'modified', changes: 1, patch, ...extra }] })
  it.each<[string, number, Json, number]>([
    ['removed two lines above it: two lines up', 2, base('@@ -1,3 +1,1 @@\n import os\n-a\n-b'), 1],
    ['added a line right before the first line it stands on: one line down', 5, base('@@ -1,3 +1,4 @@\n import os\n import re\n import sys\n+x'), 1],
    ['changed lines below it alone: where it was', 4, base('@@ -7,2 +7,6 @@\n tail\n+a\n+b\n+c\n+d\n end'), 1],
    ['changed a line above and a line below in one hunk: moved by the one above alone', 5, base('@@ -1,9 +1,12 @@\n import os\n+x\n import re\n import sys\n def quote():\n     today\n     days\n     return\n-old\n+new\n+newer\n+newest\n end'), 1],
    ['changed a line it stands on', 4, base('@@ -3,3 +3,3 @@\n import sys\n-def quote():\n+def quote(n):\n     today'), 0],
    // The file's own change is among them, and would carry it: the list may be cut short, so it is not read.
    ['changed 300 files or more', 9, { files: [...grew().files, ...Array.from({ length: 299 }, (_, at) => ({ filename: `docs/${at}.md`, status: 'modified', changes: 1, patch: '@@ -1 +1 @@\n-a\n+b' }))] }, 0],
    ['lists the file twice', 9, { files: [...grew().files, ...grew().files] }, 0],
  ])('across a rebase onto a base that %s', async (_case, at, main, merges) => {
    const f = setup()
    rebased(f, at, main)
    await settle(f)
    expect(f.merges()).toHaveLength(merges)
  })

  it('counts each hunk of a file by itself: one above a change of the base stays, one below it moves', async () => {
    const two = (first: number, second: number) => ({ files: [{ filename: 'sandbox/quotes.py', status: 'modified', changes: 2,
      patch: `@@ -${first},3 +${first},4 @@\n a\n+one\n b\n c\n@@ -${second},3 +${second + 1},4 @@\n x\n+two\n y\n z` }] })
    for (const [second, merges] of [[45, 1], [40, 0]] as const) {
      const f = setup()
      f.github.repo.comments.set(4, [comment('Juno, 14:20, to **Pip**: READ-OK a1b2c3d')])
      f.github.repo.compare.set('a1b2c3d', { merge_base_commit: { sha: M1 }, ...two(4, 40) })
      f.github.repo.compare.set(HEAD, { merge_base_commit: { sha: M2 }, ...two(4, second) })
      // The base added five lines between the two.
      f.github.repo.compare.set(`${M1}...${M2}`, base('@@ -20,2 +20,7 @@\n m\n+a\n+b\n+c\n+d\n+e\n n'))
      await settle(f)
      expect(f.merges(), String(second)).toHaveLength(merges)
    }
  })

  // A renamed file's lines are numbered in the file as it was named: what the base did above them is under that name.
  it('counts a renamed file by the name it had: its lines moved by what the base added above them under that name', async () => {
    const renamed = (at: number) => ({ files: [{ ...changed(['+    days = int(n)', '-    days = 1'], at).files[0], filename: 'sandbox/sayings.py', previous_filename: 'sandbox/quotes.py', status: 'renamed' }] })
    for (const [at, merges] of [[9, 1], [4, 0]] as const) {
      const f = setup()
      f.github.repo.comments.set(4, [comment('Juno, 14:20, to **Pip**: READ-OK a1b2c3d')])
      f.github.repo.compare.set('a1b2c3d', { merge_base_commit: { sha: M1 }, ...renamed(4) })
      f.github.repo.compare.set(HEAD, { merge_base_commit: { sha: M2 }, ...renamed(at) })
      f.github.repo.compare.set(`${M1}...${M2}`, grew())
      await settle(f)
      expect(f.merges(), String(at)).toHaveLength(merges)
    }
  })

  it('counts a READ-OK across a rebase onto a base that changed other files alone, its lines where they were', async () => {
    const f = setup()
    rebased(f, 4, grew('sandbox/other.py'))
    await settle(f)
    expect(f.merges()).toHaveLength(1)
  })

  // Review of #3977. Read as lampOS's `git diff -U0 | git patch-id`, a change was its added and removed lines alone: the same
  // line added in another function of the same file was the same change, and a READ-OK carried to code nobody had read.
  it.each([
    ['among other lines', (patch: string) => patch.replace('today = date.today()', 'if admin:')],
    ['under another heading', (patch: string) => patch.replace('def quote():', 'def grant():')],
  ])('takes no READ-OK on an earlier head whose same lines are %s on the head', async (_case, moved) => {
    const f = setup()
    f.github.repo.comments.set(4, [comment('Juno, 14:20, to **Pip**: READ-OK a1b2c3d')])
    const read = changed(['+    days = int(n)', '-    days = 1'])
    f.github.repo.compare.set('a1b2c3d', read)
    f.github.repo.compare.set(HEAD, { files: [{ ...read.files[0], patch: moved(read.files[0]!.patch) }] })
    await settle(f)
    expect(f.merges()).toEqual([])
  })

  // GitHub's compare does not say what kind of file it lists. A symbolic link's patch is its target as one line with no
  // newline at its end, and a submodule's is its commit: a regular file with that same text read as the same change.
  it.each([
    ['a symbolic link', '@@ -0,0 +1 @@\n+../../.env\n\\ No newline at end of file'],
    ['a symbolic link pointed elsewhere', '@@ -1 +1 @@\n-docs/a.md\n\\ No newline at end of file\n+../../.env\n\\ No newline at end of file'],
    ['a symbolic link removed', '@@ -1 +0,0 @@\n-../../.env\n\\ No newline at end of file'],
    // Its target may hold a newline: two lines, one mark of no newline at the end.
    ['a symbolic link to a name of two lines', '@@ -0,0 +1,2 @@\n+d\n+/../../.env\n\\ No newline at end of file'],
    ['a submodule', '@@ -1 +1 @@\n-Subproject commit 1111111111111111111111111111111111111111\n+Subproject commit 2222222222222222222222222222222222222222'],
  ])('takes no READ-OK on an earlier head for a file that may be %s: its kind is not told', async (_case, patch) => {
    const f = setup()
    f.github.repo.comments.set(4, [comment('Juno, 14:20, to **Pip**: READ-OK a1b2c3d')])
    const files = { files: [{ filename: 'docs/link', status: 'modified', changes: 1, patch }] }
    f.github.repo.compare.set('a1b2c3d', files)
    f.github.repo.compare.set(HEAD, files)
    await settle(f)
    expect(f.merges()).toEqual([])
  })

  it.each([
    ['its change differs', changed(['+    days = int(n) + 1', '-    days = 1'])],
    ['GitHub gives no patch for a file', { files: [{ filename: 'logo.png', status: 'modified', changes: 1 }] }],
    ['GitHub gives no answer for it', null],
  ])('takes no READ-OK on an earlier head when %s', async (_case, earlier) => {
    const f = setup()
    f.github.repo.comments.set(4, [comment('Juno, 14:20, to **Pip**: READ-OK a1b2c3d')])
    if (earlier) f.github.repo.compare.set('a1b2c3d', earlier as Json)
    f.github.repo.compare.set(HEAD, changed(['+    days = int(n)', '-    days = 1']))
    await settle(f)
    expect(f.merges()).toEqual([])
    // An earlier head GitHub does not know is no failure of the repository.
    expect(f.log.mock.calls.map(([line]) => String(line)).filter(line => line.includes('stopped'))).toEqual([])
  })

  // GitHub lists a changed binary with no patch and `changes: 0` (seen on rust-lang/rust's favicon PNGs): two heads that differed
  // only in a binary read as one change, so a READ-OK on the first counted for the second, which nobody had read.
  const binary = (blob: string, extra: Json = {}) => ({ files: [changed(['+    days = int(n)', '-    days = 1']).files[0],
    { filename: 'assets/logo.png', status: 'modified', changes: 0, additions: 0, deletions: 0, sha: blob, ...extra }] })
  it('takes no READ-OK on an earlier head whose binary file differs from the head\'s', async () => {
    const f = setup()
    f.github.repo.comments.set(4, [comment('Juno, 14:20, to **Pip**: READ-OK a1b2c3d')])
    f.github.repo.compare.set('a1b2c3d', binary('1111111111111111111111111111111111111111'))
    f.github.repo.compare.set(HEAD, binary('2222222222222222222222222222222222222222'))
    await settle(f)
    expect(f.merges()).toEqual([])
  })
  it('counts a READ-OK on an earlier head whose binary file is the head\'s own, and none when GitHub names no content for it', async () => {
    const same = setup()
    same.github.repo.comments.set(4, [comment('Juno, 14:20, to **Pip**: READ-OK a1b2c3d')])
    same.github.repo.compare.set('a1b2c3d', binary('1111111111111111111111111111111111111111'))
    same.github.repo.compare.set(HEAD, binary('1111111111111111111111111111111111111111'))
    await settle(same)
    expect(same.merges()).toHaveLength(1)
    // A mode change alone (chmod +x): GitHub names no blob for it (`sha: null`, seen on torvalds/linux), and a patch that is
    // there but empty names no content either.
    for (const extra of [{ sha: null }, { sha: undefined }, { patch: '' , sha: undefined }]) {
      const unnamed = setup()
      unnamed.github.repo.comments.set(4, [comment('Juno, 14:20, to **Pip**: READ-OK a1b2c3d')])
      unnamed.github.repo.compare.set('a1b2c3d', binary('', extra))
      unnamed.github.repo.compare.set(HEAD, binary('', extra))
      await settle(unnamed)
      expect(unnamed.merges(), JSON.stringify(extra)).toEqual([])
    }
  })

  it('still counts a READ-OK for a file with lines around its change that ends with no newline: no link\'s patch has any', async () => {
    const f = setup()
    f.github.repo.comments.set(4, [comment('Juno, 14:20, to **Pip**: READ-OK a1b2c3d')])
    const files = { files: [{ filename: 'docs/notes.md', status: 'modified', changes: 2, patch: '@@ -1,3 +1,3 @@\n one\n two\n-three\n\\ No newline at end of file\n+3\n\\ No newline at end of file' }] }
    f.github.repo.compare.set('a1b2c3d', files)
    f.github.repo.compare.set(HEAD, files)
    await settle(f)
    expect(f.merges()).toHaveLength(1)
  })

  it('never merges on its author\'s own READ-OK, however its two-word name is written', async () => {
    const f = setup()
    f.crew.mockResolvedValue({ builders: [{ id: 'pip-two', name: 'Pip Two', label: 'builder:pip-two', machineId: 'mac', engine: 'claude' }], machines: [] })
    f.github.repo.pulls = [pull({ labels: [{ name: 'builder:pip-two' }], head: { sha: HEAD, ref: 'pip-two/2' } })]
    f.github.repo.comments.set(4, [comment('Pip Two, 14:20, to **Juno**: READ-OK f6edb44')])
    await settle(f)
    expect(f.merges()).toEqual([])
  })

  // #3690 read a two-word name as its label does. A name the signature pattern cannot read (three words, another script, an apostrophe,
  // an emoji, odd spaces) fell back to the GitHub login, which every agent of a person shares, so its author's own READ-OK still counted
  // as someone else's and merged (Q3, 2026-11-10).
  const cp = (...points: number[]) => String.fromCodePoint(...points)
  it.each([
    ['Atlas Reed Two', 'builder:atlas-reed-two', 'Atlas Reed Two'],
    ['Đức Anh', 'builder:đức-anh', 'Đức Anh'],
    ['José', 'builder:josé', 'José'],
    ['小明', 'builder:小明', '小明'],
    ["O'Neil", "builder:o'neil", "O'Neil"],
    ['Pip Two', 'builder:pip-two', 'Pip  Two'],
    ['Pip Two', 'builder:pip-two', `Pip${cp(0xa0)}Two`],
    ['Pip Two', 'builder:pip-two', `Pip${cp(0x200b)} Two`],
    ['Pip Two', 'builder:pip-two', `${cp(0xff30)}ip ${cp(0xff34)}wo`],
    ['Pip Two', 'builder:pip-two', `**Pip Two** ${cp(0x1f41d)}`],
    // Hangul as typed in jamo (GitHub keeps a comment as typed), and a Greek name whose label has its final sigma.
    ['민수', 'builder:민수', '민수'.normalize('NFD')],
    ['ΖΕΥΣ', 'builder:ζευς', 'ΖΕΥΣ'],
  ])('never merges on its author\'s own READ-OK: %s, labelled %s, signing %j', async (name, label, signature) => {
    const f = setup()
    f.crew.mockResolvedValue({ builders: [{ id: 'writer', name, label, machineId: 'mac', engine: 'claude' }], machines: [] })
    f.github.repo.pulls = [pull({ labels: [{ name: label }], head: { sha: HEAD, ref: 'task/2' } })]
    f.github.repo.comments.set(4, [comment(`${signature}, 14:20, to **Juno**: READ-OK f6edb44`)])
    await settle(f)
    expect(f.merges()).toEqual([])
    // Another reader still merges it.
    f.github.repo.comments.set(4, [comment(`${signature}, 14:20, to **Juno**: READ-OK f6edb44`), comment('Juno, 14:21: READ-OK f6edb44')])
    await settle(f)
    expect(f.merges()).toHaveLength(1)
  })

  it('takes no READ-OK from the agent its branch names when its label names another, nor the other way round', async () => {
    const f = setup()
    f.crew.mockResolvedValue({ builders: [{ id: 'pip', name: 'Pip', label: 'builder:pip', machineId: 'mac', engine: 'claude' },
      { id: 'atlas', name: 'Atlas', label: 'builder:atlas', machineId: 'mac', engine: 'codex' }], machines: [] })
    f.github.repo.pulls = [pull({ labels: [{ name: 'builder:atlas' }], head: { sha: HEAD, ref: 'pip/2' } })]
    for (const writer of ['Pip', 'Atlas']) {
      f.github.repo.comments.set(4, [comment(`${writer}, 14:20: READ-OK f6edb44`)])
      await settle(f)
      expect(f.merges(), writer).toEqual([])
    }
  })

  // Every agent of a person posts as that person's GitHub login, the login that opened its pull request: an unsigned READ-OK from
  // it may be the author's own. Plan item 3 (review of #3708): a READ-OK typed by hand, from any login, is no read; one made by
  // command is its agent's.
  it('takes a READ-OK made by command from a teammate on the login that opened it, and no typed one from any login', async () => {
    // Words before the first comma or colon are a signature only when they name one of the team (its builders and PM): a verdict's
    // own words, or "LGTM", are no one, from the login that opened it.
    for (const [said, merges] of [[comment('READ-OK f6edb44'), 0], [comment('**READ-OK f6edb44**'), 0], [comment('READ-OK f6edb44', { user: { login: 'DeeHW' } }), 0],
      [comment('READ-OK f6edb44: looks good'), 0], [comment('READ-OK f6edb44, checks green'), 0], [comment('READ-OK f6edb44 (tests pass)'), 0],
      [comment('LGTM: READ-OK f6edb44'), 0],
      [comment('Juno, 14:20: READ-OK f6edb44'), 1], [comment('READ-OK f6edb44', { user: { login: 'kenmore' } }), 0],
      [comment('READ-OK f6edb44: looks good', { user: { login: 'kenmore' } }), 0], [comment('Juno, 14:20: READ-OK f6edb44', { typed: true }), 0]] as const) {
      const f = setup()
      f.github.repo.pulls = [pull({ user: { login: 'deehw' } })]
      f.github.repo.comments.set(4, [said])
      await settle(f)
      expect(f.merges(), String(said.body) + ' by ' + JSON.stringify(said.user)).toHaveLength(merges)
    }
    // A team agent whose name is its person's login signs as itself, and counts.
    const named = setup()
    named.github.repo.pulls = [pull({ user: { login: 'juno' } })]
    named.github.repo.comments.set(4, [comment('Juno, 14:20: READ-OK f6edb44', { user: { login: 'juno' } })])
    await settle(named)
    expect(named.merges()).toHaveLength(1)
  })

  it('says once on the pull request that a typed READ-OK from its own login does not count, so its reader makes it by command', async () => {
    const f = setup()
    f.github.repo.pulls = [pull({ user: { login: 'deehw' } })]
    f.github.repo.comments.set(4, [comment('READ-OK f6edb44', { created_at: '2026-11-09T07:00:00Z' })])
    await f.merger.tick()
    // A minute later, and the next: swarm-sandbox #24-#26 got it again every minute (46 times each, 2026-11-10), as its words
    // carried the time of day, so each was a new thing to say.
    f.clock.now += 60_000
    await f.merger.tick()
    f.clock.now += 60_000
    await f.merger.tick()
    expect(f.comments()).toEqual([expect.stringMatching(/not merged yet at f6edb44: the READ-OK from deehw is typed, and only a READ-OK made by command counts: its reader runs `harness super-tab read ok acme\/app#4 f6edb44`\.$/)])
  })

  // Review of #3708: a writer's own HOLD, which no reader is asked to lift (githubAssign.ts askReaders), stopped the merge and
  // nobody was told.
  it('says once on the pull request that its writer\'s own HOLD stands, in words that read as no verdict', async () => {
    const own = setup()
    own.github.repo.comments.set(4, [comment('Juno, 14:20: READ-OK f6edb44'), comment('Pip, 14:25: HOLD f6edb44 wait for the schema', { created_at: '2026-11-09T12:05:00Z' })])
    await settle(own)
    own.clock.now += 60_000
    await own.merger.tick()
    expect(own.merges()).toEqual([])
    expect(own.comments()).toEqual([expect.stringMatching(/^Harness, \d\d:\d\d, to \*\*pip\*\*: not merged yet at f6edb44: the HOLD from Pip on f6edb44 is a writer's own: another agent's READ-OK made by command on f6edb44 lifts it\.$/)])
    // Harness posts as the login that opened it, in a Swarm of one person: its note read back lifts nothing and reads nothing.
    own.github.repo.pulls = [pull({ user: { login: 'deehw' } })]
    own.github.repo.comments.set(4, [...own.github.repo.comments.get(4)!, comment(own.comments()[0]!, { author_association: 'OWNER', created_at: '2026-11-09T12:10:00Z' })])
    await settle(own)
    expect(own.merges()).toEqual([])
    // Its writer's READ-OK lifts nothing; another agent's, made by command after it, lifts it.
    own.github.repo.comments.set(4, [...own.github.repo.comments.get(4)!, comment('Pip, 14:40: READ-OK f6edb44', { created_at: '2026-11-09T12:20:00Z' })])
    await settle(own)
    expect(own.merges()).toEqual([])
    own.github.repo.comments.set(4, [...own.github.repo.comments.get(4)!, comment('Juno, 14:45: READ-OK f6edb44', { created_at: '2026-11-09T12:25:00Z' })])
    await settle(own)
    expect(own.merges()).toHaveLength(1)
    // A reader's HOLD beside it is the reader's to say: nothing is said that a writer's READ-OK would not answer.
    const both = setup()
    both.github.repo.comments.set(4, [comment('Pip, 14:25: HOLD f6edb44 wait for the schema'), comment('Kai, 14:26: HOLD f6edb44 off by one', { user: { login: 'kenmore' } })])
    await settle(both)
    expect(both.comments()).toEqual([])
  })

  // Review of #3708: "@Pip, HOLD ..." speaks to Pip and was read as signed by it, so Pip's own READ-OK lifted another's HOLD
  // and its pull request merged; "@Juno, READ-OK ..." from the login that opened it read as Juno's read.
  it('takes a line opening with "@Name," as said to that agent, not signed by it', async () => {
    const held = setup()
    held.github.repo.comments.set(4, [comment('Juno, 14:20: READ-OK f6edb44'),
      comment('@Pip, HOLD f6edb44: quotes.py:12 is off by one.', { user: { login: 'kenmore' }, created_at: '2026-11-09T12:05:00Z' }),
      comment('Pip, 14:30: READ-OK f6edb44', { created_at: '2026-11-09T12:30:00Z' })])
    await settle(held)
    expect(held.merges()).toEqual([])
    for (const line of ['@Juno, READ-OK f6edb44', '**@Juno**: READ-OK f6edb44', '＠Juno, READ-OK f6edb44', '﹫Juno: READ-OK f6edb44']) {
      const f = setup()
      f.github.repo.pulls = [pull({ user: { login: 'deehw' } })]
      f.github.repo.comments.set(4, [comment(line)])
      await settle(f)
      expect(f.merges(), line).toEqual([])
    }
  })

  // Review of #3708, gap 1: a task taken over has a writer posting from another login, whose unsigned READ-OK read as that login's
  // read; and a writer types a teammate's name from its own login. Plan item 3: a READ-OK typed by hand is no read.
  it('merges on no typed READ-OK: a writer\'s from another login, nor one typed in a teammate\'s name', async () => {
    const f = setup()
    f.crew.mockResolvedValue({ builders: [{ id: 'pip', name: 'Pip', label: 'builder:pip', machineId: 'mac', engine: 'claude' },
      { id: 'atlas', name: 'Atlas', label: 'builder:atlas', machineId: 'box', engine: 'codex' }], machines: [] })
    f.github.repo.pulls = [pull({ labels: [{ name: 'builder:atlas' }], head: { sha: HEAD, ref: 'pip/2' }, user: { login: 'deehw' } })]
    f.github.repo.comments.set(4, [comment('READ-OK f6edb44', { user: { login: 'kenmore' } })])
    await settle(f)
    expect(f.merges()).toEqual([])
    const typed = setup()
    typed.github.repo.pulls = [pull({ user: { login: 'deehw' } })]
    typed.github.repo.comments.set(4, [comment('Juno, 14:20: READ-OK f6edb44', { typed: true })])
    await settle(typed)
    expect(typed.merges()).toEqual([])
  })

  // Review of #3708, gap 3 without an @: a reader's "**Pip**: HOLD" reads as signed by Pip, its writer, and Pip's own READ-OK
  // lifted it. A HOLD of the pull request's own side is lifted only by another agent's READ-OK made by command.
  it('lets no writer lift a HOLD that reads as its own, and lifts it with another agent\'s READ-OK made by command', async () => {
    const f = setup()
    f.github.repo.comments.set(4, [comment('Juno, 14:00: READ-OK f6edb44', { created_at: '2026-11-09T07:00:00Z' }),
      comment('**Pip**: HOLD f6edb44 quotes.py:12 is off by one.', { user: { login: 'kenmore' }, created_at: '2026-11-09T07:05:00Z' }),
      comment('Pip, 14:30: READ-OK f6edb44', { created_at: '2026-11-09T07:10:00Z' })])
    await settle(f)
    expect(f.merges()).toEqual([])
    f.github.repo.comments.set(4, [...f.github.repo.comments.get(4)!, comment('Juno, 14:40: READ-OK f6edb44', { created_at: '2026-11-09T07:20:00Z' })])
    await settle(f)
    expect(f.merges()).toHaveLength(1)
  })

  // Review of #3708, gap 4: an unsigned HOLD from the login that opened it was lifted by that login's unsigned READ-OK, which its
  // writer posts as.
  it('lifts an unsigned HOLD from the login that opened it only by another agent\'s READ-OK made by command, and says so', async () => {
    const f = setup()
    f.github.repo.pulls = [pull({ user: { login: 'deehw' } })]
    f.github.repo.comments.set(4, [comment('Juno, 14:00: READ-OK f6edb44', { created_at: '2026-11-09T07:00:00Z' }),
      comment('HOLD 1234567: off by one', { created_at: '2026-11-09T07:05:00Z' }), comment('READ-OK f6edb44', { created_at: '2026-11-09T07:10:00Z' })])
    await settle(f)
    expect(f.merges()).toEqual([])
    expect(f.comments()).toEqual([expect.stringMatching(/to \*\*pip\*\*: not merged yet at f6edb44: the HOLD from deehw on 1234567 is unsigned, from the login that opened it: another agent's READ-OK made by command on f6edb44 lifts it\.$/)])
    f.github.repo.comments.set(4, [...f.github.repo.comments.get(4)!, comment('Juno, 14:40: READ-OK f6edb44', { created_at: '2026-11-09T07:20:00Z' })])
    await settle(f)
    expect(f.merges()).toHaveLength(1)
  })

  // A person has no command to run: a login takes back its own unsigned HOLD by typing, never another's, nor the opener's login.
  it('lets a login lift its own unsigned HOLD by typing, and no other', async () => {
    const f = setup()
    f.github.repo.pulls = [pull({ user: { login: 'deehw' } })]
    f.github.repo.comments.set(4, [comment('Juno, 14:00: READ-OK f6edb44', { created_at: '2026-11-09T07:00:00Z' }),
      comment('HOLD f6edb44 not yet', { user: { login: 'alice' }, created_at: '2026-11-09T07:05:00Z' }),
      comment('READ-OK f6edb44', { user: { login: 'kenmore' }, created_at: '2026-11-09T07:10:00Z' })])
    await settle(f)
    expect(f.merges()).toEqual([])
    f.github.repo.comments.set(4, [...f.github.repo.comments.get(4)!, comment('READ-OK f6edb44 fine now', { user: { login: 'alice' }, created_at: '2026-11-09T07:15:00Z' })])
    await settle(f)
    expect(f.merges()).toHaveLength(1)
  })

  // Review of #3708, gap 6: a verdict of one kind replaced another's, so a login that reads as a reader's name lifted its HOLD in
  // two steps (a HOLD, then a READ-OK), and a teammate's READ-OK was lost under its own login's typed one.
  it('lifts no reader\'s HOLD by a login that reads as its name, and loses no READ-OK made by command to a typed one', async () => {
    const f = setup()
    f.github.repo.comments.set(4, [comment('Juno, 14:00: READ-OK f6edb44', { created_at: '2026-11-09T07:00:00Z' }),
      comment('Kai Lee, 14:10: HOLD f6edb44 fix the test', { user: { login: 'kenmore' }, created_at: '2026-11-09T07:05:00Z' }),
      comment('HOLD f6edb44', { user: { login: 'kai-lee' }, created_at: '2026-11-09T07:10:00Z' }),
      comment('READ-OK f6edb44', { user: { login: 'kai-lee' }, created_at: '2026-11-09T07:15:00Z' })])
    await settle(f)
    expect(f.merges()).toEqual([])
    const named = setup()
    named.github.repo.pulls = [pull({ user: { login: 'juno' } })]
    named.github.repo.comments.set(4, [comment('Juno, 14:20: READ-OK f6edb44', { user: { login: 'juno' }, created_at: '2026-11-09T07:00:00Z' }),
      comment('READ-OK f6edb44', { user: { login: 'juno' }, created_at: '2026-11-09T07:10:00Z' })])
    await settle(named)
    expect(named.merges()).toHaveLength(1)
  })

  // lampOS #5212 (4 Nov): El posted its reads as reviews, and four pull requests each counted one read short. A review's body reads
  // exactly as a comment's, in time order with them; its state is never a read (markers.py merge_reviews, lib.sh coord_pr_comments).
  // A READ-OK made by command is a comment (githubVerdict.ts): one posted as a review was typed, and is no read (plan item 3).
  it('reads a review\'s body as a comment: a READ-OK posted as one is typed and merges nothing, and a HOLD posted as one stops the merge', async () => {
    const review = (body: string, state: string, at = '2026-11-09T12:10:00Z', extra: Json = {}) =>
      ({ id: 7, body, state, submitted_at: at, author_association: 'MEMBER', user: { login: 'deehw' }, ...extra })
    const read = setup()
    read.github.repo.comments.set(4, [])
    read.github.repo.reviews.set(4, [review('Juno, 14:20, to **Pip**: READ-OK f6edb44', 'APPROVED')])
    await settle(read)
    expect(read.merges()).toEqual([])
    const held = setup()
    held.github.repo.reviews.set(4, [review('Kai, 14:30: HOLD f6edb44: the day count is off by one.', 'CHANGES_REQUESTED', '2026-11-09T12:30:00Z')])
    await settle(held)
    expect(held.merges()).toEqual([])
    // A review with no words, one not submitted and one dismissed say nothing; its state alone is no read.
    const none = setup()
    none.github.repo.comments.set(4, [])
    none.github.repo.reviews.set(4, [review('', 'APPROVED'), review('Juno, 14:20: READ-OK f6edb44', 'PENDING', ''),
      review('Juno, 14:20: READ-OK f6edb44', 'DISMISSED')])
    await settle(none)
    expect(none.merges()).toEqual([])
  })

  // A verdict is its comment's own: one talked about is none (lampOS markers.py, each from a pull request held or merged wrongly).
  it.each([
    // #3371: "your HOLD `889b694ea` asked for" held its PR under the replier's name.
    ['a verdict named as someone\'s', 'Pip, 12:31, to **Juno**: fixed your HOLD f6edb44, see the new head.', 1],
    ['a possessive\'s', 'Kai, 14:30: the Reviewer-lead\'s HOLD f6edb44 was on this head.', 1],
    // #5068: an author's "> READ-OK <head>" reply counted as a second read.
    ['a quoted line', '> Kai, 14:10: HOLD f6edb44: off by one', 1],
    // #3608: "(HOLD 3e741c220)", the HOLD a reply answers.
    ['one in brackets', 'Kai, 14:30, to Juno (HOLD f6edb44): new head coming.', 1],
    // #3781: "your 19:34 comment opens with `HOLD 73aa8b23f`".
    ['one in backticks', 'Kai, 14:30: your comment opens with `HOLD f6edb44`, so it holds.', 1],
    ['an opening code fence', '```HOLD f6edb44', 1],
    // swarm-sandbox #24: an ask's example, "as in "Juno, HH:MM: READ-OK 239a631"", read as a READ-OK.
    ['one inside quotation marks', 'Kai, 14:30: please read again, and start with "Juno, HH:MM: HOLD f6edb44" if it is wrong.', 1],
  ])('reads no HOLD in %s', async (_case, line, merges) => {
    const f = setup()
    f.github.repo.comments.set(4, [comment('Juno, 14:20, to **Pip**: READ-OK f6edb44'), comment(line, { created_at: '2026-11-09T12:30:00Z' })])
    await settle(f)
    expect(f.merges()).toHaveLength(merges)
  })

  it('takes no READ-OK from an example inside quotation marks, and takes one in bold, with backticks or naming its pull request', async () => {
    const example = setup()
    example.github.repo.comments.set(4, [comment('Kai, 14:30: start with "Kai, HH:MM: READ-OK f6edb44" once you have read it.', { user: { login: 'kenmore' } })])
    await settle(example)
    expect(example.merges()).toEqual([])
    for (const line of ['Juno, 14:20: **READ-OK** `f6edb44`', 'Juno, 14:20: READ-OK #4 f6edb44', 'Juno, 14:20: **READ-OK f6edb44**']) {
      const f = setup()
      f.github.repo.comments.set(4, [comment(line, { user: { login: 'kenmore' } })])
      await settle(f)
      expect(f.merges(), line).toHaveLength(1)
    }
  })

  // A reader is one however it writes its name: a HOLD as "Kai Lee" stood for good after its READ-OK as "kai-lee".
  it('lets a reader\'s later READ-OK lift its own HOLD however it writes its name', async () => {
    const f = setup()
    f.github.repo.comments.set(4, [comment('Kai Lee, 14:10: HOLD f6edb44 fix the test'),
      comment('kai-lee, 14:30: READ-OK f6edb44', { created_at: '2026-11-09T12:30:00Z' })])
    await settle(f)
    expect(f.merges()).toHaveLength(1)
  })

  it('never lets a signed READ-OK lift an unsigned HOLD of a login whose name reads the same, nor the other way round', async () => {
    const f = setup()
    f.github.repo.comments.set(4, [comment('HOLD f6edb44 the test fails', { user: { login: 'kai-lee' } }),
      comment('Kai Lee, 14:30: READ-OK f6edb44', { user: { login: 'kenmore' }, created_at: '2026-11-09T12:30:00Z' })])
    await settle(f)
    expect(f.merges()).toEqual([])
  })

  it('knows a team agent posting as the opener\'s login however it writes its name, so its own READ-OK lifts its own HOLD', async () => {
    const f = setup()
    f.crew.mockResolvedValue({ builders: [{ id: 'pip', name: 'Pip', label: 'builder:pip', machineId: 'mac', engine: 'claude' },
      { id: 'kai', name: 'Kai Lee', label: 'builder:kai-lee', machineId: 'mac', engine: 'codex' }], machines: [] })
    f.github.repo.pulls = [pull({ user: { login: 'deehw' } })]
    f.github.repo.comments.set(4, [comment('Kai Lee, 14:10: HOLD f6edb44 fix the test'), comment('KaiLee, 14:30: READ-OK f6edb44', { created_at: '2026-11-09T12:30:00Z' })])
    await settle(f)
    expect(f.merges()).toHaveLength(1)
  })

  it('counts a reader who signs its name two ways once for TWO READS', async () => {
    const f = setup()
    f.github.repo.pulls = [pull({ body: 'Closes #2\n\nTWO READS: it changes the default voice.' })]
    f.github.repo.comments.set(4, [comment('Kai Lee, 14:20: READ-OK f6edb44'), comment('kai-lee, 14:22: READ-OK f6edb44')])
    await settle(f)
    expect(f.merges()).toEqual([])
    f.github.repo.comments.set(4, [comment('Kai Lee, 14:20: READ-OK f6edb44'), comment('Juno, 14:22: READ-OK f6edb44')])
    await settle(f)
    expect(f.merges()).toHaveLength(1)
  })

  it('merges the team\'s pull request wherever it is among a busy repository\'s hundred and more', async () => {
    const f = setup()
    const people = Array.from({ length: 119 }, (_, i) => pull({ number: 100 + i, labels: [], head: { sha: HEAD, ref: `fix-${i}` } }))
    f.github.repo.pulls = [...people.slice(0, 110), pull(), ...people.slice(110)]
    await settle(f)
    expect(f.merges()).toEqual([{ method: 'PUT', path: '/repos/acme/app/pulls/4/merge', body: { merge_method: 'squash', sha: HEAD } }])
  })

  it('reads the team only when a pull request is open', async () => {
    const f = setup()
    f.github.repo.pulls = [pull({ draft: true })]
    await f.merger.tick()
    expect(f.crew).not.toHaveBeenCalled()
    f.github.repo.pulls = [pull()]
    await f.merger.tick()
    expect(f.crew).toHaveBeenCalledTimes(1)
  })

  it('merges only the team\'s own pull requests: a person\'s, or a branch no builder of the team made, is theirs to merge', async () => {
    for (const other of [{ head: { sha: HEAD, ref: 'ken/fix-login' }, labels: [] }, { head: { sha: HEAD, ref: 'fix-login' }, labels: [] }]) {
      const f = setup()
      f.github.repo.pulls = [pull(other)]
      await settle(f)
      expect(f.merges()).toEqual([])
    }
  })

  it('merges nothing on a READ-OK of an older head, by its author, by a stranger, or while a HOLD stands', async () => {
    for (const said of [[comment('Juno, 14:20, to **Pip**: READ-OK a1b2c3d')], [comment('Pip, 14:21: READ-OK f6edb44')],
      [comment('READ-OK f6edb44', { author_association: 'NONE', user: { login: 'stranger' } })],
      [comment('Juno, 14:20: READ-OK f6edb44'), comment('Kai, 14:25: HOLD f6edb44 quotes.py:12 off by one', { created_at: '2026-11-09T12:05:00Z' })]]) {
      const f = setup()
      f.github.repo.comments.set(4, said)
      await settle(f)
      expect(f.merges()).toEqual([])
    }
  })

  it('lifts a HOLD with the same reader\'s later READ-OK, and asks two readers for TWO READS', async () => {
    const f = setup()
    f.github.repo.comments.set(4, [comment('Kai, 14:10: HOLD a1b2c3d fix the test'), comment('Kai, 14:30: READ-OK f6edb44', { created_at: '2026-11-09T12:30:00Z' })])
    await settle(f)
    expect(f.merges()).toHaveLength(1)
    const two = setup()
    two.github.repo.pulls = [pull({ body: 'Closes #2\n\nTWO READS: it changes the default voice.' })]
    await settle(two)
    expect(two.merges()).toEqual([])
    two.github.repo.comments.set(4, [comment('Juno, 14:20: READ-OK f6edb44'), comment('Kai, 14:22: READ-OK f6edb44')])
    await settle(two)
    expect(two.merges()).toHaveLength(1)
  })

  it('leaves drafts and pull requests into other branches alone, and waits for running checks', async () => {
    const f = setup()
    f.github.repo.pulls = [pull({ draft: true }), pull({ number: 5, base: { ref: 'release' } })]
    await settle(f)
    const running = setup()
    running.github.repo.runs.set(HEAD, [{ name: 'test', status: 'in_progress', conclusion: null }])
    await settle(running)
    expect([...f.merges(), ...running.merges(), ...running.comments()]).toEqual([])
  })

  it('tells the author by name once for each head when its checks failed, it is behind, or it conflicts', async () => {
    const f = setup()
    f.github.repo.runs.set(HEAD, [{ name: 'test (ubuntu)', status: 'completed', conclusion: 'failure' }])
    await f.merger.tick()
    await f.merger.tick()
    expect(f.comments()).toEqual([expect.stringMatching(/^Harness, \d\d:\d\d, to \*\*pip\*\*: not merged yet at f6edb44: checks failed: test \(ubuntu\)\. Fix them and push\.$/)])
    // A restart (each release is one) finds it on the pull request, and says it no more.
    f.github.repo.comments.set(4, [...f.github.repo.comments.get(4) ?? [], comment(f.comments()[0]!, { author_association: 'OWNER' })])
    const restarted = setup()
    restarted.github.repo.runs.set(HEAD, [{ name: 'test (ubuntu)', status: 'completed', conclusion: 'failure' }])
    restarted.github.repo.comments.set(4, f.github.repo.comments.get(4)!)
    await restarted.merger.tick()
    expect(restarted.comments()).toEqual([])
    for (const [state, words] of [['behind', 'it is behind main'], ['dirty', 'it conflicts with main'], ['blocked', 'GitHub\'s rules for main block the merge']]) {
      const g = setup()
      g.github.repo.state = state
      await settle(g)
      expect(g.merges()).toEqual([])
      expect(g.comments()).toEqual([expect.stringContaining(words)])
    }
  })

  it('reads a refused merge again next pass and says nothing on the pull request', async () => {
    const f = setup()
    f.github.repo.mergeAnswer = 409
    await settle(f)
    expect(f.comments()).toEqual([])
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('MERGE_REFUSED acme/app#4: GitHub answered 409'))
    f.github.repo.mergeAnswer = 200
    f.clock.now += 30_000
    await f.merger.tick()
    expect(f.merges()).toHaveLength(2)
  })

  it('waits longer after each pass GitHub did not answer, 30 seconds to 15 minutes, and a refused login 5 minutes, and says so once', async () => {
    const down = setup()
    const told = [] as number[]
    down.github.repo.down = true
    for (let seconds = 30; seconds <= 1_900; seconds += 30) {
      down.clock.now = Date.parse('2026-11-09T07:31:00Z') + seconds * 1000
      const before = down.log.mock.calls.length
      await down.merger.tick()
      if (down.log.mock.calls.length > before) told.push(seconds)
    }
    // A line each time its wait changes: 30 s, 1 min, 2, 4, 8, 15, and then the same 15 min, said once.
    expect(told).toEqual([30, 60, 120, 240, 480, 960])
    const out = setup()
    out.github.repo.status = 401
    await out.merger.tick()
    expect(out.log).toHaveBeenCalledWith(expect.stringContaining('GH_SIGNED_OUT'))
    out.github.repo.status = 0
    out.clock.now += 4 * 60_000
    await out.merger.tick()
    expect(out.merges()).toEqual([])
    out.clock.now += 61_000
    await out.merger.tick()
    expect(out.log).toHaveBeenLastCalledWith('[super-tab] merging by rule runs again')
    // Its first pass since sees the head first: three minutes on, it merges.
    out.clock.now += 3 * 60_000
    await out.merger.tick()
    expect(out.merges()).toHaveLength(1)
  })

  it('says a repository it cannot read once, for as long as it cannot, and not that it runs again meanwhile', async () => {
    const f = setup()
    f.github.repo.status = 404
    for (let i = 0; i < 5; i++) { f.clock.now += 30_000; await f.merger.tick() }
    expect(f.log.mock.calls.map(([line]) => String(line))).toEqual([expect.stringContaining('UNREADABLE acme/app')])
  })

  it('tells the author again when its pass failed before the comment went', async () => {
    const f = setup()
    f.github.repo.state = 'behind'
    f.github.repo.sendFails = 1
    // The head settles first (CHECKS_SETTLE_MS); then the pass that would say it is behind fails before its comment goes.
    await f.merger.tick()
    f.clock.now += 3 * 60_000
    await f.merger.tick()
    expect(f.comments()).toEqual([])
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('MERGE_FAILED acme/app'))
    f.clock.now += 30_000
    await f.merger.tick()
    expect(f.comments()).toEqual([expect.stringContaining('it is behind main')])
    f.clock.now += 30_000
    await f.merger.tick()
    expect(f.comments()).toHaveLength(1)
  })

  it('stops while gh is signed out and says so once', async () => {
    const f = setup()
    f.github.repo.signedOut = true
    await f.merger.tick()
    await f.merger.tick()
    expect(f.log).toHaveBeenCalledTimes(1)
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('GH_SIGNED_OUT'))
  })
})

// The allocator's design, package 3: a task that comes after another is given to be built on that one's branch, so a pull
// request built on another's is routine. One is held while it holds the other's head as it is now (above); that alone let a
// held change land through the pull request built on it.
describe('a pull request lands after the one its task comes after', () => {
  const GREEN = [{ name: 'test', status: 'completed', conclusion: 'success' }]
  type Fixture = ReturnType<typeof setup>
  /** #5 is for task #2, and a reader's HOLD stands on it. #6 is for task #3, whose text says it comes after #2; it is read OK
   *  and green, and holds [commits]: #5's head under its own, unless the test says other. */
  function stack(f: Fixture, commits: Json[] = [{ sha: UNDER }, { sha: HEAD }]): void {
    f.github.repo.issues.set(3, { number: 3, body: 'Show the day beside the quote.\n\nafter #2' })
    f.github.repo.pulls = [pull({ number: 5, head: { sha: UNDER } }), pull({ number: 6, body: 'Closes #3', head: { sha: HEAD, ref: 'pip/3' } })]
    f.github.repo.commits.set(6, commits)
    f.github.repo.runs.set(UNDER, GREEN)
    f.github.repo.comments = new Map([[5, [comment('Kai, 14:10: HOLD b0b0b0b quotes.py:12 is off by one.')]], [6, [comment('Juno, 14:20, to **Pip**: READ-OK f6edb44')]]])
  }
  const landed = (number: number) => ({ method: 'PUT', path: `/repos/acme/app/pulls/${number}/merge`, body: expect.objectContaining({ merge_method: 'squash' }) })
  const stopped = (f: Fixture) => f.log.mock.calls.map(([line]) => String(line)).filter(line => line.includes('stopped'))
  /** The reads of a task's issue that were asked, in order. */
  const taskReads = (f: Fixture) => f.github.asked.filter(path => /\/issues\/\d+(?: \(with an ETag\))?$/.test(path)).map(path => path.slice('/repos/acme/app'.length))
  const AFTER = /^Harness, \d\d:\d\d, to \*\*pip\*\*: not merged yet at f6edb44: it lands after #5, which is open for #2: its own task #3 comes after that one\.$/

  // The hole. #6 was built on #5 at one head; a reader held #5 there, and its builder fixed it with a push and did not touch #6.
  // #6 then held #5's earlier commits and not its head, so nothing was found, and the held code landed through #6 before its fix.
  it('lands none built on another\'s earlier head while that one is open: a held change does not land through it before its fix', async () => {
    const f = setup()
    stack(f)
    // It holds #5's head: told once that it lands after #5.
    await settle(f)
    expect(f.merges()).toEqual([])
    expect(f.comments()).toHaveLength(1)
    // The fix is pushed to #5 alone.
    f.github.repo.pulls = [pull({ number: 5, head: { sha: FIXED } }), f.github.repo.pulls[1]!]
    for (let pass = 0; pass < 2; pass++) { f.clock.now += 30_000; await f.merger.tick() }
    expect(f.merges()).toEqual([])
    // Nothing more is said: it was told for this head that it lands after #5.
    expect(f.comments()).toHaveLength(1)
    // #5 has landed, or was closed: #6 lands as it is.
    f.github.repo.pulls = [f.github.repo.pulls[1]!]
    f.clock.now += 30_000
    await f.merger.tick()
    expect(f.merges()).toEqual([landed(6)])
  })

  it('tells its builder once for its head which pull request it lands after and for which task, and no more, and not again after a restart', async () => {
    const f = setup()
    // Built on main alone: it holds none of #5's commits.
    stack(f, [{ sha: HEAD }])
    await settle(f)
    f.clock.now += 30_000
    await f.merger.tick()
    expect(f.merges()).toEqual([])
    expect(f.comments()).toEqual([expect.stringMatching(AFTER)])
    // A restart (each release is one) finds the note on the pull request.
    const restarted = setup()
    stack(restarted, [{ sha: HEAD }])
    restarted.github.repo.comments.get(6)!.push(comment(f.comments()[0]!, { author_association: 'OWNER' }))
    await settle(restarted)
    expect([...restarted.merges(), ...restarted.comments()]).toEqual([])
  })

  // A pull request told before 2026-11-12 has the note in the words of then, which began otherwise and asked for an update.
  it.each<[string, Json[]]>([['it holds the other\'s head', [{ sha: UNDER }, { sha: HEAD }]], ['its task comes after the other\'s', [{ sha: HEAD }]]])(
    'says nothing again, after a restart, to one told in the note\'s earlier words: %s', async (_case, commits) => {
      const f = setup()
      stack(f, commits)
      f.github.repo.comments.get(6)!.push(comment('Harness, 14:20, to **pip**: not merged yet at f6edb44: it carries open #5\'s commits (its head b0b0b0b), so merging it would '
        + 'merge them too. It waits until #5 merges; then update it from main.', { author_association: 'OWNER' }))
      await settle(f)
      expect([...f.merges(), ...f.comments()]).toEqual([])
    })

  it.each<[string, (f: Fixture) => void]>([
    ['the other pull request is no longer open', f => { f.github.repo.pulls = [f.github.repo.pulls[1]!] }],
    // Its PM took the line out, or the task never had words: nothing says what it comes after.
    ['its task\'s text is gone', f => { f.github.repo.issues.set(3, { number: 3, body: null }) }],
    // Two pull requests for a task that names itself would each wait for the other.
    ['its task names itself', f => {
      f.github.repo.issues.set(3, { number: 3, body: 'after #3' })
      f.github.repo.pulls.push(pull({ number: 7, draft: true, body: 'Closes #3', head: { sha: FIXED, ref: 'pip/3-again' } }))
    }],
    ['it names no task', f => { f.github.repo.pulls[1] = pull({ number: 6, body: 'Tidy.', head: { sha: HEAD, ref: 'pip/tidy' } }) }],
    ['it is itself the pull request for both tasks', f => { f.github.repo.pulls = [pull({ number: 6, body: 'Closes #2\nCloses #3', head: { sha: HEAD, ref: 'pip/3' } })] }],
    // GitHub answers for a pull request's number as for an issue's: its text is no task's.
    ['the number it names is a pull request\'s', f => {
      f.github.repo.issues.set(5, { number: 5, pull_request: {}, body: 'after #2' })
      f.github.repo.pulls[1] = pull({ number: 6, body: 'Closes #5', head: { sha: HEAD, ref: 'pip/tidy' } })
    }],
    // Anything from outside is data: on a public repository anyone opens a pull request that says it closes #2, and every
    // change of the team's whose task comes after #2 would stop landing. Only a pull request of the team's is waited for.
    ['the other pull request is by nobody of the team', f => { f.github.repo.pulls[0] = pull({ number: 5, labels: [], head: { sha: UNDER, ref: 'fix-quotes' } }) }],
    ['the other is a fork\'s, by nobody of the team', f => { f.github.repo.pulls[0] = pull({ number: 5, labels: [], head: { sha: UNDER, ref: 'fix-quotes', repo: { full_name: 'kai/app' } } }) }],
    // Anyone can name a fork's branch like a builder's: GitHub's own word that its author is a member is asked too (review of #4121).
    ['the other is a fork\'s on a branch named like a builder\'s, by nobody of the team', f => {
      f.github.repo.pulls[0] = pull({ number: 5, labels: [], author_association: 'CONTRIBUTOR', head: { sha: UNDER, ref: 'pip/2', repo: { full_name: 'kai/app' } } })
    }],
  ])('lands it all the same when %s', async (_case, arrange) => {
    const f = setup()
    stack(f, [{ sha: HEAD }])
    arrange(f)
    await settle(f)
    expect(f.merges()).toEqual([landed(6)])
    expect(f.comments()).toEqual([expect.stringContaining(': merged.')])
  })

  // A draft of the team's is work that will be read and land. And a fork's own pull request waits as any other.
  it.each<[string, (f: Fixture) => void]>([
    ['the other is a draft of the team\'s', f => { f.github.repo.pulls[0] = pull({ number: 5, draft: true, head: { sha: UNDER } }) }],
    ['the other is a fork\'s, of the team\'s', f => { f.github.repo.pulls[0] = pull({ number: 5, head: { sha: UNDER, repo: { full_name: 'pip/app' } } }) }],
    ['it is itself a fork\'s', f => { f.github.repo.pulls[1] = pull({ number: 6, body: 'Closes #3', head: { sha: HEAD, ref: 'pip/3', repo: { full_name: 'pip/app' } } }) }],
  ])('lands it after the other all the same when %s', async (_case, arrange) => {
    const f = setup()
    stack(f, [{ sha: HEAD }])
    arrange(f)
    await settle(f)
    // Neither merged on its own nor built into a train.
    expect(f.github.sent.map(s => `${s.method} ${s.path}`)).toEqual(['POST /repos/acme/app/issues/6/comments'])
    expect(f.comments()).toEqual([expect.stringMatching(AFTER)])
    expect(stopped(f)).toEqual([])
  })

  // No order lands both, and neither lands on a guess: each is told which it waits for. The lines are their PM's to change.
  it('lands neither of two whose tasks each say they come after the other, and tells each which it waits for', async () => {
    const f = setup()
    stack(f, [{ sha: HEAD }])
    f.github.repo.issues.set(2, { number: 2, body: 'after #3' })
    f.github.repo.comments.set(5, [comment('Juno, 14:20, to **Pip**: READ-OK b0b0b0b')])
    f.github.repo.commits.set(5, [{ sha: UNDER }])
    await settle(f)
    expect(f.merges()).toEqual([])
    expect(f.comments()).toEqual([expect.stringMatching(/not merged yet at b0b0b0b: it lands after #6, which is open for #3: its own task #2 comes after that one\.$/), expect.stringMatching(AFTER)])
  })

  // A number that is no issue's is no task: a branch named `pip/2026`, or a "Closes" with a number nothing has. GitHub answers
  // 404 (410 for an issue that was deleted), which is its answer and no failure: nothing says what such a pull request comes
  // after, and it lands as it did before this rule. Held for it, a branch named so never landed.
  it.each([404, 410])('lands as before a pull request whose task\'s number is no issue\'s (GitHub answers %i), and reads its other tasks all the same', async status => {
    const f = setup()
    stack(f, [{ sha: HEAD }])
    f.github.repo.pulls[1] = pull({ number: 6, body: 'Tidy.', head: { sha: HEAD, ref: 'pip/2026' } })
    f.github.repo.refused.set(2026, status)
    await settle(f)
    expect(f.merges()).toEqual([landed(6)])
    expect(f.comments()).toEqual([expect.stringContaining(': merged.')])
    expect(stopped(f)).toEqual([])
    // One that names such a number and a task too still lands after what the task comes after.
    const both = setup()
    stack(both, [{ sha: HEAD }])
    both.github.repo.pulls[1] = pull({ number: 6, body: 'Closes #2026\nCloses #3', head: { sha: HEAD, ref: 'pip/tidy' } })
    both.github.repo.refused.set(2026, status)
    await settle(both)
    expect(both.merges()).toEqual([])
    expect(both.comments()).toEqual([expect.stringMatching(AFTER)])
  })

  // A read GitHub refuses (403) or fails (500) is no word on the task. It is a failed read as any other of the pass: the
  // repository's pass stops and waits, nothing lands on a guess meanwhile, and nothing is said on the pull request.
  it.each([403, 500])('stops the repository\'s pass, as at every read, when GitHub answers %i for its task', async status => {
    const f = setup()
    stack(f, [{ sha: HEAD }])
    f.github.repo.refused.set(3, status)
    await settle(f)
    expect(f.github.sent).toEqual([])
    expect(stopped(f)).toHaveLength(1)
  })

  // On the merger's pass, every 30 seconds. An unchanged task is a 304, which GitHub does not count against this login.
  it('reads a task only for a pull request that could merge now, once for each task it names, five at most, with its last answer\'s ETag', async () => {
    const f = setup()
    stack(f, [{ sha: HEAD }])
    await f.merger.tick()
    // Its checks have not held still yet: nothing of its task is asked.
    expect(taskReads(f)).toEqual([])
    f.clock.now += 3 * 60_000
    await f.merger.tick()
    f.clock.now += 30_000
    await f.merger.tick()
    expect(taskReads(f)).toEqual(['/issues/3', '/issues/3 (with an ETag)'])
    // One that names seven tasks: its first five are read.
    const many = setup()
    for (let task = 11; task <= 17; task++) many.github.repo.issues.set(task, { number: task, body: '' })
    many.github.repo.pulls = [pull({ body: [11, 12, 13, 14, 15, 16, 17].map(task => `Closes #${task}`).join('\n'), head: { sha: HEAD, ref: 'pip/tidy' } })]
    await settle(many)
    expect(taskReads(many)).toEqual(['/issues/11', '/issues/12', '/issues/13', '/issues/14', '/issues/15'])
    expect(many.merges()).toHaveLength(1)
    // And one that names none asks for nothing.
    const none = setup()
    none.github.repo.pulls = [pull({ body: 'Tidy.', head: { sha: HEAD, ref: 'pip/tidy' } })]
    await settle(none)
    expect(taskReads(none)).toEqual([])
    expect(none.merges()).toHaveLength(1)
  })
})

describe('the rule\'s parts', () => {
  it('reads each reader\'s last verdict by the name it signs with, or its login unsigned, and TWO READS', () => {
    const { readers, twoReads } = verdicts([comment('Juno, 14:20, to **Pip**: READ-OK f6edb44'), comment('**Faye** (PM): HOLD 1234567 wait'),
      comment('READ-OK abcdef0', { user: { login: 'kenmore' } }), comment('Harness, 14:31: merged. READ-OK on f6edb44 by juno, checks green.'),
      comment('Kai, 14:00: TWO READS for this one')], '', { writers: [], opener: '', team: new Set() })
    const at = '2026-11-09T12:00:00Z'
    expect(Object.fromEntries(readers)).toEqual({ juno: { verdict: 'READ-OK', sha: 'f6edb44', name: 'Juno', ownLogin: false, recorded: false, byCommand: false, retyped: false, at },
      faye: { verdict: 'HOLD', sha: '1234567', name: 'Faye', ownLogin: false, recorded: false, byCommand: false, retyped: false, at },
      kenmore: { verdict: 'READ-OK', sha: 'abcdef0', name: 'kenmore', ownLogin: false, recorded: false, byCommand: false, retyped: false, at } })
    expect(twoReads).toBe(true)
  })

  // The day's scoreboard counts verdicts by their time and the merger's notes by their kind (scoreboard.ts).
  it('says the verdict a comment gives as its own, and which of the merger\'s notes one is, whatever its head', () => {
    const said = (body: string, association = 'MEMBER') => ({ body, author_association: association })
    expect(verdictOf(said(`Kai, 14:20: READ-OK ${HEAD}\n\nReads well.`))).toBe('READ-OK')
    expect(verdictOf(said(`\n\nKai, 14:20: HOLD ${HEAD.slice(0, 7)} src/a.ts:3`))).toBe('HOLD')
    expect(verdictOf(said(`> READ-OK ${HEAD}`))).toBeNull()
    expect(verdictOf(said('Looks fine to me.'))).toBeNull()
    expect(verdictOf(said(`Kai, 14:20: READ-OK ${HEAD}`, 'NONE'))).toBeNull()
    expect(verdictOf({})).toBeNull()
    const note = (words: string) => said(`Harness, 14:20, to **Pip**: not merged yet at ${HEAD.slice(0, 7)}: ${words}`)
    expect(noteOf(note('it is behind main: update the branch and push.'))).toBe('behind')
    expect(noteOf(note('it conflicts with main: rebase it on main and push.'))).toBe('dirty')
    expect(noteOf(note('checks failed: unit. Fix them and push.'))).toBe('checks')
    // One that lands after another was told neither that it is behind nor that it conflicts: in today's words, and in those of
    // before 2026-11-12, which are on pull requests still.
    expect(noteOf(note('it lands after #5, whose commits it carries (its head b0b0b0b).'))).toBe('stacked')
    expect(noteOf(note('it lands after #5, which is open for #2: its own task #3 comes after that one.'))).toBe('stacked')
    expect(noteOf(note('it carries open #5\'s commits (its head b0b0b0b), so merging it would merge them too. It waits until #5 merges; then update it from main.'))).toBe('stacked')
    expect(noteOf(note('something the merger never says'))).toBeNull()
    expect(noteOf(said('Harness, 14:20: merged.'))).toBeNull()
    expect(noteOf({})).toBeNull()
    expect(noteOf(said(`Harness, 14:20, to **Pip**: not merged yet at ${HEAD.slice(0, 7)}: it is behind main`, 'CONTRIBUTOR'))).toBeNull()
    // Past the first 500 characters, where none of Harness's own notes is, it is someone's talk.
    expect(noteOf(said(`${'x'.repeat(500)} not merged yet at ${HEAD.slice(0, 7)}: it is behind main`))).toBeNull()
  })

  it('knows a pull request\'s author by its builder label, else its branch', () => {
    expect(authorOf(pull())).toBe('pip')
    expect(authorOf(pull({ labels: [], head: { sha: HEAD, ref: 'Juno/7' } }))).toBe('juno')
    expect(authorOf(pull({ labels: [], head: { sha: HEAD, ref: 'fix-tests' } }))).toBeNull()
  })

  // Code review of #4060: a roster row holds its agent (row.agent); a PM looked up by the wrong id was never asked to read.
  it('finds the PM of a project running here by the agent of its roster row, and that agent\'s harness id', () => {
    const project = { repo: 'acme/app', pm: 'Juno', tabId: 'tab', pmAgentId: 'juno', projectId: 'app' }
    const roster = [{ agent: { id: 'pip', harnessId: 'h-pip' } }, { agent: { id: 'juno', harnessId: 'h-juno' } }]
    expect(pmRunsHere(roster, project, id => id === 'h-juno')).toBe(true)
    expect(pmRunsHere(roster, project, id => id === 'h-pip')).toBe(false)
    expect(pmRunsHere([{ agent: { id: 'juno' } }], project, () => true)).toBe(false)
    expect(pmRunsHere([], project, () => true)).toBe(false)
  })

  it('passes checks only when every run and status passed, and none at all passes', () => {
    expect(checksOf([], {}).state).toBe('passed')
    expect(checksOf([{ status: 'completed', conclusion: 'skipped' }], { statuses: [{ state: 'success' }] }).state).toBe('passed')
    expect(checksOf([{ status: 'queued' }], {}).state).toBe('running')
    // GitHub lists each check's latest run, so two of one name are two checks (two workflows' jobs): either failing fails the
    // head, and a failed name is said once (#4055 listed ci/required twice).
    expect(checksOf([{ id: 2, name: 'test', status: 'completed', conclusion: 'success' }, { id: 1, name: 'test', status: 'completed', conclusion: 'failure' }], {}).state)
      .toBe('failed')
    expect(checksOf([{ id: 1, name: 'ci/required', status: 'completed', conclusion: 'failure' }, { id: 2, name: 'ci/required', status: 'completed', conclusion: 'failure' }], {}).failed)
      .toEqual(['ci/required'])
    expect(checksOf([{ id: 1, name: 'ci/required', status: 'completed', conclusion: 'failure' }], { statuses: [{ state: 'failure', context: 'ci/required' }] }).failed)
      .toEqual(['ci/required'])
    expect(checksOf([{ name: 'lint', status: 'completed', conclusion: 'failure' }], { statuses: [{ state: 'error', context: 'ci/required' }] }))
      .toEqual({ state: 'failed', failed: ['lint', 'ci/required'], summary: 'ci/required:error|lint:completed:failure' })
    // What was read, in any order GitHub lists it, as one line: two looks that read the same are the same.
    expect(checksOf([{ name: 'b', status: 'completed', conclusion: 'success' }, { name: 'a', status: 'completed', conclusion: 'success' }], {}).summary)
      .toBe(checksOf([{ name: 'a', status: 'completed', conclusion: 'success' }, { name: 'b', status: 'completed', conclusion: 'success' }], {}).summary)
  })

  it('merges only for projects whose PM is this person\'s agent running here, on a GitHub repository', async () => {
    const row = (agent: Json, extra: Json = {}) => ({ tabId: 'tab', lead: true, ledConversationId: 'lead', agent: { id: 'juno', harnessId: 'h-juno',
      name: 'Juno', contributorId: 'dee', machineOwnerId: 'dee', ...agent }, ...extra })
    const read = async () => ({ projects: [{ id: 'app', leadConversationId: 'lead', repository: { repositoryUrl: 'git@github.com:acme/app.git' } }] })
    const found = await ledProjects({ me: 'dee', live: id => id === 'h-juno', read, roster: async () => [row({}), row({ id: 'ken', contributorId: 'ken' }),
      row({ id: 'pip' }, { lead: false }), row({ id: 'gone', harnessId: 'h-gone' })] })
    expect(found).toEqual([{ repo: 'acme/app', pm: 'Juno', tabId: 'tab', pmAgentId: 'juno', projectId: 'app' }])
  })

  it('counts a PM stopped here as leading, as the service asks the core whether it is stopped', async () => {
    const row = { tabId: 'tab', lead: true, ledConversationId: 'lead', agent: { id: 'juno', harnessId: 'h-juno', name: 'Juno', contributorId: 'dee',
      machineOwnerId: 'dee' } }
    const read = async () => ({ projects: [{ id: 'app', leadConversationId: 'lead', repository: { repositoryUrl: 'https://github.com/acme/app' } }] })
    expect(await ledProjects({ me: 'dee', live: async () => true, read, roster: async () => [row] })).toHaveLength(1)
    expect(await ledProjects({ me: 'dee', live: async () => false, read, roster: async () => [row] })).toEqual([])
  })
})

// A verdict made by command (githubVerdict.ts) is recorded with the backend as its agent's. The merger counts that agent, not
// the name the comment opens with: the signature reads one or two plain words, so "Đức Anh" or "Atlas Reed Two" on the login
// that opened the pull request read as unsigned and counted for nothing (review of #3902).
describe('the merger counts the agent the backend recorded for a verdict', () => {
  function recordedSetup(names: Record<string, string>) {
    const github = fakeGitHub()
    // Pip builds and Đức Anh reads; Juno is the PM.
    const crew: Crew = { builders: [{ id: 'pip', name: 'Pip', label: 'builder:pip', machineId: 'mac', engine: 'claude' },
      { id: 'anh', name: 'Đức Anh', label: 'builder:đức-anh', machineId: 'mac', engine: 'codex' }], machines: [] }
    const clock = { now: Date.parse('2026-11-09T07:31:00Z') }
    const authors = vi.fn(async (_project: { repo: string }, ids: string[]) => Object.fromEntries(ids.filter(id => names[id]).map(id => [id, { name: names[id]! }])))
    const log = vi.fn()
    const merger = new GitHubMerge({ projects: async () => [{ repo: 'acme/app', pm: 'Juno', tabId: 'tab', pmAgentId: 'juno', projectId: 'app' }],
      crew: async () => crew, get: github.get, send: github.send, now: () => clock.now, log, records: new VerdictRecords(authors, () => clock.now, log), costs: async () => [] })
    return { github, merger, clock, authors, log, merges: () => github.sent.filter(s => s.method === 'PUT'),
      comments: () => github.sent.filter(s => s.method === 'POST').map(s => String((s.body as Json).body)) }
  }
  const from = (id: number, body: string, at = '2026-11-09T07:00:00Z'): Json => ({ id, body, author_association: 'MEMBER', user: { login: 'deehw' }, created_at: at })

  it('takes a recorded verdict as its agent\'s, however the comment signs, from the login that opened the pull request too', async () => {
    const f = recordedSetup({ 'issue:501': 'Đức Anh' })
    f.github.repo.pulls = [pull({ user: { login: 'deehw' } })]
    f.github.repo.comments.set(4, [from(501, `Đức Anh, 14:20: READ-OK ${HEAD}`)])
    await settle(f)
    expect(f.merges()).toHaveLength(1)
    expect(f.comments()).toEqual([expect.stringMatching(/merged\. READ-OK on f6edb44 by Đức Anh, checks green\.$/)])
    expect(f.authors).toHaveBeenCalledWith(expect.objectContaining({ repo: 'acme/app', tabId: 'tab' }), ['issue:501'])
  })

  it('counts the recorded agent over the name typed: its own writer\'s verdict is none, whoever it says it is', async () => {
    const f = recordedSetup({ 'issue:502': 'Pip' })
    f.github.repo.pulls = [pull({ user: { login: 'deehw' } })]
    f.github.repo.comments.set(4, [from(502, `Juno, 14:20: READ-OK ${HEAD}`)])
    await settle(f)
    expect(f.merges()).toEqual([])
  })

  // Review of #3906.
  it('lets only a recorded READ-OK lift a recorded HOLD: the same name typed by hand does not', async () => {
    const f = recordedSetup({ 'issue:601': 'Juno', 'issue:603': 'Juno' })
    f.github.repo.pulls = [pull({ user: { login: 'deehw' } })]
    f.github.repo.comments.set(4, [from(601, `Juno, 14:20: HOLD ${HEAD}\n\na.ts:1 fix it`), from(602, `Juno, 14:25: READ-OK ${HEAD}`, '2026-11-09T07:05:00Z')])
    await settle(f)
    expect(f.merges()).toEqual([])
    f.github.repo.comments.set(4, [...f.github.repo.comments.get(4)!, from(603, `Juno, 14:30: READ-OK ${HEAD}`, '2026-11-09T07:10:00Z')])
    f.clock.now += 60_000
    await settle(f)
    expect(f.merges()).toHaveLength(1)
  })

  it('takes a comment changed since it was written as typed by hand: its record was of other words', async () => {
    const f = recordedSetup({ 'issue:801': 'Đức Anh' })
    f.github.repo.pulls = [pull({ user: { login: 'deehw' } })]
    f.github.repo.comments.set(4, [{ ...from(801, `Đức Anh, 14:20: READ-OK ${HEAD}`), updated_at: '2026-11-09T07:20:00Z' }])
    await settle(f)
    expect(f.merges()).toEqual([])
  })

  it('counts a recorded reader from the login that opened the pull request only when it is one of the team', async () => {
    const f = recordedSetup({ 'issue:950': 'Bud' })
    f.github.repo.pulls = [pull({ user: { login: 'deehw' } })]
    f.github.repo.comments.set(4, [from(950, `Bud, 14:20: READ-OK ${HEAD}`)])
    await settle(f)
    expect(f.merges()).toEqual([])
  })

  it('asks again for a comment it had no record of, so a record made late is read, and does not say unsigned before the record can be there', async () => {
    const names: Record<string, string> = {}
    const f = recordedSetup(names)
    f.github.repo.pulls = [pull({ user: { login: 'deehw' } })]
    // Written two seconds ago: its record may not be made yet, so nothing is said of it.
    f.github.repo.comments.set(4, [from(701, `Juno Reed Two, 14:20: READ-OK ${HEAD}`, new Date(f.clock.now - 2_000).toISOString())])
    await f.merger.tick()
    expect(f.comments()).toEqual([])
    // No record after two minutes: typed by hand, and said so.
    f.clock.now += 3 * 60_000
    await f.merger.tick()
    expect(f.comments()).toEqual([expect.stringContaining('is typed')])
    // The reader ran the command again and the record was made: read within ten minutes, with no restart.
    names['issue:701'] = 'Juno'
    f.clock.now += 11 * 60_000
    await settle(f)
    expect(f.merges()).toHaveLength(1)
  })

  it('leaves a backend that does not answer alone for a while, and names the repository when it says so', async () => {
    const f = recordedSetup({})
    f.authors.mockRejectedValue(new Error('Could not reach this Super Tab.'))
    f.github.repo.comments.set(4, [from(504, `Juno, 14:20: READ-OK ${HEAD}`)])
    for (let pass = 0; pass < 4; pass++) { await f.merger.tick(); f.clock.now += 5_000 }
    expect(f.authors).toHaveBeenCalledTimes(1)
    expect(f.log.mock.calls.map(call => String(call[0])).filter(line => line.includes('AUTHORS_UNREAD'))).toEqual([
      '[super-tab] verdicts\' records cannot be read: nothing merges and no reader is asked · AUTHORS_UNREAD acme/app: Could not reach this Super Tab.'])
    f.clock.now += 60_000
    await f.merger.tick()
    expect(f.authors).toHaveBeenCalledTimes(2)
  })

  it('asks the backend once for a comment it knows, and reads names as typed while the backend cannot be asked, saying so once', async () => {
    const f = recordedSetup({ 'issue:501': 'Đức Anh' })
    f.github.repo.pulls = [pull({ user: { login: 'deehw' } })]
    f.github.repo.comments.set(4, [from(501, `Đức Anh, 14:20: READ-OK ${HEAD}`), from(503, 'Thanks, rebased.')])
    await f.merger.tick()
    f.clock.now += 60_000
    await f.merger.tick()
    // Only a comment that gives a verdict is asked about, and one answered is not asked about again.
    expect(f.authors.mock.calls.map(call => call[1])).toEqual([['issue:501']])
    const down = recordedSetup({})
    down.authors.mockRejectedValue(new Error('Could not reach this Super Tab.'))
    down.github.repo.comments.set(4, [from(504, `Juno, 14:20: READ-OK ${HEAD}`)])
    await settle(down)
    // Only a READ-OK made by command is a read: while records cannot be read, nothing merges.
    expect(down.merges()).toEqual([])
    expect(down.log.mock.calls.filter(call => String(call[0]).includes('AUTHORS_UNREAD'))).toHaveLength(1)
  })
})

describe('who the backend recorded for a project\'s comments', () => {
  it('asks as the project\'s PM, for the repository and the ids in the backend\'s form, and reads each name', async () => {
    const ask = vi.fn(async (_path: string) => ({ authors: { 'issue:501': { agentId: 'a1', name: 'Đức Anh' }, 'issue:502': { agentId: 'a2' } } }))
    const authors = await recordedAuthors(ask)({ repo: 'acme/app', pm: 'Juno', tabId: 'tab', pmAgentId: 'juno', projectId: 'app' }, ['issue:501', 'issue:502', 'issue:503'])
    expect(ask).toHaveBeenCalledExactlyOnceWith('/api/super-tabs/tab/github-comments?repository=acme%2Fapp&ids=issue%3A501,issue%3A502,issue%3A503&asAgentId=juno')
    expect(authors).toEqual({ 'issue:501': { name: 'Đức Anh' }, 'issue:502': { name: '' } })
    expect(await recordedAuthors(async () => null)({ repo: 'acme/app', pm: 'Juno', tabId: 'tab', pmAgentId: 'juno', projectId: 'app' }, ['issue:1'])).toEqual({})
  })
})
