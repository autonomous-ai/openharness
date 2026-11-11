import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { GitHubMerge } from './githubMerge.js'
import { landingMessage, nextTrain, splitRed, trainBody, trainOfBody } from './githubTrain.js'
import type { Crew } from './assign/crew.js'
import type { GitHubGet, GitHubReply, GitHubSend } from './githubRest.js'

type Json = Record<string, unknown>
const sha = (seed: string): string => createHash('sha1').update(seed).digest('hex')
const PASSED = [{ name: 'test', status: 'completed', conclusion: 'success' }]
const FAILED = [{ name: 'test', status: 'completed', conclusion: 'failure' }]
const RUNNING = [{ name: 'test', status: 'in_progress', conclusion: null }]
const REPO = '/repos/acme/app'

interface FakePull { number: number; state: 'open' | 'closed'; draft: boolean; title: string; body: string; created_at: string; updated: number; merged_at: string | null
  merge_commit_sha: string | null; head: { sha: string; ref: string; repo: { full_name: string } }; base: { ref: string }; labels: Array<{ name: string }>
  mergeable_state: string; user: { login: string } }

/**
 * One repository in memory, as GitHub's REST API answers for it and takes writes to it: main as a line of commits, each with the
 * files it changed; pull requests; train branches built by the merges API; check runs by commit. Nothing here reaches
 * github.com. Commits are made-up SHAs; a merge of a pull request moves main.
 */
function fakeRepo(now: () => number) {
  const state = {
    main: [{ sha: sha('main-0'), files: [] as string[] }],
    pulls: new Map<number, FakePull>(),
    comments: new Map<number, Json[]>(),
    runs: new Map<string, Json[]>(),
    /** What each pull request's head and each train commit holds: the commit of main it stands on, and the files it changes. */
    commits: new Map<string, { on: string; files: string[] }>(),
    /** A train commit's parents: what it was merged onto, and the member's head. */
    parents: new Map<string, string[]>(),
    branches: new Map<string, string>(),
    /** Heads that conflict when merged into a train, heads GitHub does not take into one, and heads main holds already. */
    conflicts: new Set<string>(),
    untaken: new Set<string>(),
    untakenAnswer: 404,
    inMain: new Set<string>(),
    settings: {} as Json,
    /** Answers a write in GitHub's place, which then changes nothing: a test refuses a call here. */
    answer: null as ((method: string, path: string) => Partial<GitHubReply> | undefined) | null,
    /** Whether GitHub has marked as merged the pull requests whose commits a merge commit brought into main: it does so by
     *  itself, a moment after the merge. A test holds it back here. */
    marks: true,
    /** Runs before each merge into a train's branch: a test pushes onto the branch here. */
    beforeMerge: null as ((branch: string) => void) | null,
    sent: [] as Array<{ method: string; path: string; body: Json }>,
    /** Every read asked, its query too. */
    asked: [] as string[],
    next: 900,
    edits: 0,
  }
  const tip = () => state.main.at(-1)!.sha
  const iso = () => new Date(now()).toISOString()
  /** As GitHub does: every open pull request whose head main now holds, by a merge commit's second parents, is merged. */
  const mark = () => {
    if (!state.marks) return
    const held = new Set<string>()
    for (const commit of state.main) for (let at = state.parents.get(commit.sha)?.[1]; at; at = state.parents.get(at)?.[0]) { held.add(at); const second = state.parents.get(at)?.[1]; if (second) held.add(second) }
    for (const pull of state.pulls.values()) if (pull.state === 'open' && held.has(pull.head.sha)) Object.assign(pull, { state: 'closed', merged_at: iso(), merge_commit_sha: pull.head.sha, updated: ++state.edits })
  }
  const compare = (from: string, to: string): Json | null => {
    if (from === 'main') {
      const commit = state.commits.get(to)
      if (!commit) return null
      return { behind_by: state.main.length - 1 - state.main.findIndex(c => c.sha === commit.on), merge_base_commit: { sha: commit.on },
        files: commit.files.map(filename => ({ filename, status: 'modified', changes: 1, patch: `+${filename}` })) }
    }
    const at = state.main.findIndex(c => c.sha === from)
    return to === 'main' && at >= 0 ? { behind_by: 0, files: state.main.slice(at + 1).flatMap(c => c.files).map(filename => ({ filename })) } : null
  }
  const get: GitHubGet = async (path, etag) => {
    const url = new URL(`https://api.github.com${path}`), p = url.pathname.slice(REPO.length), number = Number(/^\/(?:issues|pulls)\/(\d+)/.exec(p)?.[1])
    const commit = /^\/commits\/([0-9a-f]+)\//.exec(p)?.[1] ?? '', compared = /^\/compare\/(.+)\.\.\.(.+)$/.exec(p)
    const per = Number(url.searchParams.get('per_page') ?? 30), page = Number(url.searchParams.get('page') ?? 1)
    state.asked.push(path.slice(REPO.length))
    // This computer's gh login, which opens the trains.
    if (path === '/user') return { status: 200, etag: null, body: { login: 'Octocat' }, resetAt: null }
    const made = /^\/git\/commits\/([0-9a-f]+)$/.exec(p)?.[1]
    const body = p === '' ? { default_branch: 'main', ...state.settings }
      // A page of the list, the most recently updated first, as GitHub pages it.
      : p === '/pulls' ? [...state.pulls.values()].filter(pull => pull.state === url.searchParams.get('state')).sort((a, b) => b.updated - a.updated).slice((page - 1) * per, page * per)
      : /^\/issues\/\d+\/comments$/.test(p) ? state.comments.get(number) ?? []
      : /^\/pulls\/\d+\/reviews$/.test(p) ? []
      : /^\/pulls\/\d+\/commits$/.test(p) ? [{ sha: state.pulls.get(number)?.head.sha }]
      : /^\/pulls\/\d+$/.test(p) ? { mergeable_state: state.pulls.get(number)?.mergeable_state }
      : p.endsWith('/check-runs') ? { check_runs: state.runs.get(commit) ?? [] }
      : p.endsWith('/status') ? { statuses: [] }
      : compared ? compare(compared[1]!, compared[2]!)
      : made ? (state.parents.has(made) ? { sha: made, parents: state.parents.get(made)!.map(parent => ({ sha: parent })) } : null)
      : p === '/git/ref/heads/main' ? { ref: 'refs/heads/main', object: { type: 'commit', sha: tip() } }
      // Every branch whose name starts so, as GitHub matches.
      : p === '/git/matching-refs/heads/harness-train' ? [...state.branches].filter(([name]) => name.startsWith('harness-train')).map(([name, at]) => ({ ref: `refs/heads/${name}`, object: { sha: at } }))
      : null
    if (body === null) return { status: 404, etag: null, body: null, resetAt: null }
    const tag = `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`
    return etag === tag ? { status: 304, etag: tag, body: null, resetAt: null } : { status: 200, etag: tag, body: structuredClone(body), resetAt: null }
  }
  const send: GitHubSend = async (method, path, sentBody) => {
    const p = path.slice(REPO.length), body = (sentBody ?? {}) as Json, number = Number(/^\/(?:issues|pulls)\/(\d+)/.exec(p)?.[1]), pull = state.pulls.get(number)
    state.sent.push({ method, path: p, body })
    const reply = (status: number, answered: unknown = {}): GitHubReply => ({ status, etag: null, body: answered, resetAt: null })
    const instead = state.answer?.(method, p)
    if (instead) return { ...reply(instead.status ?? 200, instead.body ?? null), ...instead }
    if (method === 'POST' && p === '/git/refs') {
      state.branches.set(String(body.ref).replace('refs/heads/', ''), String(body.sha))
      return reply(201)
    }
    if (method === 'POST' && p === '/merges') {
      const branch = String(body.base), head = String(body.head)
      state.beforeMerge?.(branch)
      const before = state.branches.get(branch)
      if (!before || !state.commits.has(head)) return reply(404)
      if (state.untaken.has(head)) return reply(state.untakenAnswer)
      if (state.conflicts.has(head)) return reply(409)
      if (state.inMain.has(head)) return reply(204, null)
      const merged = sha(`${before}+${head}`), under = state.commits.get(before)
      state.commits.set(merged, { on: under?.on ?? before, files: [...under?.files ?? [], ...state.commits.get(head)!.files] })
      state.branches.set(branch, merged)
      state.parents.set(merged, [before, head])
      return reply(201, { sha: merged, parents: [{ sha: before }, { sha: head }] })
    }
    if (method === 'POST' && p === '/pulls') {
      const opened: FakePull = { number: state.next++, state: 'open', draft: false, title: String(body.title), body: String(body.body), created_at: iso(), updated: ++state.edits,
        merged_at: null, merge_commit_sha: null, head: { sha: state.branches.get(String(body.head))!, ref: String(body.head), repo: { full_name: 'acme/app' } },
        base: { ref: String(body.base) }, labels: [], mergeable_state: 'clean', user: { login: 'octocat' } }
      state.pulls.set(opened.number, opened)
      // CI starts on the new pull request.
      state.runs.set(opened.head.sha, RUNNING)
      return reply(201, structuredClone(opened))
    }
    if (method === 'PUT' && /^\/pulls\/\d+\/merge$/.test(p)) {
      const allowed = state.settings[`allow_${body.merge_method === 'merge' ? 'merge_commit' : `${String(body.merge_method)}_merge`}`] !== false
      if (!pull || pull.state !== 'open' || !allowed) return reply(405)
      if (body.sha !== pull.head.sha) return reply(409)
      const landed = sha(`${tip()}#${number}`)
      // A merge commit keeps the branch's commits under it; a squash is one commit on main's tip.
      state.parents.set(landed, body.merge_method === 'merge' ? [tip(), pull.head.sha] : [tip()])
      state.main.push({ sha: landed, files: state.commits.get(pull.head.sha)?.files ?? [] })
      Object.assign(pull, { state: 'closed', merged_at: iso(), merge_commit_sha: landed, updated: ++state.edits })
      mark()
      return reply(200, { merged: true, sha: landed })
    }
    if (method === 'POST' && /^\/issues\/\d+\/comments$/.test(p)) {
      state.comments.set(number, [...state.comments.get(number) ?? [], { body: body.body, author_association: 'OWNER', user: { login: 'octocat' }, created_at: iso() }])
      return reply(201)
    }
    if (method === 'PATCH' && /^\/pulls\/\d+$/.test(p) && pull) {
      Object.assign(pull, body, { updated: ++state.edits })
      return reply(200)
    }
    if (method === 'DELETE' && p.startsWith('/git/refs/heads/')) return reply(state.branches.delete(p.slice('/git/refs/heads/'.length)) ? 204 : 422, null)
    return reply(404)
  }
  return { state, get, send, tip, mark }
}

