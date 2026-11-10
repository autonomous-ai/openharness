import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { authorOf, checksOf, GitHubMerge, ledProjects, verdicts } from './githubMerge.js'
import type { Crew } from './assign/crew.js'
import type { GitHubGet, GitHubSend } from './githubRest.js'

type Json = Record<string, unknown>
const HEAD = 'f6edb44c0ffee0000000000000000000000000ab'
const OLD = 'a1b2c3d4e5f60000000000000000000000000000'
const comment = (body: string, extra: Json = {}): Json => ({ body, author_association: 'MEMBER', user: { login: 'deehw' }, created_at: '2026-11-09T12:00:00Z', ...extra })
const pull = (extra: Json = {}): Json => ({ number: 4, draft: false, base: { ref: 'main' }, head: { sha: HEAD, ref: 'pip/2' }, labels: [{ name: 'builder:pip' }],
  body: 'Closes #2', ...extra })

/** One repository as GitHub's REST API answers for it, with ETags, and what was sent to it. */
function fakeGitHub() {
  const repo = { pulls: [pull()], comments: new Map<number, Json[]>([[4, [comment('Juno, 14:20, to **Pip**: READ-OK f6edb44')]]]), reviews: new Map<number, Json[]>(), commits: new Map<number, Json[]>(), compare: new Map<string, Json>(),
    runs: new Map<string, Json[]>([[HEAD, [{ name: 'test', status: 'completed', conclusion: 'success' }]]]), statuses: new Map<string, Json[]>(),
    state: 'clean', mergeAnswer: 200, signedOut: false, down: false, status: 0, sendFails: 0 }
  const sent: Array<{ method: string; path: string; body: unknown }> = []
  const get: GitHubGet = async (path, etag) => {
    if (repo.signedOut) throw Object.assign(new Error('gh is not signed in on this computer: run `gh auth login`.'), { code: 'GH_SIGNED_OUT' })
    if (repo.down) throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })
    if (repo.status) return { status: repo.status, etag: null, body: null, resetAt: null }
    const url = new URL(`https://api.github.com${path}`)
    const p = url.pathname
    const body = p === '/repos/acme/app' ? { default_branch: 'main' }
      // A page of the list, as GitHub pages it.
      : p === '/repos/acme/app/pulls' ? repo.pulls.slice((Number(url.searchParams.get('page') ?? 1) - 1) * Number(url.searchParams.get('per_page') ?? 30),
        Number(url.searchParams.get('page') ?? 1) * Number(url.searchParams.get('per_page') ?? 30))
      : /\/issues\/\d+\/comments$/.test(p) ? repo.comments.get(Number(p.split('/').at(-2))) ?? []
      : /\/pulls\/\d+\/reviews$/.test(p) ? repo.reviews.get(Number(p.split('/').at(-2))) ?? []
      : /\/pulls\/\d+\/commits$/.test(p) ? repo.commits.get(Number(p.split('/').at(-2))) ?? [{ sha: HEAD }]
      : /\/compare\/main\.\.\.[0-9a-f]+$/.test(p) ? repo.compare.get(p.split('...').at(-1)!) ?? null
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
  return { repo, sent, get, send }
}