function setup() {
  const clock = { now: Date.parse('2026-11-10T07:00:00Z') }
  const repo = fakeRepo(() => clock.now), { state } = repo
  const log = vi.fn()
  // Pip builds; Juno is the PM, and reads.
  const crew: Crew = { builders: [{ id: 'pip', name: 'Pip', label: 'builder:pip', machineId: 'mac', engine: 'claude' }], machines: [] }
  const start = () => new GitHubMerge({ projects: async () => [{ repo: 'acme/app', pm: 'Juno', tabId: 'tab', pmAgentId: 'juno', projectId: 'app' }],
    crew: async () => crew, get: repo.get, send: repo.send, now: () => clock.now, log })
  const f = {
    state, log, clock, merger: start(), mark: repo.mark,
    /** A daemon restart: a new merger, which remembers nothing. */
    restart: () => { f.merger = start() },
    say: (number: number, body: string) => state.comments.set(number, [...state.comments.get(number) ?? [],
      { body, author_association: 'MEMBER', user: { login: 'octocat' }, created_at: new Date(clock.now).toISOString() }]),
    /** Pip's pull request [number] on main's tip, read by Juno at its head, its checks green. */
    add: (number: number, over: { files?: string[]; body?: string; fork?: boolean } = {}): FakePull => {
      const head = sha(`head-${number}`)
      const pull: FakePull = { number, state: 'open', draft: false, title: `Change ${number}`, body: over.body ?? '', created_at: new Date(clock.now).toISOString(), updated: ++state.edits,
        merged_at: null, merge_commit_sha: null, head: { sha: head, ref: `pip/${number}`, repo: { full_name: over.fork ? 'pip/app' : 'acme/app' } }, base: { ref: 'main' },
        labels: [{ name: 'builder:pip' }], mergeable_state: 'clean', user: { login: 'pips-person' } }
      state.pulls.set(number, pull)
      state.commits.set(head, { on: repo.tip(), files: over.files ?? [`cli/src/f${number}.ts`] })
      state.runs.set(head, PASSED)
      f.say(number, `Juno, 14:20, to **Pip**: READ-OK ${head.slice(0, 7)}`)
      return pull
    },
    /** A new commit on pull request [number], read by Juno, on what it stood on. */
    push: (number: number): string => {
      const pull = state.pulls.get(number)!, head = sha(`${pull.head.sha}-pushed`)
      state.commits.set(head, state.commits.get(pull.head.sha)!)
      state.runs.set(head, PASSED)
      Object.assign(pull, { head: { ...pull.head, sha: head }, updated: ++state.edits })
      f.say(number, `Juno, 14:40, to **Pip**: READ-OK ${head.slice(0, 7)}`)
      return head
    },
    /** A commit someone lands on main by hand, changing [files]. */
    moveMain: (files: string[]) => { state.main.push({ sha: sha(`main-${state.main.length}`), files }) },
    tick: async (ms = 30_000) => { clock.now += ms; await f.merger.tick() },
    /** Two passes three minutes apart: checks count as passed only once they hold still (githubMerge.ts CHECKS_SETTLE_MS). */
    settle: async () => { await f.tick(); await f.tick(3 * 60_000) },
    trains: (): FakePull[] => [...state.pulls.values()].filter(pull => pull.head.ref.startsWith('harness-train/') && pull.head.repo.full_name === 'acme/app'),
    train: (): FakePull => f.trains().find(pull => pull.state === 'open')!,
    /** The open train's checks end as [runs], and the merger looks until they hold still. */
    ends: async (runs: Json[]) => { state.runs.set(f.train().head.sha, runs); await f.settle() },
    /** What was sent since [from], as `METHOD path`. */
    writes: (from = 0): string[] => state.sent.slice(from).map(s => `${s.method} ${s.path}`),
    said: (number: number): string[] => (state.comments.get(number) ?? []).map(c => String(c.body)).filter(body => body.startsWith('Harness, ')),
    /** The pull requests each train carried, by its body, oldest first. */
    carried: (): number[][] => f.trains().sort((a, b) => a.number - b.number).map(pull => trainOfBody(pull.body)!.members.map(m => m.number)),
    logged: (): string[] => log.mock.calls.map(([line]) => String(line)),
  }
  return f
}

describe('the ready pull requests ride a train (githubTrain.ts)', () => {
  it('still merges on its own a pull request that is alone and holds main\'s tip: its own checks ran on what lands', async () => {
    const f = setup()
    const pull = f.add(4)
    await f.settle()
    expect(f.writes()).toEqual(['PUT /pulls/4/merge', 'POST /issues/4/comments'])
    expect(f.state.sent[0]!.body).toEqual({ merge_method: 'squash', sha: pull.head.sha })
    expect(f.said(4)).toEqual([expect.stringMatching(/^Harness, \d\d:\d\d: merged\. READ-OK on \w{7} by Juno, checks green\.$/)])
  })

  // The swarm-sandbox, 2026-11-10: "the branch is behind main, so CI only ran the old single job", and it was merged.
  it('carries a pull request that is alone but behind main on a train of one, and never merges it on its older checks', async () => {
    const f = setup()
    const pull = f.add(4)
    f.moveMain(['cli/src/other.ts'])
    await f.settle()
    expect(f.writes().filter(w => w.startsWith('PUT'))).toEqual([])
    expect(f.carried()).toEqual([[4]])
    expect(f.state.commits.get(f.train().head.sha)).toEqual({ on: f.state.main.at(-1)!.sha, files: ['cli/src/f4.ts'] })
    await f.ends(PASSED)
    expect(f.writes().filter(w => w.startsWith('PUT'))).toEqual(['PUT /pulls/900/merge'])
    expect(f.said(4)).toEqual([expect.stringMatching(new RegExp(`^Harness, \\d\\d:\\d\\d: landed in #900 as \\w{7}\\. READ-OK on ${pull.head.sha.slice(0, 7)} by Juno, checks green\\.$`))])
    expect(pull.state).toBe('closed')
  })

  it('builds one train of the ready pull requests on main\'s tip, in number order, its body naming each at its full head', async () => {
    const f = setup()
    const c = f.add(7), a = f.add(4), b = f.add(5)
    await f.settle()
    const branch = f.train().head.ref
    expect(branch).toMatch(/^harness-train\/\d+$/)
    expect(f.state.sent.map(s => [s.method, s.path, s.body.ref ?? s.body.head])).toEqual([
      ['POST', '/git/refs', `refs/heads/${branch}`], ['POST', '/merges', a.head.sha], ['POST', '/merges', b.head.sha], ['POST', '/merges', c.head.sha], ['POST', '/pulls', branch]])
    expect(f.state.sent[0]!.body.sha).toBe(f.state.main[0]!.sha)
    expect(f.state.sent.slice(1, 4).map(s => s.body.base)).toEqual([branch, branch, branch])
    expect(f.train().title).toBe('Train: #4 #5 #7')
    expect(f.train().base.ref).toBe('main')
    expect(f.train().body.split('\n').slice(2)).toEqual([`#4 at ${a.head.sha}, READ-OK by Juno`, `#5 at ${b.head.sha}, READ-OK by Juno`, `#7 at ${c.head.sha}, READ-OK by Juno`])
    expect(f.train().body).toContain(`built to ${f.train().head.sha}`)
    expect(f.logged()).toContainEqual(expect.stringContaining('train acme/app#900 built on'))
  })

  it('carries twenty at most, and the rest on the next train', async () => {
    const f = setup()
    for (let number = 1; number <= 22; number++) f.add(number)
    await f.settle()
    expect(f.carried()).toEqual([Array.from({ length: 20 }, (_, i) => i + 1)])
    await f.ends(PASSED)
    await f.tick()
    expect(f.carried()[1]).toEqual([21, 22])
  })

  it('leaves out a member that conflicts, and tells its author once for its head', async () => {
    const f = setup()
    f.add(4); const b = f.add(5); f.add(6)
    f.state.conflicts.add(b.head.sha)
    await f.settle()
    expect(f.carried()).toEqual([[4, 6]])
    expect(f.said(5)).toEqual([expect.stringMatching(/^Harness, \d\d:\d\d, to \*\*pip\*\*: not merged yet at \w{7}: it conflicts with main: rebase it on main and push\.$/)])
    // The train lands; it is tried on the next, conflicts again at the same head, and is told no more.
    await f.ends(PASSED)
    await f.tick()
    expect(f.carried()).toEqual([[4, 6]])
    expect(f.said(5)).toHaveLength(1)
  })

  it('opens no train of pull requests main already holds', async () => {
    const f = setup()
    for (const pull of [f.add(4), f.add(5)]) f.state.inMain.add(pull.head.sha)
    await f.settle()
    expect(f.trains()).toEqual([])
    expect(f.state.branches.size).toBe(0)
  })

  // Review 1 of #3226: a commit anyone pushes onto the branch while it is built must never get into a train.
  it('opens no train on a branch someone pushed to while it was built, and deletes that branch before the next', async () => {
    const f = setup()
    f.add(4); f.add(5)
    let merges = 0
    f.state.beforeMerge = branch => { if (++merges === 2) f.state.branches.set(branch, sha('pushed')) }
    await f.settle()
    expect(f.trains()).toEqual([])
    expect(f.logged()).toContainEqual(expect.stringContaining('TRAIN_PUSHED acme/app: the merge of #5 into harness-train/'))
    const [left] = [...f.state.branches.keys()]
    f.state.beforeMerge = null
    await f.tick()
    expect(f.state.branches.has(left!)).toBe(false)
    expect(f.carried()).toEqual([[4, 5]])
    expect(f.train().head.ref).not.toBe(left)
  })

  it('builds no second train while one is open, and merges nothing on its own under it', async () => {
    const f = setup()
    f.add(4); f.add(5)
    await f.settle()
    const built = f.state.sent.length
    f.add(6)
    await f.settle()
    expect(f.writes(built)).toEqual([])
    // The train lands; the one that waited is now behind main, and rides the next.
    await f.ends(PASSED)
    await f.tick()
    expect(f.carried()).toEqual([[4, 5], [6]])
  })

  it('closes a second train open in the repository, and keeps the first', async () => {
    const f = setup()
    f.add(4); f.add(5)
    await f.settle()
    const first = f.train()
    f.state.branches.set('harness-train/second', first.head.sha)
    f.state.pulls.set(901, { ...structuredClone(first), number: 901, head: { ...first.head, ref: 'harness-train/second' } })
    const before = f.state.sent.length
    await f.tick()
    expect(f.writes(before)).toEqual(['PATCH /pulls/901', 'DELETE /git/refs/heads/harness-train/second'])
    expect(f.state.pulls.get(901)!.state).toBe('closed')
    expect(first.state).toBe('open')
  })

  // Review 2 of #3226: a fork's pull request may take any branch name, and closing it would delete the live train's branch.
  it('never takes a fork\'s pull request named like a train for one', async () => {
    const f = setup()
    f.add(4); f.add(5)
    await f.settle()
    const live = f.train()
    f.state.pulls.set(50, { ...structuredClone(live), number: 50, head: { ...live.head, repo: { full_name: 'outsider/app' } } })
    const before = f.state.sent.length
    await f.tick()
    expect(f.writes(before)).toEqual([])
    expect(f.state.branches.has(live.head.ref)).toBe(true)
  })

  // In an open project most people's agents work from forks. GitHub keeps a fork's head in the repository it is opened
  // against (refs/pull/N/head), and its merges API takes that head by its SHA: tried on 2026-11-10 with a commit only a
  // pull request held (201). Left to merge on its own, a fork's pull request landed on checks from an older base.
  it('carries a fork\'s pull request on the train with the others, by its head', async () => {
    const f = setup()
    f.add(4); const fork = f.add(5, { fork: true }); f.add(6)
    await f.settle()
    expect(f.writes().filter(w => w.startsWith('PUT'))).toEqual([])
    expect(f.carried()).toEqual([[4, 5, 6]])
    expect(f.state.sent.filter(s => s.path === '/merges').map(s => s.body.head)).toContain(fork.head.sha)
    await f.ends(PASSED)
    expect(f.writes().filter(w => w.startsWith('PUT'))).toEqual(['PUT /pulls/900/merge'])
    expect(fork).toMatchObject({ state: 'closed', merged_at: expect.any(String) })
  })

  // Whether GitHub compares a real fork's head with the base by its SHA is not yet seen, and a read it refuses would hold the
  // repository's pass: a fork alone rides a train of one, which the merges API either takes or refuses.
  it('carries a fork\'s pull request that is alone on a train of one, even on main\'s tip', async () => {
    const f = setup()
    const fork = f.add(4, { fork: true })
    await f.settle()
    expect(f.writes().filter(w => w.startsWith('PUT'))).toEqual([])
    expect(f.carried()).toEqual([[4]])
    expect(f.state.asked.filter(path => path.startsWith(`/compare/main...${fork.head.sha}`))).toEqual([])
  })

  it('merges a fork\'s pull request on its own, as before the train, when GitHub does not take its head, and builds the train of the others next', async () => {
    const f = setup()
    f.add(4); const fork = f.add(5, { fork: true }); f.add(6)
    f.state.untaken.add(fork.head.sha)
    await f.settle()
    // The train is not opened this pass: the fork's merge is about to move the base under it.
    expect(f.trains()).toEqual([])
    expect(f.state.branches.size).toBe(0)
    expect(f.writes().filter(w => !w.startsWith('POST /merges') && !w.includes('/git/refs'))).toEqual(['PUT /pulls/5/merge', 'POST /issues/5/comments'])
    await f.tick()
    expect(f.carried()).toEqual([[4, 6]])
  })

  // Review of #3974. Only "no such head" (404) is GitHub not taking a fork's head: a 422 is its answer to a request it will
  // not validate or to too many at once, and would have merged every later fork on its own, off the train.
  it('stops, and merges no fork on its own, on a 422 for its head', async () => {
    const f = setup()
    f.add(4); const fork = f.add(5, { fork: true })
    f.state.untaken.add(fork.head.sha)
    f.state.untakenAnswer = 422
    await f.settle()
    expect(f.writes().filter(w => w.startsWith('PUT'))).toEqual([])
    expect(f.logged()).toContainEqual(expect.stringContaining('TRAIN_REFUSED acme/app: GitHub answered POST /merges with 422.'))
  })

  // The same 404 answers a merge into a branch that is gone. The train's own branch deleted under the build is no word on
  // the fork's head: nothing merges on its own, and the next pass builds again.
  it('merges no fork on its own when the 404 is for the train\'s own branch, deleted under the build', async () => {
    const f = setup()
    f.add(4, { fork: true }); f.add(5, { fork: true }); f.add(6, { fork: true })
    let merges = 0
    f.state.beforeMerge = branch => { if (++merges === 2) f.state.branches.delete(branch) }
    await f.settle()
    expect(f.writes().filter(w => w.startsWith('PUT'))).toEqual([])
    expect(f.trains()).toEqual([])
    f.state.beforeMerge = null
    await f.tick()
    expect(f.carried()).toEqual([[4, 5, 6]])
  })

  // GitHub took its head once, into the train that went red: refused now, it is not merged on the checks that train failed.
  it('merges no fork on its own that a red train carried at this head', async () => {
    const f = setup()
    const fork = f.add(4, { fork: true }); f.add(5)
    await f.settle()
    // Refused from here on: the train that carries it is already built.
    f.state.untaken.add(fork.head.sha)
    await f.ends(FAILED)
    expect(f.carried()).toEqual([[4, 5]])
    expect(f.writes().filter(w => w.startsWith('PUT'))).toEqual([])
    expect(f.logged()).toContainEqual(expect.stringContaining('TRAIN_REFUSED acme/app: GitHub answered POST /merges with 404.'))
  })

  it('asks for no more merges once a fork\'s head is refused: no train is opened that pass', async () => {
    const f = setup()
    const fork = f.add(4, { fork: true }); f.add(5); f.add(6)
    f.state.untaken.add(fork.head.sha)
    await f.settle()
    expect(f.state.sent.filter(s => s.path === '/merges').map(s => s.body.head)).toEqual([fork.head.sha])
    expect(f.writes().filter(w => w.startsWith('PUT'))).toEqual(['PUT /pulls/4/merge'])
  })

  // A fork GitHub takes neither way was tried every 30 seconds for good: a branch made, a merge asked, the branch deleted
  // and a merge refused each time, on the PM's person's own login.
  it('tries a fork GitHub takes neither into a train nor on its own with the merger\'s waits, not every pass', async () => {
    const f = setup()
    const fork = f.add(4, { fork: true }); f.add(5)
    f.state.untaken.add(fork.head.sha)
    f.state.answer = (method, path) => method === 'PUT' && path === '/pulls/4/merge' ? { status: 405 } : undefined
    await f.settle()
    expect(f.logged()).toContainEqual(expect.stringContaining('FORK_REFUSED acme/app: GitHub takes #4 neither into a train nor on its own'))
    const before = f.writes().filter(w => w === 'POST /git/refs').length
    for (let pass = 0; pass < 20; pass++) await f.tick()
    expect(f.writes().filter(w => w === 'POST /git/refs').length - before).toBeLessThan(6)
  })

  it('stops, and merges nothing on its own, when GitHub does not take the head of a pull request of this repository', async () => {
    const f = setup()
    const a = f.add(4); f.add(5)
    f.state.untaken.add(a.head.sha)
    await f.settle()
    expect(f.writes().filter(w => w.startsWith('PUT'))).toEqual([])
    expect(f.trains()).toEqual([])
    expect(f.logged()).toContainEqual(expect.stringContaining('TRAIN_REFUSED acme/app: GitHub answered POST /merges with 404.'))
  })
})