function setup() {
  const github = fakeGitHub()
  const log = vi.fn()
  // Pip builds; Juno is the PM.
  const crew: Crew = { builders: [{ id: 'pip', name: 'Pip', label: 'builder:pip', machineId: 'mac', engine: 'claude' }], machines: [] }
  const team = vi.fn(async () => crew)
  const clock = { now: Date.parse('2026-11-09T07:31:00Z') }
  const merger = new GitHubMerge({ projects: async () => [{ repo: 'acme/app', pm: 'Juno', tabId: 'tab', pmAgentId: 'juno', projectId: 'app' }],
    crew: team, get: github.get, send: github.send, now: () => clock.now, log })
  const merges = () => github.sent.filter(s => s.method === 'PUT')
  const comments = () => github.sent.filter(s => s.method === 'POST').map(s => String((s.body as Json).body))
  return { github, merger, log, merges, comments, clock, crew: team }
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
  // one's commits would merge them with it, unread or held. It waits until that one merges, told once.
  it('merges no pull request that carries another open one\'s commits, and tells its author once', async () => {
    const UNDER = 'b0b0b0b0c0ffee000000000000000000000000ab'
    const f = setup()
    f.github.repo.pulls = [pull(), pull({ number: 5, draft: true, labels: [], head: { sha: UNDER, ref: 'ken/base' }, user: { login: 'kenmore' } })]
    f.github.repo.commits.set(4, [{ sha: UNDER }, { sha: HEAD }])
    await settle(f)
    f.clock.now += 30_000
    await f.merger.tick()
    expect(f.merges()).toEqual([])
    expect(f.comments()).toEqual([expect.stringMatching(/^Harness, \d\d:\d\d, to \*\*pip\*\*: not merged yet at f6edb44: it carries open #5's commits \(its head b0b0b0b\), so merging it would merge them too\. It waits until #5 merges; then update it from main\.$/)])
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
  it('counts a READ-OK on an earlier head whose change is the same as the head\'s, as lampOS\'s patch_of reads it', async () => {
    const f = setup()
    f.github.repo.comments.set(4, [comment('Juno, 14:20, to **Pip**: READ-OK a1b2c3d')])
    // Main moved under it: the same lines, now further down, in other context.
    f.github.repo.compare.set('a1b2c3d', changed(['+    days = int(n)', '-    days = 1']))
    f.github.repo.compare.set(HEAD, { files: [{ ...changed(['+    days = int(n)', '-    days = 1'], 9).files[0], patch: changed(['+    days = int(n)', '-    days = 1'], 9).files[0]!.patch.replace('today = date.today()', 'today = clock.today()') }] })
    await settle(f)
    expect(f.merges()).toHaveLength(1)
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
  // it may be the author's own, so it never counts, and a reader on that login signs. Another login's unsigned READ-OK is that
  // person's (the lead's decision, 2026-11-10).
  it('takes no unsigned READ-OK from the login that opened the pull request, a signed one from a teammate on it, and another login\'s', async () => {
    // Words before the first comma or colon are a signature only when they name one of the team (its builders and PM): a verdict's
    // own words, or "LGTM", are no one, from the login that opened it.
    for (const [said, merges] of [[comment('READ-OK f6edb44'), 0], [comment('**READ-OK f6edb44**'), 0], [comment('READ-OK f6edb44', { user: { login: 'DeeHW' } }), 0],
      [comment('READ-OK f6edb44: looks good'), 0], [comment('READ-OK f6edb44, checks green'), 0], [comment('READ-OK f6edb44 (tests pass)'), 0],
      [comment('LGTM: READ-OK f6edb44'), 0],
      [comment('Juno, 14:20: READ-OK f6edb44'), 1], [comment('READ-OK f6edb44', { user: { login: 'kenmore' } }), 1],
      [comment('READ-OK f6edb44: looks good', { user: { login: 'kenmore' } }), 1]] as const) {
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

  it('says once on the pull request that an unsigned READ-OK from its own login does not count, so its reader signs it', async () => {
    const f = setup()
    f.github.repo.pulls = [pull({ user: { login: 'deehw' } })]
    f.github.repo.comments.set(4, [comment('READ-OK f6edb44')])
    await f.merger.tick()
    // A minute later, and the next: swarm-sandbox #24-#26 got it again every minute (46 times each, 2026-11-10), as its words
    // carried the time of day, so each was a new thing to say.
    f.clock.now += 60_000
    await f.merger.tick()
    f.clock.now += 60_000
    await f.merger.tick()
    expect(f.comments()).toEqual([expect.stringMatching(/not merged yet at f6edb44: the READ-OK from deehw is unsigned, and every agent of its person posts as that login: its reader signs it, as in "<name>, HH:MM: READ-OK f6edb44"\.$/)])
  })

  // lampOS #5212 (4 Nov): El posted its reads as reviews, and four pull requests each counted one read short. A review's body reads
  // exactly as a comment's, in time order with them; its state is never a read (markers.py merge_reviews, lib.sh coord_pr_comments).
  it('reads a review\'s body as a comment: a READ-OK posted as a review merges, and a HOLD posted as one stops the merge', async () => {
    const review = (body: string, state: string, at = '2026-11-09T12:10:00Z', extra: Json = {}) =>
      ({ id: 7, body, state, submitted_at: at, author_association: 'MEMBER', user: { login: 'deehw' }, ...extra })
    const read = setup()
    read.github.repo.comments.set(4, [])
    read.github.repo.reviews.set(4, [review('Juno, 14:20, to **Pip**: READ-OK f6edb44', 'APPROVED')])
    await settle(read)
    expect(read.merges()).toHaveLength(1)
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
    for (const line of ['**READ-OK** `f6edb44`', 'Juno, 14:20: READ-OK #4 f6edb44', 'Juno, 14:20: **READ-OK f6edb44**']) {
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

describe('the rule\'s parts', () => {
  it('reads each reader\'s last verdict by the name it signs with, or its login unsigned, and TWO READS', () => {
    const { readers, twoReads } = verdicts([comment('Juno, 14:20, to **Pip**: READ-OK f6edb44'), comment('**Faye** (PM): HOLD 1234567 wait'),
      comment('READ-OK abcdef0', { user: { login: 'kenmore' } }), comment('Harness, 14:31: merged. READ-OK on f6edb44 by juno, checks green.'),
      comment('Kai, 14:00: TWO READS for this one')], '', { writers: [], opener: '', team: new Set() })
    expect(Object.fromEntries(readers)).toEqual({ juno: { verdict: 'READ-OK', sha: 'f6edb44', name: 'Juno', ownLogin: false },
      faye: { verdict: 'HOLD', sha: '1234567', name: 'Faye', ownLogin: false }, kenmore: { verdict: 'READ-OK', sha: 'abcdef0', name: 'kenmore', ownLogin: false } })
    expect(twoReads).toBe(true)
  })

  it('knows a pull request\'s author by its builder label, else its branch', () => {
    expect(authorOf(pull())).toBe('pip')
    expect(authorOf(pull({ labels: [], head: { sha: HEAD, ref: 'Juno/7' } }))).toBe('juno')
    expect(authorOf(pull({ labels: [], head: { sha: HEAD, ref: 'fix-tests' } }))).toBeNull()
  })

  it('passes checks only when every run and status passed, and none at all passes', () => {
    expect(checksOf([], {}).state).toBe('passed')
    expect(checksOf([{ status: 'completed', conclusion: 'skipped' }], { statuses: [{ state: 'success' }] }).state).toBe('passed')
    expect(checksOf([{ status: 'queued' }], {}).state).toBe('running')
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