describe('a train waits for its own checks, then lands or is closed', () => {
  it('waits while its checks run, and lands only once they hold still', async () => {
    const f = setup()
    f.add(4); f.add(5)
    await f.settle()
    const built = f.state.sent.length
    await f.tick()
    await f.tick(10 * 60_000)
    f.state.runs.set(f.train().head.sha, PASSED)
    // Passed at this look, and not yet the same in two.
    await f.tick()
    expect(f.writes(built)).toEqual([])
    await f.tick()
    expect(f.writes(built)[0]).toBe('PUT /pulls/900/merge')
  })

  // Squashed (as first built), a train's members were closed, not merged: to GitHub nobody shipped them, and the commit was the
  // PM's person's (shippingRead.ts counts a pull request merged under its author's login). A merge commit brings each member's
  // own commits into main, and GitHub marks each merged by itself.
  it('lands pinned to the head its checks passed, as a merge commit, closing the members\' issues; tells each member, closes none (GitHub marks each merged), and deletes its branch', async () => {
    const f = setup()
    const a = f.add(4, { body: 'Closes #2' }), b = f.add(5, { body: 'What it does.\n\nFixes #7 and resolves: #9\nSee #11. Closes #2' })
    await f.settle()
    const train = f.train(), built = f.state.sent.length
    await f.ends(PASSED)
    expect(f.writes(built)).toEqual(['PUT /pulls/900/merge', 'POST /issues/4/comments', 'POST /issues/5/comments', `DELETE /git/refs/heads/${train.head.ref}`])
    expect(f.state.sent[built]!.body).toEqual({ sha: train.head.sha, merge_method: 'merge', commit_title: 'Train: #4 #5',
      commit_message: '* Change 4 (#4)\n* Change 5 (#5)\n\nCloses #2\nCloses #7\nCloses #9' })
    const landed = f.state.main.at(-1)!
    expect(landed.files).toEqual(['cli/src/f4.ts', 'cli/src/f5.ts'])
    for (const pull of [a, b]) {
      expect(pull).toMatchObject({ state: 'closed', merged_at: expect.any(String) })
      expect(f.said(pull.number)).toEqual([expect.stringMatching(new RegExp(
        `^Harness, \\d\\d:\\d\\d: landed in #900 as ${landed.sha.slice(0, 7)}\\. READ-OK on ${pull.head.sha.slice(0, 7)} by Juno, checks green\\.$`))])
    }
    expect(f.state.branches.size).toBe(0)
    expect(f.logged()).toContainEqual(`[super-tab] train acme/app#900 landed #4 #5 as ${landed.sha.slice(0, 7)}`)
    // Nothing is read between the merge and the notes: the way it landed is the way it was just sent.
    expect(f.state.asked.filter(path => path === `/git/commits/${landed.sha}`)).toEqual([])
  })

  it.each([
    ['a squash where the repository allows no merge commit', { allow_merge_commit: false }, { merge_method: 'squash', commit_title: 'Train: #4 #5' }],
    ['a rebase, which takes no message, where it allows neither', { allow_squash_merge: false, allow_merge_commit: false }, { merge_method: 'rebase' }],
  ])('lands with %s, and closes each member itself: GitHub marks none merged', async (_case, settings, sent) => {
    const f = setup()
    f.state.settings = settings
    const a = f.add(4), b = f.add(5)
    await f.settle()
    const built = f.state.sent.length, branch = f.train().head.ref
    await f.ends(PASSED)
    const merge = f.state.sent.find(s => s.method === 'PUT')!.body
    expect(merge).toMatchObject(sent)
    expect('commit_message' in merge).toBe(sent.merge_method !== 'rebase')
    expect(f.train()).toBeUndefined()
    expect(f.writes(built)).toEqual(['PUT /pulls/900/merge', 'POST /issues/4/comments', 'PATCH /pulls/4', 'POST /issues/5/comments', 'PATCH /pulls/5', `DELETE /git/refs/heads/${branch}`])
    for (const pull of [a, b]) expect(pull).toMatchObject({ state: 'closed', merged_at: null })
  })

  // GitHub marks a member merged a moment after the merge commit, not with it. Closed by Harness in between, it would stay
  // closed and never read as merged; taken for a ready pull request, it would be carried again.
  it('leaves alone a member GitHub has not yet marked merged: told once, never closed, and carried on no other train', async () => {
    const f = setup()
    f.add(4); const b = f.add(5)
    await f.settle()
    f.state.marks = false
    await f.ends(PASSED)
    expect(b).toMatchObject({ state: 'open', merged_at: null })
    // To GitHub it may read as conflicting or as ready meanwhile: neither is acted on.
    const landed = f.state.sent.length
    for (const state of ['dirty', 'clean']) { b.mergeable_state = state; await f.settle() }
    expect(f.writes(landed)).toEqual([])
    expect(f.said(5)).toEqual([expect.stringContaining('landed in #900 as ')])
    f.state.marks = true
    f.mark()
    await f.settle()
    expect(b).toMatchObject({ state: 'closed', merged_at: expect.any(String) })
    expect(f.writes(landed)).toEqual([])
    expect(f.trains()).toHaveLength(1)
  })

  // No stored state: each release restarts the PM's daemon (seven on 2026-11-10), and the train it left open is read back.
  it('lands a train another daemon built, read back from GitHub after a restart', async () => {
    const f = setup()
    f.add(4); f.add(5)
    await f.settle()
    f.restart()
    await f.ends(PASSED)
    expect(f.writes().filter(w => w.startsWith('PUT'))).toEqual(['PUT /pulls/900/merge'])
    expect(f.carried()).toEqual([[4, 5]])
  })

  it.each([
    ['got a HOLD', (f: ReturnType<typeof setup>) => f.say(5, `Kai, 15:00: HOLD ${f.state.pulls.get(5)!.head.sha.slice(0, 7)} the day count is off by one`)],
    ['has a new head', (f: ReturnType<typeof setup>) => { f.push(5); f.state.comments.get(5)!.pop() }],
    ['was closed', (f: ReturnType<typeof setup>) => { f.state.pulls.get(5)!.state = 'closed' }],
  ])('closes a green train when a member %s since, and builds the next without it', async (_case, change) => {
    const f = setup()
    f.add(4); f.add(5); f.add(6)
    await f.settle()
    const first = f.train(), built = f.state.sent.length
    change(f)
    await f.ends(PASSED)
    expect(f.writes(built)).toEqual(['PATCH /pulls/900', `DELETE /git/refs/heads/${first.head.ref}`])
    expect(first).toMatchObject({ state: 'closed', title: 'Train: #4 #5 #6', merged_at: null })
    expect(f.logged()).toContainEqual('[super-tab] train acme/app#900 closed: a pull request it carries is no longer ready at its head')
    await f.tick()
    expect(f.carried()).toEqual([[4, 5, 6], [4, 6]])
  })

  // A member that only waits is still read and still at its head: its own check runs again, or GitHub has not yet said whether
  // it merges (it works that out anew each time main moves). After a daemon restart every member's checks wait three minutes to
  // hold still, as the train's own do, and whichever is looked at first decided whether a green run was thrown away.
  it.each<[string, (f: ReturnType<typeof setup>) => void, (f: ReturnType<typeof setup>) => void]>([
    ['whose own check runs again', f => f.state.runs.set(f.state.pulls.get(5)!.head.sha, RUNNING), f => f.state.runs.set(f.state.pulls.get(5)!.head.sha, PASSED)],
    ['GitHub has not yet said it can merge', f => { f.state.pulls.get(5)!.mergeable_state = 'unknown' }, f => { f.state.pulls.get(5)!.mergeable_state = 'clean' }],
  ])('keeps a green train while a member %s, and lands it once the member is ready again', async (_case, waits, ready) => {
    const f = setup()
    f.add(4); f.add(5)
    await f.settle()
    const built = f.state.sent.length
    waits(f)
    await f.ends(PASSED)
    expect(f.writes(built)).toEqual([])
    expect(f.train().state).toBe('open')
    ready(f)
    await f.settle()
    expect(f.writes(built)[0]).toBe('PUT /pulls/900/merge')
  })

  it('closes a green train whose member still waits 90 minutes after it was built', async () => {
    const f = setup()
    f.add(4); f.add(5)
    await f.settle()
    f.state.pulls.get(5)!.mergeable_state = 'unknown'
    await f.ends(PASSED)
    await f.tick(90 * 60_000)
    expect(f.trains()[0]).toMatchObject({ state: 'closed', merged_at: null })
    expect(f.logged()).toContainEqual('[super-tab] train acme/app#900 closed: a pull request it carries is no longer ready at its head')
  })

  // The review of #3909. A train is its branch: what it carries is what was merged into it, one merge for each member on the
  // base's tip. Its pull request's body is anyone's to write who can write to the repository: a member's line taken out lands
  // that member under a HOLD, and a line put in closes a pull request as landed that never was.
  it.each<[string, (f: ReturnType<typeof setup>, body: string) => string]>([
    ['loses its last member', (_f, body) => body.split('\n').filter(line => !line.startsWith('#5 ')).join('\n')],
    // The walk then passes #5's merge and ends one commit short of the base.
    ['loses its first member', (_f, body) => body.split('\n').filter(line => !line.startsWith('#4 ')).join('\n')],
    ['gains one the branch does not carry', (f, body) => `${body}\n#6 at ${f.state.pulls.get(6)!.head.sha}, READ-OK by Juno`],
  ])('lands nothing when its body %s after it was built', async (_case, edit) => {
    const f = setup()
    f.add(4); f.add(5)
    await f.settle()
    f.add(6)
    f.train().body = edit(f, f.train().body)
    await f.ends(PASSED)
    expect(f.writes().filter(w => w.startsWith('PUT'))).toEqual([])
    expect(f.logged()).toContainEqual('[super-tab] train acme/app#900 closed: its branch does not hold what its body names')
    expect([4, 5, 6].map(number => f.state.pulls.get(number)!.state)).toEqual(['open', 'open', 'open'])
  })

  it('reads no red or landed train from a closed pull request another login wrote as one', async () => {
    const f = setup()
    f.add(4); f.add(5)
    // Closed, titled as a train that failed carrying #5 alone, and one merged that names #4: neither is the train's.
    for (const [number, title, member] of [[60, 'Train, red: #5', 5], [61, 'Train: #4', 4]] as const) {
      Object.assign(f.add(number), { state: 'closed', title, head: { sha: sha(`forged-${number}`), ref: `harness-train/${number}`, repo: { full_name: 'acme/app' } },
        body: trainBody('main', sha(`forged-${number}`), [{ number: member, head: f.state.pulls.get(member)!.head.sha, readers: 'Juno' }]),
        ...number === 61 ? { merged_at: new Date(f.clock.now).toISOString(), merge_commit_sha: sha('forged-merge') } : {} })
    }
    await f.settle()
    expect(f.carried().at(-1)).toEqual([4, 5])
    expect([4, 5].map(number => f.state.pulls.get(number)!.state)).toEqual(['open', 'open'])
    expect([...f.said(4), ...f.said(5)]).toEqual([])
  })

  it('lands a train with no checks where no member had any: a repository with no CI', async () => {
    const f = setup()
    f.add(4); f.add(5)
    for (const number of [4, 5]) f.state.runs.delete(f.state.pulls.get(number)!.head.sha)
    await f.settle()
    f.state.runs.delete(f.train().head.sha)
    await f.settle()
    expect(f.writes().filter(w => w.startsWith('PUT'))).toEqual(['PUT /pulls/900/merge'])
  })

  it('closes a train whose checks never start, 90 minutes after it was built', async () => {
    const f = setup()
    f.add(4); f.add(5)
    await f.settle()
    f.state.runs.delete(f.train().head.sha)
    await f.settle()
    await f.tick(90 * 60_000)
    expect(f.trains()[0]).toMatchObject({ state: 'closed', merged_at: null })
    expect(f.logged()).toContainEqual('[super-tab] train acme/app#900 closed: its checks did not finish in 90 min')
  })

  it('takes for its train only a pull request this computer\'s login opened', async () => {
    const f = setup()
    f.add(4); f.add(5)
    // A builder's own branch under the train's prefix and its pull request written as a train's, its checks green.
    const forged = sha('forged')
    f.state.commits.set(forged, { on: f.state.main[0]!.sha, files: ['cli/src/unread.ts'] })
    f.state.runs.set(forged, PASSED)
    Object.assign(f.add(60), { title: 'Train: #5', head: { sha: forged, ref: 'harness-train/1', repo: { full_name: 'acme/app' } },
      body: trainBody('main', forged, [{ number: 5, head: f.state.pulls.get(5)!.head.sha, readers: 'Juno' }]) })
    await f.settle()
    f.state.runs.set(f.state.pulls.get(900)!.head.sha, PASSED)
    await f.settle()
    expect(f.writes().filter(w => w.startsWith('PUT'))).toEqual(['PUT /pulls/900/merge'])
    expect(f.state.pulls.get(60)).toMatchObject({ state: 'open', merged_at: null })
  })

  // Actions can take minutes to make a run, and a branch no workflow runs on gets none: no check at all read as passed.
  it('does not land a train that has no check of its own while its members had theirs', async () => {
    const f = setup()
    f.add(4); f.add(5)
    await f.settle()
    f.state.runs.delete(f.train().head.sha)
    await f.settle()
    await f.tick(10 * 60_000)
    expect(f.writes().filter(w => w.startsWith('PUT'))).toEqual([])
    await f.ends(PASSED)
    expect(f.writes().filter(w => w.startsWith('PUT'))).toEqual(['PUT /pulls/900/merge'])
  })

  // A rule of the repository the train cannot meet (a required review, a merge method) refused it every 15 minutes for good,
  // nothing else landed, and only the log said so.
  // Review of the merge-commit landing: a base that requires a linear history (or signed commits) refuses a merge commit with
  // a 405 while the repository's settings still allow one. The train stayed open and tried the same way for good, and nothing
  // else landed; squashed, as every train was before, the same tree lands.
  it('lands squashed when GitHub refuses the merge commit by a rule of the base, and closes each member itself', async () => {
    const f = setup()
    const a = f.add(4), b = f.add(5)
    await f.settle()
    const built = f.state.sent.length, branch = f.train().head.ref, head = f.train().head.sha
    f.state.answer = (method, path) => method === 'PUT' && path === '/pulls/900/merge' && f.state.sent.at(-1)!.body.merge_method === 'merge' ? { status: 405 } : undefined
    await f.ends(PASSED)
    // Both pinned to the head its checks passed.
    expect(f.state.sent.slice(built).filter(s => s.method === 'PUT').map(s => [s.body.merge_method, s.body.sha])).toEqual([['merge', head], ['squash', head]])
    expect(f.writes(built)).toEqual(['PUT /pulls/900/merge', 'PUT /pulls/900/merge', 'POST /issues/4/comments', 'PATCH /pulls/4', 'POST /issues/5/comments', 'PATCH /pulls/5',
      `DELETE /git/refs/heads/${branch}`])
    for (const pull of [a, b]) expect(pull).toMatchObject({ state: 'closed', merged_at: null })
    expect(f.said(900)).toEqual([])
    expect(f.state.main.at(-1)!.files).toEqual(['cli/src/f4.ts', 'cli/src/f5.ts'])
  })

  // GitHub refuses a merge with a 405 as the base moves, too. The next way must not land the train on a base it was not tested on.
  it('sends no second way when the base moved as GitHub refused the merge commit: the train is closed and built again', async () => {
    const f = setup()
    f.add(4); f.add(5)
    await f.settle()
    const built = f.state.sent.length, branch = f.train().head.ref
    f.state.answer = (method, path) => {
      if (method !== 'PUT' || path !== '/pulls/900/merge') return undefined
      f.moveMain(['cli/src/other.ts'])
      return { status: 405 }
    }
    await f.ends(PASSED)
    expect(f.writes(built)).toEqual(['PUT /pulls/900/merge', 'PATCH /pulls/900', `DELETE /git/refs/heads/${branch}`])
    expect(f.state.pulls.get(900)).toMatchObject({ state: 'closed', merged_at: null, title: 'Train: #4 #5' })
    expect(f.logged()).toContainEqual('[super-tab] train acme/app#900 closed: main moved under it')
  })

  it('sends no second way when the head moved (409): nothing lands', async () => {
    const f = setup()
    f.add(4); f.add(5)
    await f.settle()
    const built = f.state.sent.length
    f.state.answer = (method, path) => method === 'PUT' && path === '/pulls/900/merge' ? { status: 409 } : undefined
    await f.ends(PASSED)
    expect(f.writes(built)).toEqual(['PUT /pulls/900/merge'])
    expect(f.train().state).toBe('open')
  })

  it('says once on the train that GitHub refuses its merge every way, and leaves it open for a person', async () => {
    const f = setup()
    f.add(4); f.add(5)
    await f.settle()
    const built = f.state.sent.length
    f.state.answer = (method, path) => method === 'PUT' && path === '/pulls/900/merge' ? { status: 405 } : undefined
    await f.ends(PASSED)
    expect(f.writes(built)).toEqual(['PUT /pulls/900/merge', 'PUT /pulls/900/merge', 'PUT /pulls/900/merge', 'POST /issues/900/comments'])
    expect(f.state.sent.slice(built, built + 3).map(s => s.body.merge_method)).toEqual(['merge', 'squash', 'rebase'])
    expect(f.said(900)).toEqual([expect.stringMatching(/^Harness, \d\d:\d\d: GitHub refuses to merge this train \(405\)\. Nothing else lands in main while it is open: lift what blocks it, or close it and the next is built\.$/)])
    expect(f.logged()).toContainEqual(expect.stringContaining('TRAIN_REFUSED acme/app: GitHub answered PUT /pulls/900/merge with 405. (again in 30 s)'))
    await f.tick()
    expect(f.writes(built).filter(w => w.startsWith('PUT'))).toHaveLength(6)
    expect(f.said(900)).toHaveLength(1)
    expect(f.train().state).toBe('open')
  })

  // AGENTS.md: "add the `hold` label to keep a PR out".
  it('carries no pull request labelled hold', async () => {
    const f = setup()
    f.add(4); f.add(5).labels.push({ name: 'hold' }); f.add(6)
    await f.settle()
    expect(f.carried()).toEqual([[4, 6]])
  })

  it.each([
    ['code', ['docs/a.md', 'cli/src/other.ts']],
    // Documentation too: suites read some of it (scripts/ci-plan.py: docs/contracts/, docs/naming-system.md, THIRD_PARTY_NOTICES.md).
    ['only documentation', ['docs/plans/a.md', 'README.md']],
  ])('lands nothing it did not test: main gained %s, so the train is closed and built again on the new tip', async (_case, gained) => {
    const f = setup()
    f.add(4); f.add(5, { files: ['cli/src/f5.ts', 'docs/five.md'] })
    await f.settle()
    const built = f.state.sent.length
    f.moveMain(gained)
    // At once, and not when its run ends: a run on a base that moved lands nothing.
    await f.tick()
    expect(f.writes(built)).toEqual(['PATCH /pulls/900', expect.stringMatching(/^DELETE /)])
    await f.settle()
    expect(f.writes().filter(w => w.startsWith('PUT'))).toEqual([])
    expect(f.logged()).toContainEqual('[super-tab] train acme/app#900 closed: main moved under it')
    expect(f.carried()).toEqual([[4, 5], [4, 5]])
    expect(f.state.commits.get(f.train().head.sha)!.on).toBe(f.state.main.at(-1)!.sha)
  })

  it.each([
    // A push onto the train's branch, with green checks of its own.
    ['someone pushed to it', (train: FakePull) => { train.head.sha = sha('pushed') }],
    ['its body no longer reads as the train\'s', (train: FakePull) => { train.body = 'Ready, please merge.' }],
  ])('never merges a train whose branch is not at the tip it built: %s', async (_case, change) => {
    const f = setup()
    f.add(4); f.add(5)
    await f.settle()
    const train = f.train(), built = f.state.sent.length
    change(train)
    f.state.runs.set(train.head.sha, PASSED)
    await f.settle()
    expect(f.writes(built).slice(0, 2)).toEqual(['PATCH /pulls/900', `DELETE /git/refs/heads/${train.head.ref}`])
    expect(f.writes(built).filter(w => w.startsWith('PUT'))).toEqual([])
    expect(train.merged_at).toBeNull()
  })

  it('closes a train whose checks have not finished in 90 minutes, and builds it again', async () => {
    const f = setup()
    f.add(4); f.add(5)
    await f.settle()
    await f.tick(89 * 60_000)
    expect(f.train().number).toBe(900)
    await f.tick(2 * 60_000)
    expect(f.state.pulls.get(900)).toMatchObject({ state: 'closed', title: 'Train: #4 #5' })
    expect(f.logged()).toContainEqual('[super-tab] train acme/app#900 closed: its checks did not finish in 90 min')
    await f.tick()
    expect(f.carried()).toEqual([[4, 5], [4, 5]])
  })

  it.each([
    ['answers it with something else than merged', { status: 200, body: { merged: false } }, 'TRAIN_UNREADABLE acme/app: GitHub\'s answer to the merge of #900 is not one the train reads.'],
  ])('writes nothing more when GitHub %s, and tries again after the merger\'s wait', async (_case, answer, line) => {
    const f = setup()
    f.add(4); f.add(5)
    await f.settle()
    const built = f.state.sent.length
    f.state.answer = (method, path) => method === 'PUT' && path === '/pulls/900/merge' ? answer : undefined
    await f.ends(PASSED)
    expect(f.writes(built)).toEqual(['PUT /pulls/900/merge'])
    expect(f.logged()).toContainEqual(expect.stringContaining(`${line} (again in 30 s)`))
    f.state.answer = null
    await f.tick()
    expect(f.writes(built).filter(w => w.startsWith('PUT'))).toHaveLength(2)
    expect(f.said(4)).toHaveLength(1)
    expect(f.said(5)).toHaveLength(1)
  })

  it('finishes on the next pass a squashed landing whose close GitHub refused: each member told once, the merge not sent again', async () => {
    const f = setup()
    f.state.settings = { allow_merge_commit: false }
    f.add(4); const b = f.add(5)
    await f.settle()
    const branch = f.train().head.ref
    f.state.answer = (method, path) => method === 'PATCH' && path === '/pulls/5' ? { status: 422 } : undefined
    await f.ends(PASSED)
    expect(b.state).toBe('open')
    expect(f.state.branches.has(branch)).toBe(true)
    // To GitHub the landed change now conflicts with the main that holds it: no note of that to its author.
    b.mergeable_state = 'dirty'
    f.state.answer = null
    const before = f.state.sent.length
    await f.tick()
    expect(f.writes(before)).toEqual(['PATCH /pulls/5', `DELETE /git/refs/heads/${branch}`])
    expect(b.state).toBe('closed')
    expect(f.said(5)).toEqual([expect.stringContaining('landed in #900 as ')])
    expect(f.writes().filter(w => w.startsWith('PUT'))).toEqual(['PUT /pulls/900/merge'])
    await f.settle()
    expect(f.trains()).toHaveLength(1)
  })
})

describe('a red train', () => {
  it('of one is closed as red; its author is told once for the head, and it rides no train until its head changes', async () => {
    const f = setup()
    const pull = f.add(4)
    f.moveMain(['cli/src/other.ts'])
    await f.settle()
    const branch = f.train().head.ref, built = f.state.sent.length
    await f.ends(FAILED)
    expect(f.writes(built)).toEqual(['PATCH /pulls/900', `DELETE /git/refs/heads/${branch}`, 'POST /issues/4/comments'])
    expect(f.state.pulls.get(900)).toMatchObject({ state: 'closed', title: 'Train, red: #4' })
    expect(f.said(4)).toEqual([expect.stringMatching(new RegExp(`^Harness, \\d\\d:\\d\\d, to \\*\\*pip\\*\\*: not merged yet at ${pull.head.sha.slice(0, 7)}: its train failed: `
      + '#900 carried it alone on main, and its checks failed there\\. Fix it and push\\.$'))])
    const told = f.state.sent.length
    await f.settle()
    // A restart finds the note on the pull request, also once GitHub lists the red train no more among the last closed.
    f.restart()
    await f.settle()
    f.state.pulls.delete(900)
    await f.settle()
    expect(f.writes(told)).toEqual([])
    const pushed = f.push(4)
    await f.settle()
    expect(f.train()).toMatchObject({ number: 901, title: 'Train: #4' })
    expect(f.train().body).toContain(`#4 at ${pushed}`)
  })

  // lampOS's bot blamed a pull request by guess and was wrong 8 times in 22: the halves are run instead.
  it('of several runs again as its two halves, one after the other: the half that passes lands, the half that fails splits again', async () => {
    const f = setup()
    for (const number of [4, 5, 6, 7]) f.add(number)
    // One made meanwhile waits until the split has run.
    await f.settle()
    await f.ends(FAILED)
    expect(f.state.pulls.get(900)).toMatchObject({ state: 'closed', title: 'Train, red: #4 #5 #6 #7' })
    f.add(8)
    await f.tick()
    expect(f.carried().at(-1)).toEqual([4, 5])
    // The split is read from GitHub: a restart carries on with it.
    f.restart()
    await f.ends(PASSED)
    await f.tick()
    expect(f.carried().at(-1)).toEqual([6, 7])
    await f.ends(FAILED)
    await f.tick()
    expect(f.carried().at(-1)).toEqual([6])
    await f.ends(FAILED)
    // #6 failed alone and is told; #7 rides.
    await f.tick()
    expect(f.said(6)).toEqual([expect.stringContaining('its train failed: #903 carried it alone on main')])
    expect(f.carried().at(-1)).toEqual([7])
    await f.ends(PASSED)
    await f.tick()
    expect(f.carried()).toEqual([[4, 5, 6, 7], [4, 5], [6, 7], [6], [7], [8]])
    expect([4, 5, 6, 7].map(number => f.state.pulls.get(number)!.state)).toEqual(['closed', 'closed', 'open', 'closed'])
    expect(f.writes().filter(w => w.startsWith('PUT'))).toEqual(['PUT /pulls/901/merge', 'PUT /pulls/904/merge'])
  })
})

describe('what the train never does', () => {
  // The merger passes every 30 seconds for as long as the daemon runs: at rest the train adds one read to a pass, answered
  // 304 while nothing closed (120 passes of githubLoops.spec.ts: 3,489 reads before the train, 3,611 with it).
  it('asks GitHub for the closed pull requests once a pass, and for nothing else of its own, while none is ready', async () => {
    const f = setup()
    f.add(4)
    f.state.comments.set(4, [])
    await f.settle()
    const before = f.state.asked.length
    await f.tick()
    const asked = f.state.asked.slice(before)
    expect(asked.filter(path => path.includes('state=closed'))).toHaveLength(1)
    expect(asked.filter(path => /^\/(?:git|compare)\//.test(path))).toEqual([])
    expect(f.writes()).toEqual([])
  })

  it('writes no ref outside harness-train/, and never moves one it made', async () => {
    const f = setup()
    for (const number of [4, 5, 6]) f.add(number)
    // A builder's branch, and one that only begins like the train's.
    for (const other of ['pip/4', 'harness-trains', 'harness-train/%2e%2e/pip/4']) f.state.branches.set(other, f.state.pulls.get(4)!.head.sha)
    await f.settle()
    await f.ends(FAILED)
    await f.tick()
    await f.ends(PASSED)
    await f.tick()
    await f.ends(PASSED)
    const refs = f.state.sent.filter(s => s.path.startsWith('/git/'))
    expect(refs.length).toBeGreaterThan(5)
    for (const sent of refs) {
      expect(['POST', 'DELETE']).toContain(sent.method)
      expect(sent.method === 'POST' ? String(sent.body.ref) : sent.path).toMatch(/^(?:refs\/heads|\/git\/refs\/heads)\/harness-train\/\d+$/)
    }
    expect([...f.state.branches.keys()]).toEqual(['pip/4', 'harness-trains', 'harness-train/%2e%2e/pip/4'])
  })

  it('stops every repository while GitHub limits this computer\'s writes, and builds once the limit is over', async () => {
    const f = setup()
    f.add(4); f.add(5)
    f.state.answer = () => ({ status: 403, resetAt: f.clock.now + 10 * 60_000 })
    await f.settle()
    expect(f.writes()).toEqual(['POST /git/refs'])
    expect(f.logged()).toContainEqual(expect.stringContaining('RATE_LIMITED GitHub is limiting this computer\'s requests.'))
    f.state.answer = null
    await f.tick(5 * 60_000)
    expect(f.writes()).toEqual(['POST /git/refs'])
    await f.tick(5 * 60_000)
    expect(f.carried()).toEqual([[4, 5]])
  })
})

describe('the train\'s parts', () => {
  const head = (n: number) => sha(`head-${n}`)
  const member = (number: number) => ({ number, head: head(number), readers: 'Juno' })

  it('reads back the tip and members of a body it wrote, and nothing from any other', () => {
    const members = [{ number: 4, head: head(4), readers: 'Juno and Kai Lee' }, { number: 12, head: head(12), readers: 'kenmore' }]
    expect(trainOfBody(trainBody('main', sha('tip'), members))).toEqual({ tip: sha('tip'), members })
    // As GitHub's editor saves it, with carriage returns.
    expect(trainOfBody(trainBody('main', sha('tip'), members).replace(/\n/g, '\r\n'))).toEqual({ tip: sha('tip'), members })
    // A name is cut to letters, digits, spaces and hyphens, so the body always reads back.
    expect(trainOfBody(trainBody('main', sha('tip'), [{ number: 4, head: head(4), readers: 'dependabot[bot]' }]))!.members[0]!.readers).toBe('dependabotbot')
    for (const body of ['', `built to ${sha('tip')}`, `#4 at ${head(4)}, READ-OK by Juno`, `built to ${sha('tip')}\n#4 at ${head(4).slice(0, 12)}, READ-OK by Juno`,
      `built to ${sha('tip')}\n#4 at ${head(4)}, READ-OK by Juno\n#4 at ${head(5)}, READ-OK by Juno`,
      trainBody('main', sha('tip'), Array.from({ length: 21 }, (_, i) => member(i + 1)))]) expect(trainOfBody(body), body).toBeNull()
  })

  it('splits a red train in two halves, and one of one not at all', () => {
    expect(splitRed([1, 2, 3, 4, 5])).toEqual([[1, 2, 3], [4, 5]])
    expect(splitRed([1, 2])).toEqual([[1], [2]])
    expect(splitRed([1])).toEqual([])
  })

  it('picks who rides next: every ready one, or the next half of the smallest red train that carried it at this head', () => {
    const ready = (...numbers: number[]) => numbers.map(number => ({ number, head: head(number) }))
    const numbers = (found: ReturnType<typeof nextTrain<{ number: number; head: string }>>) => found.riders.map(pull => pull.number)
    const whole = { number: 900, members: [4, 5, 6, 7].map(member) }
    expect(numbers(nextTrain(ready(7, 4, 5), []))).toEqual([4, 5, 7])
    expect(numbers(nextTrain(ready(...Array.from({ length: 25 }, (_, i) => i + 1)), []))).toHaveLength(20)
    expect(numbers(nextTrain(ready(4, 5, 6, 7, 8), [whole]))).toEqual([4, 5])
    // The first half landed, or one of it is no longer ready: the rest of it, then the second.
    expect(numbers(nextTrain(ready(5, 6, 7), [whole]))).toEqual([5])
    expect(numbers(nextTrain(ready(6, 7, 8), [whole]))).toEqual([6, 7])
    // A half that failed is split again.
    expect(numbers(nextTrain(ready(4, 5, 6, 7), [whole, { number: 901, members: [4, 5].map(member) }]))).toEqual([4])
    // One that failed alone rides no more, and the other of its half does.
    const alone = nextTrain(ready(4, 5, 6, 7), [whole, { number: 901, members: [4, 5].map(member) }, { number: 902, members: [member(4)] }])
    expect(alone.alone).toEqual([{ pull: { number: 4, head: head(4) }, train: 902 }])
    expect(numbers(alone)).toEqual([5])
    // A new head was carried by no red train.
    expect(numbers(nextTrain([{ number: 4, head: sha('new') }], [{ number: 902, members: [member(4)] }]))).toEqual([4])
  })

  it('says what a train lands: each member by title and number, and a Closes for every issue a member\'s body closes', () => {
    expect(landingMessage([{ number: 4, title: ' Fix the\nday count ', body: 'closes #2, Fixed: #3' }, { number: 5, title: 'Add a flag', body: 'Resolves #3\nRelated to #8, closes acme/other#9' }]))
      .toEqual({ commit_title: 'Train: #4 #5', commit_message: '* Fix the day count (#4)\n* Add a flag (#5)\n\nCloses #2\nCloses #3' })
    expect(landingMessage([{ number: 4, title: 'Tidy', body: 'No issue.' }])).toEqual({ commit_title: 'Train: #4', commit_message: '* Tidy (#4)' })
  })
})
