import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Crew } from './assign/crew.js'
import { parseSuperTabArgs } from './command.js'
import { GitHubAssign, swarmRepositories } from './githubAssign.js'
import { VerdictRecords, type LedProject } from './githubMerge.js'
import type { GitHubGet, GitHubSend } from './githubRest.js'
import { commandRecords } from './commandRecords.fake.js'
import type { Score } from './goal.js'
import { PmNumbers, type DayBoard, type Numbers } from './pmNumbers.js'
import type { TaskOffer } from './taskOffers.js'
import { SuperTabHostError } from './wire.js'

type Json = Record<string, unknown>
const GiB = 1024 ** 3
/** The GitHub login of the PM's person, whose Harness plans the project, and its Swarm's label in the repository: on every task
 *  here unless a case says otherwise. */
const LOGIN = 'dee', MARK = 'swarm:acme'
const issue = (number: number, labels: string[], extra: Json = {}): Json => ({ number, labels: [...labels, MARK].map(name => ({ name })), user: { login: LOGIN }, ...extra })
const PROJECT = { repo: 'acme/app', pm: 'Faye', tabId: 'tab', pmAgentId: 'faye', projectId: 'app' }
const TIP = 'c0ffee0000000000000000000000000000000001'

/** One repository's issues as GitHub's REST API answers them, with ETags, and what was sent to it. Labels sent are kept
 *  only once [applied] says GitHub's lists show them. */
function fakeGitHub(open: Json[], closed: Json[] = []) {
  const records = commandRecords()
  // A repository already set up for the flow: its labels, and its builders' (a fresh one is set apart below).
  const labels = ['status:taken', 'size:s', 'size:m', 'size:l', 'p0', 'p1', 'p2', 'builder:pip', 'builder:juno', 'builder:atlas'].map(name => ({ name } as Json)).concat({ name: MARK, description: 'Swarm tab' })
  const state = { open, closed, asked: [] as string[], labelAnswer: 200, deleteAnswer: 200, commentAnswer: 201, signedOut: false, applied: false,
    /** Runs as a label's DELETE arrives, before it is answered: a test changes the issue here, or refuses the call with a status. */
    deleted: null as ((issue: Json, label: string) => number | void) | null,
    files: new Map<string, string>(), checks: [] as Json[], headChecks: new Map<string, Json[]>(), checksDown: false, checksLimited: false, labels: labels as Json[], pulls: [] as Json[], comments: new Map<number, Json[]>(), reviews: new Map<number, Json[]>(), compare: new Map<string, Json>(),
    /** The files each pull request changes, and the paths GitHub fails on its own side for. */
    changed: new Map<number, string[]>(), failing: null as RegExp | null,
    /** The open issues and pull requests of the Swarm's other projects' repositories, by repository; null for one this login
     *  cannot read. And each answer's path and status, as given. */
    elsewhere: new Map<string, Json[] | null>(), replies: [] as Array<[string, number]>,
    /** How many requests are being answered now, and the most at once. */
    flying: 0, most: 0 }
  const sent: Array<{ method: string; path: string; body: Json }> = []
  const answer: GitHubGet = async (path, etag) => {
    state.asked.push(path)
    if (state.signedOut) throw Object.assign(new Error('gh is not signed in on this computer: run `gh auth login`.'), { code: 'GH_SIGNED_OUT' })
    const url = new URL(`https://api.github.com${path}`)
    // A token that cannot read checks (a fine-grained one without Checks), as GitHub answers it.
    if (state.checksDown && /\/commits\/[0-9a-f]{40}\/check-runs$/.test(url.pathname)) return { status: 403, etag: null, body: { message: 'Resource not accessible by integration' }, resetAt: null }
    if (state.checksLimited && /\/commits\/[0-9a-f]{40}\/check-runs$/.test(url.pathname)) return { status: 403, etag: null, body: {}, resetAt: Date.now() + 60_000 }
    if (state.failing?.test(url.pathname)) return { status: 500, etag: null, body: null, resetAt: null }
    const file = /^\/repos\/acme\/app\/contents\/(.+)$/.exec(url.pathname)
    const text = file ? state.files.get(decodeURIComponent(file[1]!)) : undefined
    if (file && text === undefined) return { status: 404, etag: null, body: null, resetAt: null }
    const body = file ? { encoding: 'base64', content: Buffer.from(text!).toString('base64') }
      : url.pathname === '/user' ? { login: LOGIN }
      : url.pathname === '/repos/acme/app' ? { default_branch: 'main' }
      // Main's last commit and its checks, where a project's goal is scored (goal.ts).
      : url.pathname === '/repos/acme/app/commits' ? url.searchParams.get('sha') === 'main' ? [{ sha: TIP, parents: [] }] : null
      : url.pathname === `/repos/acme/app/commits/${TIP}/check-runs` ? { check_runs: state.checks }
      // A pull request's head's checks, none unless a test gives some; and its combined status.
      : /^\/repos\/acme\/app\/commits\/[0-9a-f]{40}\/check-runs$/.test(url.pathname) ? { check_runs: state.headChecks.get(url.pathname.split('/')[5]!) ?? [] }
      : /^\/repos\/acme\/app\/commits\/[0-9a-f]{40}\/status$/.test(url.pathname) ? { state: 'success', statuses: [] }
      // A page of the list, as GitHub pages it.
      : url.pathname === '/repos/acme/app/pulls' ? state.pulls.slice((Number(url.searchParams.get('page') ?? 1) - 1) * Number(url.searchParams.get('per_page') ?? 30),
        Number(url.searchParams.get('page') ?? 1) * Number(url.searchParams.get('per_page') ?? 30))
      // Since a moment, when the read asks so, as GitHub lists them.
      : /^\/repos\/acme\/app\/issues\/\d+\/comments$/.test(url.pathname) ? (state.comments.get(Number(url.pathname.split('/').at(-2))) ?? []).map(records.served)
        .filter(comment => !url.searchParams.has('since') || !(Date.parse(String(comment.created_at)) < Date.parse(url.searchParams.get('since')!)))
      : /^\/repos\/acme\/app\/pulls\/\d+\/reviews$/.test(url.pathname) ? state.reviews.get(Number(url.pathname.split('/').at(-2))) ?? []
      : /^\/repos\/acme\/app\/pulls\/\d+\/files$/.test(url.pathname) ? (state.changed.get(Number(url.pathname.split('/').at(-2))) ?? []).map(filename => ({ filename }))
      // A head against main, from the commit of main it stands on.
      : /^\/repos\/acme\/app\/compare\/main\.\.\.[0-9a-f]+$/.test(url.pathname) ? state.compare.has(url.pathname.split('...').at(-1)!)
        ? { merge_base_commit: { sha: 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0' }, ...state.compare.get(url.pathname.split('...').at(-1)!) as Json } : null
      // Every repository of the Swarm has its label.
      : /^\/repos\/[^/]+\/[^/]+\/labels$/.test(url.pathname) ? url.pathname === '/repos/acme/app/labels' || state.elsewhere.get(url.pathname.split('/').slice(2, 4).join('/')) ? state.labels : null
      // A page of the list, as GitHub pages it.
      : url.pathname === '/repos/acme/app/issues' ? (url.searchParams.get('state') === 'closed' ? state.closed : state.open)
        .slice((Number(url.searchParams.get('page') ?? 1) - 1) * Number(url.searchParams.get('per_page') ?? 30), Number(url.searchParams.get('page') ?? 1) * Number(url.searchParams.get('per_page') ?? 30))
      // Another project's repository's open list, with each label asked for on it (GitHub's `labels`, in any case), paged the same way.
      : /^\/repos\/[^/]+\/[^/]+\/issues$/.test(url.pathname) ? state.elsewhere.get(url.pathname.split('/').slice(2, 4).join('/'))
        ?.filter(row => (url.searchParams.get('labels') ?? '').split(',').filter(Boolean)
          .every(asked => (row.labels as Json[]).some(label => String(label.name).toLowerCase() === asked.toLowerCase())))
        .slice((Number(url.searchParams.get('page') ?? 1) - 1) * Number(url.searchParams.get('per_page') ?? 30), Number(url.searchParams.get('page') ?? 1) * Number(url.searchParams.get('per_page') ?? 30)) ?? null
      : null
    if (body === null) return { status: 404, etag: null, body: null, resetAt: null }
    const tag = `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`
    const reply = etag === tag ? { status: 304, etag: tag, body: null, resetAt: null } : { status: 200, etag: tag, body, resetAt: null }
    state.replies.push([path, reply.status])
    return reply
  }
  const send: GitHubSend = async (method, path, body) => {
    sent.push({ method, path, body: body as Json })
    if (path === '/repos/acme/app/labels') { state.labels.push({ name: (body as Json).name }); return { status: 201, etag: null, body: {}, resetAt: null } }
    const removed = /\/issues\/(\d+)\/labels\/(.+)$/.exec(path)
    if (method === 'DELETE' && removed) {
      const target = state.open.find(i => i.number === Number(removed[1]))!, label = decodeURIComponent(removed[2]!)
      const refused = state.deleteAnswer !== 200 ? state.deleteAnswer : state.deleted?.(target, label)
      if (refused) return { status: refused, etag: null, body: {}, resetAt: null }
      // A label that is not on the issue: GitHub answers 404.
      if (!(target.labels as Json[]).some(l => l.name === label)) return { status: 404, etag: null, body: {}, resetAt: null }
      target.labels = (target.labels as Json[]).filter(l => l.name !== label)
      return { status: 200, etag: null, body: [], resetAt: null }
    }
    const labels = /\/issues\/(\d+)\/labels$/.exec(path)
    if (labels) {
      if (state.labelAnswer !== 200) return { status: state.labelAnswer, etag: null, body: {}, resetAt: null }
      if (state.applied) state.open.find(i => i.number === Number(labels[1]))!.labels = [...(state.open.find(i => i.number === Number(labels[1]))!.labels as Json[]),
        ...((body as Json).labels as string[]).map(name => ({ name }))]
      return { status: 200, etag: null, body: [], resetAt: null }
    }
    return { status: path.endsWith('/comments') ? state.commentAnswer : 201, etag: null, body: {}, resetAt: null }
  }
  // Each answer comes a moment later, as over the wire: requests made at once are in flight together.
  const get: GitHubGet = async (path, etag) => {
    state.most = Math.max(state.most, ++state.flying)
    await Promise.resolve()
    try { return await answer(path, etag) } finally { state.flying-- }
  }
  return { state, sent, get, send, authors: records.authors }
}

/** Pip and Juno on one Mac with room and quota. */
const crew = (): Crew => ({
  builders: [{ id: 'pip', name: 'Pip', label: 'builder:pip', machineId: 'mac', engine: 'claude' },
    { id: 'juno', name: 'Juno', label: 'builder:juno', machineId: 'mac', engine: 'claude' }],
  machines: [{ machineId: 'mac', observation: { resources: { memoryTotalBytes: 64 * GiB, projectDiskFreeBytes: 500 * GiB } } }],
})

/** The Swarm's server's offers (backend superTabs/taskOffers.ts), as it keeps them: one record for a task, live two minutes for
 *  an answer and ten once accepted, a second offer of a live one refused. [missing]: a server from before the routes; [down]: one
 *  that does not answer. */
function fakeServer(clock: { now: number }) {
  const records = new Map<number, { agentId: string; offeredAt: number; expiresAt: number; acceptedAt?: number; declined?: string }>()
  const state = { missing: false, down: false, offered: [] as Array<[number, string]>, asked: [] as number[][],
    /** Another project's PM coordinates the repository (backend githubComments.ts repositoryProject): this one's reads are a
     *  project that does not exist, and [unreadable] false its offers alone are refused. */
    elsewhere: false, unreadable: true }
  const refuse = () => {
    if (state.missing) throw new SuperTabHostError('BACKEND_UNAVAILABLE', 'Route not found', 404)
    if (state.down) throw new SuperTabHostError('BACKEND_UNAVAILABLE', 'No answer.', 503)
  }
  const stateOf = (r: { expiresAt: number; acceptedAt?: number; declined?: string }) =>
    r.declined ? 'declined' as const : r.expiresAt <= clock.now ? 'lapsed' as const : r.acceptedAt ? 'accepted' as const : 'offered' as const
  const offers = {
    offer: vi.fn(async (_project: LedProject, number: number, agentId: string) => {
      refuse()
      if (state.elsewhere) throw new SuperTabHostError('PM_REQUIRED', 'Only the Product Manager of the first project made on that repository offers its tasks.', 403)
      const held = records.get(number)
      if (held && held.expiresAt > clock.now && held.agentId !== agentId) throw new SuperTabHostError('OFFER_LIVE', 'This task is offered to another agent.', 409)
      if (!held || held.expiresAt <= clock.now) records.set(number, { agentId, offeredAt: clock.now, expiresAt: clock.now + 2 * 60_000 })
      state.offered.push([number, agentId])
    }),
    listed: vi.fn(async (_project: LedProject, numbers: readonly number[]): Promise<TaskOffer[]> => {
      refuse()
      if (state.elsewhere && state.unreadable) throw new SuperTabHostError('NOT_FOUND', 'This project is unavailable.', 404)
      state.asked.push([...numbers])
      return [...records].filter(([number, r]) => numbers.includes(number) && r.expiresAt > clock.now - 10 * 60_000).map(([number, r]) => ({ repository: 'acme/app', number, agentId: r.agentId,
        state: stateOf(r), offeredAt: r.offeredAt, expiresAt: r.expiresAt, ...r.acceptedAt ? { acceptedAt: r.acceptedAt } : {}, ...r.declined ? { declined: r.declined } : {} }))
    }),
  }
  /** Its agent's computer answers the offer of task [number]. */
  const accept = (number: number) => { const r = records.get(number)!; r.acceptedAt = clock.now; r.expiresAt = clock.now + 10 * 60_000 }
  const decline = (number: number, reason: string) => { const r = records.get(number)!; r.declined = reason; r.expiresAt = clock.now }
  return { state, records, offers, accept, decline }
}

function setup(open: Json[], options: { closed?: Json[]; crew?: Crew
  numbers?: { pass: (project: LedProject, numbers: Numbers, goal: () => Promise<Score | null>, board: () => Promise<DayBoard>) => Promise<void> }
  /** The repositories of the Swarm's projects, as the PM's person reads it: this project's alone unless a case says more. */
  repositories?: () => Promise<string[]> } = {}) {
  const github = fakeGitHub(open, options.closed)
  const log = vi.fn()
  /** What each pass counted (pmNumbers.ts). */
  const numbers = vi.fn(async (_project: LedProject, _numbers: Numbers, _goal: () => Promise<Score | null>, _board: () => Promise<DayBoard>) => {})
  const clock = { now: Date.parse('2026-11-09T07:31:00Z') }
  const pm = { running: true, unreadable: false }
  const server = fakeServer(clock)
  /** What the PM says to its person in its chat, by the operation it is said under. */
  const say = vi.fn(async (_project: LedProject, _operationId: string, _text: string) => ({}))
  /** The assigner of this project, or of [as] another Swarm's on the same repository: its PM's person's login, project and crew. */
  const make = (as?: { login: string; project: LedProject; crew: Crew }) => new GitHubAssign({ projects: async () => [as?.project ?? PROJECT], crew: async () => as?.crew ?? options.crew ?? crew(), repositories: options.repositories ?? (async () => [PROJECT.repo]),
    swarm: async () => 'Acme',
    get: as ? (path, etag) => path === '/user' ? Promise.resolve({ status: 200, etag: null, body: { login: as.login }, resetAt: null }) : github.get(path, etag) : github.get, send: github.send, pmRunning: async () => { if (pm.unreadable) throw new Error('The backend did not answer.'); return pm.running },
    now: () => clock.now, log, records: new VerdictRecords(github.authors, () => clock.now, log), numbers: options.numbers ?? { pass: numbers }, offers: server.offers, say })
  const assigner = make()
  const labelled = () => github.sent.filter(s => /\/issues\/\d+\/labels$/.test(s.path)).map(s => [Number(s.path.split('/').at(-2)), (s.body.labels as string[])[0]])
  const said = () => github.sent.filter(s => s.path.endsWith('/comments')).map(s => [Number(s.path.split('/').at(-2)), String(s.body.body)])
  return { github, assigner, make, log, labelled, said, clock, numbers, pm, server, say }
}

describe('Harness gives a team\'s tasks to its builders (githubAssign.ts)', () => {
  // #4212: Tony's Harness gave Dee's #4208 to its own Mobile Builder a minute after Dee's PM opened it, and Dee's Harness asked
  // "Lennox" about #3880, which 0xken15's Swarm's Lennox held. Whose task it is lives on the task: its Swarm's label.
  it('gives out and asks about only its own Swarm\'s tasks where two Swarms, each with a Lennox, build one repository', async () => {
    const quiet = '2026-11-09T01:00:00Z', KEN = 'swarm:acme-tab-ken'
    const row = (number: number, labels: string[], login: string, extra: Json = {}): Json => ({ number, labels: labels.map(name => ({ name })), user: { login }, ...extra })
    const lennox = { id: 'lennox', name: 'Lennox', label: 'builder:lennox', machineId: 'mac', engine: 'claude' }
    // Each PM opened a task, which says nothing of its Swarm yet; and each Swarm's Lennox holds one, quiet for hours.
    const f = setup([row(1, ['size:s'], 'dee'), row(2, ['size:s'], 'ken'),
      row(3, ['size:m', 'builder:lennox', 'status:taken', KEN], 'ken', { updated_at: quiet }), row(4, ['size:m', 'builder:lennox', 'status:taken', MARK], 'dee', { updated_at: quiet })],
    { crew: { builders: [lennox, crew().builders[1]!], machines: crew().machines },
      closed: [row(8, ['size:s', KEN], 'ken', { closed_at: '2026-11-09T06:00:00Z', updated_at: '2026-11-09T06:00:00Z' })] })
    // The other Swarm has the same name, so its label has the start of its id too: each is found by the id in its description.
    f.github.state.labels.push({ name: KEN, description: 'Swarm tab-ken' }, { name: 'builder:lennox' }, { name: 'builder:kai' })
    // The other Lennox's pull request for its task: `builder:lennox`, as this Swarm's Lennox's would be.
    f.github.state.pulls = [{ number: 30, draft: false, base: { ref: 'main' }, head: { sha: 'f6edb44c0ffee0000000000000000000000000ab', ref: 'lennox/3' },
      labels: [{ name: 'builder:lennox' }], body: 'Closes #3', author_association: 'MEMBER', updated_at: quiet }]
    const wrote = (from = 0) => f.github.sent.slice(from).map(s => [Number(/\/issues\/(\d+)\//.exec(s.path)?.[1]), (s.body.labels as string[] | undefined)?.[0] ?? String(s.body.body).replace(/^Harness, \d\d:\d\d(, to|: for) /, '').slice(0, 40)])
    await f.assigner.tick()
    // Its PM's task gets its Swarm's label and goes to Juno, and its own Lennox is asked about its quiet task. The other Swarm's
    // task is not given, its Lennox's is not asked about, its pull request gets no reader, and its closed task's time is not read.
    expect(wrote()).toEqual([[1, MARK], [4, '**Lennox**: nothing has moved on this ta'], [1, 'builder:juno'], [1, '**Juno**: it can start now.']])
    expect(f.github.state.asked.filter(path => /\/issues\/(3|8|30)\/comments/.test(path))).toEqual([])
    // The other Swarm's Harness, as its own PM's person, with its own Lennox: it touches only what the first left alone.
    const sent = f.github.sent.length
    await f.make({ login: 'Ken', project: { ...PROJECT, pm: 'River', tabId: 'tab-ken', pmAgentId: 'river', projectId: 'ken-app' },
      crew: { builders: [{ ...lennox, id: 'ken-lennox' }, { id: 'kai', name: 'Kai', label: 'builder:kai', machineId: 'mac', engine: 'claude' }], machines: crew().machines } }).tick()
    expect(wrote(sent)).toEqual([[2, KEN], [30, '**Kai**: please read this pull request, '], [2, expect.stringMatching(/^builder:(kai|lennox)$/)], [2, expect.stringContaining('it can start now')]])
    expect(f.github.state.asked.filter(path => /\/issues\/8\/comments/.test(path))).toHaveLength(1)
  })
  it('finds its Swarm\'s label by the id in its description, makes it once, and says one GitHub refuses', async () => {
    const made = (f: ReturnType<typeof setup>) => f.github.sent.filter(s => s.path === '/repos/acme/app/labels').map(s => s.body)
    // None yet: made with the Swarm's name, and its id in the description.
    const f = setup([])
    f.github.state.labels = f.github.state.labels.filter(label => label.name !== MARK)
    await f.assigner.tick()
    const asked = f.github.state.asked.length
    await f.assigner.tick()
    expect(made(f)).toEqual([{ name: MARK, color: '5319e7', description: 'Swarm tab' }])
    // Found once: a later pass asks GitHub for neither the labels nor the login again (the daemon at rest).
    expect(f.github.state.asked.slice(asked).filter(path => path === '/user' || path.includes('/labels'))).toEqual([])
    // Another Swarm of the same name has that label: this one's has the start of its id, and no task of the other's is this one's.
    const g = setup([issue(1, ['size:s'])])
    g.github.state.labels.find(label => label.name === MARK)!.description = 'Swarm 0f0f0f0f'
    await g.assigner.tick()
    expect(made(g)).toEqual([{ name: 'swarm:acme-tab', color: '5319e7', description: 'Swarm tab' }])
    expect(g.labelled()).toEqual([])
    // Refused: nothing is given, and it is said once.
    const h = setup([issue(1, ['size:s'])])
    h.github.state.labels = h.github.state.labels.filter(label => label.name !== MARK)
    const send = h.github.send
    h.github.send = (async (method, path, body) => path === '/repos/acme/app/labels' ? { status: 403, etag: null, body: {}, resetAt: null } : send(method, path, body)) as typeof send
    const refused = h.make()
    await refused.tick(); await refused.tick()
    expect(h.labelled()).toEqual([])
    expect(h.log.mock.calls.filter(([line]) => String(line).includes('SWARM_LABEL_NOT_MADE acme/app swarm:acme: GitHub answered 403'))).toHaveLength(1)
  })
  // What a pass read is counted for the project's PM and its people (pmNumbers.ts; anh Dee, 2026-11-11: "Numbers when work runs short").
  it('counts each pass: the builders with nothing after its plan, the tasks nobody holds, and what landed', async () => {
    const merged = new Date(Date.parse('2026-11-09T07:31:00Z') - 3_600_000).toISOString()
    const f = setup([issue(1, ['size:s', 'builder:pip', 'status:taken']), issue(2, ['size:m'])],
      { closed: [{ number: 9, pull_request: { merged_at: merged }, labels: [{ name: 'builder:pip' }], updated_at: merged }, issue(8, ['size:s', 'builder:juno'], { closed_at: merged, updated_at: merged })] })
    await f.assigner.tick()
    // Juno was given #2 this pass, so nobody is free and no task is open: one in hand before, one given.
    expect(f.labelled()).toEqual([[2, 'builder:juno']])
    expect(f.numbers.mock.calls).toEqual([[PROJECT, { builders: 2, free: [], open: 0, unsized: 0, held: 2, landed: 1, landedBy: [['Pip', 1]], closed: 1, more: false, activity: Date.parse(merged) }, expect.any(Function), expect.any(Function)]])
    // The project's goal is read from its default branch, and only when the numbers ask for it.
    f.github.state.files.set('agents/GOAL.md', '| Sync works | `npm test` |\n| Starts fast | `make start-time` |')
    f.github.state.checks = [{ id: 1, name: 'goal: Sync works', status: 'completed', conclusion: 'success' }]
    expect(f.github.state.asked.some(path => path.includes('GOAL.md') || path.includes('check-runs'))).toBe(false)
    expect(await f.numbers.mock.calls[0]![2]()).toEqual({ total: 2, passed: 1, failed: 0, waiting: 1 })
    // A landing more than a day old is the team's last, and no landing of the day: the pass counts from its own clock.
    const old = new Date(Date.parse('2026-11-09T07:31:00Z') - 30 * 3_600_000).toISOString()
    const g = setup([], { closed: [{ number: 9, pull_request: { merged_at: old }, labels: [{ name: 'builder:pip' }], updated_at: old }] })
    await g.assigner.tick()
    expect(g.numbers.mock.calls.at(-1)![1]).toMatchObject({ landed: 0, activity: Date.parse(old) })
  })
  // The day's scoreboard (scoreboard.ts; the allocator's design, package 1): what every later change to the allocator is judged by.
  it('hands the numbers the day\'s scoreboard, read from GitHub only when they ask for it, and says once a part GitHub does not give', async () => {
    const at = (minutes: number) => new Date(Date.parse('2026-11-09T07:31:00Z') - minutes * 60_000).toISOString()
    const landed = (number: number) => ({ number, created_at: at(120), closed_at: at(30), updated_at: at(30), pull_request: { merged_at: at(30) }, labels: [{ name: 'builder:pip' }] })
    const train = (title: string, merged: string | null) => ({ number: 20, title, author_association: 'MEMBER', closed_at: at(60), updated_at: at(60), pull_request: { merged_at: merged }, labels: [] })
    const f = setup([], { closed: [landed(9), landed(10), landed(11), train('Train, base moved: #9', null)] })
    for (const number of [9, 10, 11]) {
      f.github.state.comments.set(number, [{ body: 'Juno, 15:00: READ-OK f6edb44', author_association: 'MEMBER', created_at: at(100) }])
      f.github.state.changed.set(number, ['src/hub.ts', `src/own${number}.ts`])
    }
    await f.assigner.tick()
    // Nothing of it is read by the pass itself.
    expect(f.github.state.asked.some(path => path.includes('/files') || /\/issues\/\d+\/comments/.test(path))).toBe(false)
    const waited = 'Last 3 landed: 20 min from opened to a first verdict (median of 3), 70 min from the last READ-OK to landing (median of 3); '
      + 'none was told it was behind or in conflict. Trains: 0 landed, 1 closed without landing (base moved 1).'
    // With the files most landings touch, which the numbers keep for the merger (the allocator's design, package 8).
    expect(await f.numbers.mock.calls[0]![3]()).toEqual({ words: `${waited} Files touched most, of the last 3 landings: \`src/hub.ts\` 100%.`, hot: ['src/hub.ts'] })
    expect(f.github.state.asked.filter(path => path.includes('/files') || /\/issues\/\d+\/comments/.test(path))).toHaveLength(6)
    // The PM's own landed pull requests are the team's too.
    const g = setup([], { closed: [{ ...landed(9), labels: [{ name: 'builder:faye' }] }] })
    g.github.state.comments.set(9, [{ body: 'Juno, 15:00: READ-OK f6edb44', author_association: 'MEMBER', created_at: at(100) }])
    await g.assigner.tick()
    expect(await g.numbers.mock.calls[0]![3]()).toEqual({ words: 'Last 1 landed: 20 min from opened to a first verdict (median of 1), 70 min from the last READ-OK to landing (median of 1); '
      + 'none was told it was behind or in conflict.', hot: [] })
    // The closed list it read was full of the day's: there may be more trains than it held, and the words say so.
    const h = setup([], { closed: [train('Train: #9', at(60)), ...Array.from({ length: 99 }, (_, n) => issue(100 + n, [], { closed_at: at(60), updated_at: at(60) }))] })
    await h.assigner.tick()
    expect(h.numbers.mock.calls[0]![1]).toMatchObject({ more: true })
    expect(await h.numbers.mock.calls[0]![3]()).toEqual({ words: 'Trains, at least: 1 landed.', hot: [] })
    // A part GitHub does not give is left out, and said once in the log however often the day is posted. Files not read name none:
    // the numbers keep the ones they had.
    f.github.state.failing = /\/files$/
    expect(await f.numbers.mock.calls[0]![3]()).toEqual({ words: waited, hot: null })
    await f.numbers.mock.calls[0]![3]()
    expect(f.log.mock.calls.filter(([line]) => String(line).includes('SCOREBOARD_UNREAD'))).toEqual([['[super-tab] Task assignment: SCOREBOARD_UNREAD acme/app: its files: GitHub answered 500.']])
  })

  it('counts a builder with nothing when no task is open, when none can be given, and when the team has no builder', async () => {
    const f = setup([issue(1, ['size:s', 'builder:pip', 'status:taken'])])
    await f.assigner.tick()
    expect(f.numbers.mock.calls.at(-1)![1]).toMatchObject({ builders: 2, free: [{ id: 'juno', name: 'Juno' }], open: 0, held: 1 })
    // A task GitHub would not label for its builder was not given: its builder still has nothing, and the task is open.
    const g = setup([issue(2, ['size:m'])])
    g.github.state.labelAnswer = 403
    await g.assigner.tick()
    expect(g.numbers.mock.calls.at(-1)![1]).toMatchObject({ free: [{ id: 'juno', name: 'Juno' }, { id: 'pip', name: 'Pip' }], open: 1, held: 0 })
    const h = setup([issue(2, ['size:m']), issue(3, [])], { crew: { builders: [], machines: [] } })
    await h.assigner.tick()
    expect(h.numbers.mock.calls.at(-1)![1]).toMatchObject({ builders: 0, free: [], open: 1, unsized: 1, held: 0 })
  })
  it('counts what the PM landed under its name, a task given and not yet shown labelled as its builder\'s, and a spent builder as not free on any path', async () => {
    const merged = new Date(Date.parse('2026-11-09T07:31:00Z') - 3_600_000).toISOString()
    const f = setup([issue(2, ['size:m'])], { closed: [{ number: 9, pull_request: { merged_at: merged }, labels: [{ name: 'builder:faye' }], updated_at: merged }] })
    await f.assigner.tick()
    expect(f.numbers.mock.calls.at(-1)![1]).toMatchObject({ landedBy: [['Faye', 1]] })
    // GitHub's list does not show the label yet: the task is its builder's all the same, and that builder is not free.
    const given = f.labelled()[0]![1] === 'builder:juno' ? 'Juno' : 'Pip'
    await f.assigner.tick()
    expect(f.numbers.mock.calls.at(-1)![1].free.map(free => free.name)).toEqual([given === 'Juno' ? 'Pip' : 'Juno'])
    // Juno's subscription is spent: with nothing Harness can give, and with a task given this pass, Juno is still not counted as waiting.
    const resetsAt = new Date(Date.parse('2026-11-09T07:31:00Z') + 3 * 3_600_000).toISOString()
    const spent: Crew = { builders: [crew().builders[0]!, { ...crew().builders[1]!, machineId: 'spent' }],
      machines: [crew().machines[0]!, { machineId: 'spent', observation: { ...crew().machines[0]!.observation,
        quotas: [{ engine: 'claude', known: true, windows: [{ name: 'five_hour', usedPercent: 99, resetsAt }] }] } }] }
    const full = setup([issue(1, ['size:s', 'builder:pip', 'status:taken']), issue(2, ['size:s', 'builder:pip']), issue(3, ['size:s', 'needs:gpu'])], { crew: spent })
    await full.assigner.tick()
    expect(full.numbers.mock.calls.at(-1)![1]).toMatchObject({ free: [] })
    const giving = setup([issue(3, ['size:s'])], { crew: spent })
    await giving.assigner.tick()
    expect(giving.labelled()).toEqual([[3, 'builder:pip']])
    expect(giving.numbers.mock.calls.at(-1)![1]).toMatchObject({ free: [] })
  })

  // The assigner and the numbers together, as the daemon runs them (the fourth review: no test did, and one open task that no
  // free builder could take silenced the rule for every builder).
  it('tells the PM of builders that wait beside a task only another\'s machine can take', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assign-numbers-'))
    try {
      const sent: string[] = [], clock = { now: Date.parse('2026-11-09T07:31:00Z') }
      const mac = { resources: { memoryTotalBytes: 64 * GiB, projectDiskFreeBytes: 500 * GiB, os: 'macOS' } }
      const team: Crew = { builders: [{ id: 'pip', name: 'Pip', label: 'builder:pip', machineId: 'mac', engine: 'claude' }, { id: 'kai', name: 'Kai', label: 'builder:kai', machineId: 'linux', engine: 'claude' },
        { id: 'ada', name: 'Ada', label: 'builder:ada', machineId: 'linux', engine: 'codex' }],
      machines: [{ machineId: 'mac', observation: mac }, { machineId: 'linux', observation: { resources: { ...mac.resources, os: 'Linux' } } }] }
      const numbers = new PmNumbers({ file: join(dir, 'numbers.json'), now: () => clock.now, log: () => {}, send: async (_how, _project, _id, text) => { sent.push(text) } })
      // Pip has work to build; #9 needs a Mac, which only Pip has; Kai and Ada have nothing.
      const f = setup([issue(1, ['size:s', 'builder:pip', 'status:taken']), issue(2, ['size:s', 'builder:pip']), issue(9, ['size:s', 'needs:macos'])], { crew: team, numbers })
      for (let minute = 0; minute <= 16; minute++) { f.clock.now = clock.now += 60_000; await f.assigner.tick() }
      expect(f.labelled()).toEqual([])
      expect(sent).toEqual([expect.stringMatching(/^Harness, \d\d:\d\d: Ada and Kai have nothing to do, and the 1 sized task open was not given to them\. /)])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('counts as having nothing a builder whose one task waits on its pull request\'s readers, and not one whose subscription has no room', async () => {
    const f = setup([issue(14, ['size:s', 'builder:pip', 'status:taken'])])
    f.github.state.pulls = [{ number: 30, draft: false, base: { ref: 'main' }, head: { sha: 'f6edb44c0ffee0000000000000000000000000ab', ref: 'pip/14' },
      labels: [{ name: 'builder:pip' }], body: 'Closes #14' }]
    await f.assigner.tick()
    expect(f.numbers.mock.calls.at(-1)![1]).toMatchObject({ free: [{ id: 'juno', name: 'Juno' }, { id: 'pip', name: 'Pip' }], held: 1 })
    // A second task of Pip's in review leaves it with nothing to build still: it is counted as waiting for a task, and given
    // the one that opens (the allocator's design, package 2: two in review filled its list, and it was given nothing).
    f.github.state.open.push(issue(15, ['size:s', 'builder:pip', 'status:taken']))
    f.github.state.pulls.push({ number: 31, draft: false, base: { ref: 'main' }, head: { sha: 'a6edb44c0ffee0000000000000000000000000ab', ref: 'pip/15' },
      labels: [{ name: 'builder:pip' }], body: 'Closes #15' })
    await f.assigner.tick()
    expect(f.numbers.mock.calls.at(-1)![1].free.map(free => free.name)).toEqual(['Juno', 'Pip'])
    f.github.state.open.push(issue(16, ['size:s']))
    await f.assigner.tick()
    expect(f.labelled()).toEqual([[16, 'builder:pip']])
    expect(f.numbers.mock.calls.at(-1)![1].free.map(free => free.name)).toEqual(['Juno'])
    // Juno's subscription is spent until a reset three hours off: it is given nothing, and is not counted as waiting for work.
    const resetsAt = new Date(Date.parse('2026-11-09T07:31:00Z') + 3 * 3_600_000).toISOString()
    const g = setup([issue(1, ['size:s', 'builder:pip', 'status:taken'])], { crew: { builders: [crew().builders[0]!, { ...crew().builders[1]!, machineId: 'spent' }],
      machines: [crew().machines[0]!, { machineId: 'spent', observation: { ...crew().machines[0]!.observation,
        quotas: [{ engine: 'claude', known: true, windows: [{ name: 'five_hour', usedPercent: 99, resetsAt }] }] } }] } })
    await g.assigner.tick()
    expect(g.numbers.mock.calls.at(-1)![1]).toMatchObject({ builders: 2, free: [] })
  })
  it('gives each builder with nothing to build what it starts next, one task each, labelled, with one line of why', async () => {
    const f = setup([issue(1, ['size:s', 'p0']), issue(2, ['size:m', 'p1']), issue(3, ['size:m']), issue(4, ['size:m']), issue(5, ['size:m'])])
    await f.assigner.tick()
    const given = f.labelled()
    // The p0 and the p1 go first, one to each builder, which can start it now; the other three wait for a builder to be free.
    expect(given.map(([n]) => n).sort()).toEqual([1, 2])
    expect(given.map(([, label]) => label).sort()).toEqual(['builder:juno', 'builder:pip'])
    const why = new Map(f.said() as Array<[number, string]>)
    for (const number of [1, 2]) expect(why.get(number)).toMatch(/^Harness, \d\d:\d\d: for \*\*(Pip|Juno)\*\*: it can start now\.$/)
    expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/^\[super-tab\] gave acme\/app#1 to (Pip|Juno) \(it can start now\)$/))
  })

  // The allocator's design, package 2 (docs/design/2026-11-11-swarm-allocator): a change waiting for its read filled its builder's
  // list, so a builder with two in review was given nothing until one landed, and was not counted as having nothing; and a second
  // task was given ahead of the one in hand, which in the design's model cost up to a fifth of a heavy day.
  // The allocator's design, package 16: a builder whose own computer answers offers is offered its task on the Swarm's server, and
  // its computer takes it once it has room; nothing is written on GitHub for it until then.
  describe('offers', () => {
    /** Pip, whose computer answers offers; and Juno, on a computer from before them, when [juno]. */
    const offering = (juno = false): Crew => ({ builders: [{ id: 'pip', name: 'Pip', label: 'builder:pip', machineId: 'mac', engine: 'claude', offers: true },
      ...juno ? [{ id: 'juno', name: 'Juno', label: 'builder:juno', machineId: 'old', engine: 'claude' }] : []],
      machines: [{ machineId: 'mac', observation: { resources: { memoryTotalBytes: 64 * GiB, projectDiskFreeBytes: 500 * GiB } } },
        { machineId: 'old', observation: { resources: { memoryTotalBytes: 64 * GiB, projectDiskFreeBytes: 500 * GiB } } }] })

    it('offers a task to a builder whose computer answers offers, writes nothing on GitHub, and offers it nobody else while it holds', async () => {
      const f = setup([issue(1, ['size:s'])], { crew: offering() })
      await f.assigner.tick()
      expect(f.server.state.offered).toEqual([[1, 'pip']])
      expect(f.log).toHaveBeenCalledWith('[super-tab] offered acme/app#1 to Pip (it can start now)')
      expect([f.labelled(), f.said()]).toEqual([[], []])
      // Held by its live offer, it is the builder's: nothing more is offered while it lasts, and the numbers counted it as given.
      expect(f.numbers.mock.calls[0]![1]).toMatchObject({ free: [] })
      f.clock.now += 60_000
      await f.assigner.tick()
      expect(f.server.state.offered).toEqual([[1, 'pip']])
      // Read from no list (the server did not answer), the task it offered a moment ago is still the builder's.
      f.server.state.down = true
      f.clock.now += 30_000
      await f.assigner.tick()
      expect(f.server.offers.offer).toHaveBeenCalledOnce()
      expect(f.log).toHaveBeenCalledWith('[super-tab] Task assignment: OFFER_FAILED acme/app: BACKEND_UNAVAILABLE')
    })

    it('gives by label beside it to a builder whose computer does not answer offers', async () => {
      const f = setup([issue(1, ['size:s']), issue(2, ['size:s'])], { crew: offering(true) })
      await f.assigner.tick()
      expect(f.server.state.offered).toHaveLength(1)
      expect(f.labelled()).toHaveLength(1)
      expect([f.server.state.offered[0]![1], f.labelled()[0]![1]]).toEqual(['pip', 'builder:juno'])
    })

    // Review of #4152: the project's offers are read by the tasks its PM plans, a hundred a read, not by a cap of two hundred.
    it('asks the server about the sized tasks it plans, free or held by a builder that answers offers, and no other', async () => {
      const f = setup([issue(1, ['size:s']), issue(2, ['size:m', 'builder:pip', 'status:taken']), issue(3, ['size:s', 'builder:juno']), issue(4, []),
        issue(5, ['size:l'], { pull_request: {} })], { crew: offering(true) })
      await f.assigner.tick()
      expect(f.server.state.asked).toEqual([[1, 2]])
      // Nothing it plans: nothing is asked.
      const g = setup([issue(4, [])], { crew: offering() })
      await g.assigner.tick()
      expect(g.server.offers.listed).not.toHaveBeenCalled()
    })

    it('rests a builder that declined or let an offer lapse, ten minutes doubling to two hours, and ends the rest when it took one', async () => {
      const f = setup([issue(1, ['size:s'])], { crew: offering() })
      const offers = () => f.server.state.offered.length
      await f.assigner.tick()
      f.server.decline(1, 'memory')
      await f.assigner.tick()
      expect(f.log).toHaveBeenCalledWith('[super-tab] Pip declined acme/app#1 (memory): offered nothing for 10 min')
      expect(offers()).toBe(1)
      f.clock.now += 10 * 60_000 - 1
      await f.assigner.tick()
      expect(offers()).toBe(1)
      f.clock.now += 1
      await f.assigner.tick()
      expect(offers()).toBe(2)
      // Unanswered, it lapses: twenty minutes.
      f.clock.now += 2 * 60_000
      await f.assigner.tick()
      expect(f.log).toHaveBeenCalledWith('[super-tab] Pip let the offer of acme/app#1 lapse: offered nothing for 20 min')
      f.clock.now += 20 * 60_000
      await f.assigner.tick()
      expect(offers()).toBe(3)
      for (const minutes of [40, 80, 120, 120]) {
        f.clock.now += 2 * 60_000
        await f.assigner.tick()
        expect(f.log).toHaveBeenCalledWith(`[super-tab] Pip let the offer of acme/app#1 lapse: offered nothing for ${minutes} min`)
        f.clock.now += minutes * 60_000
        await f.assigner.tick()
      }
      // Accepted and taken, its rest is over: the next lapse rests it ten minutes again.
      f.server.accept(1)
      f.github.state.open[0] = issue(1, ['size:s', 'builder:pip', 'status:taken'])
      await f.assigner.tick()
      f.clock.now += 10 * 60_000
      await f.assigner.tick()
      expect(f.log.mock.calls.filter(([line]) => String(line).includes('offered nothing'))).toHaveLength(6)
      f.github.state.open[0] = issue(1, ['size:s'])
      f.server.records.delete(1)
      await f.assigner.tick()
      f.clock.now += 2 * 60_000
      await f.assigner.tick()
      expect(f.log).toHaveBeenLastCalledWith('[super-tab] Pip let the offer of acme/app#1 lapse: offered nothing for 10 min')
    })

    // Review of #4153: an accept ended the rest, so an agent that accepted every offer and took none was offered its task every
    // twenty minutes, about 72 times a day.
    it('offers a builder that accepts and never takes its task a bounded number of times a day', async () => {
      const f = setup([issue(1, ['size:s'])], { crew: offering() })
      for (let minute = 0; minute < 24 * 60; minute++) {
        await f.assigner.tick()
        // Its computer accepts every offer at once, and its agent never takes it.
        if (f.server.records.get(1) && !f.server.records.get(1)!.acceptedAt && f.server.records.get(1)!.expiresAt > f.clock.now) f.server.accept(1)
        f.clock.now += 60_000
      }
      // 0, 20, 50, 100 and 190 minutes, then every 130: fourteen in the day.
      expect(f.server.state.offered).toHaveLength(14)
      expect([f.labelled(), f.said()]).toEqual([[], []])
    })

    it('rests nobody for an offer taken: the server never hears of a take, and its offer lapses with the task its builder\'s', async () => {
      const f = setup([issue(1, ['size:s'])], { crew: offering() })
      await f.assigner.tick()
      f.server.accept(1)
      f.github.state.open[0] = issue(1, ['size:s', 'builder:pip', 'status:taken'])
      f.clock.now += 10 * 60_000
      await f.assigner.tick()
      expect(f.log.mock.calls.filter(([line]) => String(line).includes('offered nothing'))).toEqual([])
    })

    it('moves no task given by label for a builder resting from offers', async () => {
      // Juno, on a computer from before offers, was given #15 by label twenty minutes ago and has not taken it; Pip rests.
      const f = setup([issue(1, ['size:s']), issue(15, ['size:m', 'builder:juno'])], { crew: offering(true) })
      f.github.state.comments.set(15, [{ body: 'Harness, 07:11: for **Juno**: it can start now.', author_association: 'MEMBER', user: { login: 'pm-person' },
        created_at: '2026-11-09T07:11:00Z' }])
      f.github.state.open[0] = issue(1, ['size:s', 'builder:juno', 'status:taken'])
      f.server.records.set(2, { agentId: 'pip', offeredAt: f.clock.now - 60_000, expiresAt: f.clock.now - 1, declined: 'memory' })
      f.github.state.open.push(issue(2, ['size:s']))
      await f.assigner.tick()
      expect(f.log).toHaveBeenCalledWith('[super-tab] Pip declined acme/app#2 (memory): offered nothing for 10 min')
      expect(f.github.sent.filter(s => s.method === 'DELETE')).toEqual([])
      // Rested no more, it has nothing, and #15 goes back for it.
      f.clock.now += 10 * 60_000
      await f.assigner.tick()
      expect(f.github.sent.filter(s => s.method === 'DELETE').map(s => s.path)).toEqual(['/repos/acme/app/issues/15/labels/builder%3Ajuno',
        '/repos/acme/app/issues/15/labels/status%3Ataken'])
    })

    it('reads a task a live offer holds as its agent\'s, though this daemon did not make it (a restart, another coordinator)', async () => {
      const f = setup([issue(1, ['size:s']), issue(2, ['size:s'])], { crew: offering() })
      f.server.records.set(1, { agentId: 'pip', offeredAt: f.clock.now - 60_000, expiresAt: f.clock.now + 60_000 })
      await f.assigner.tick()
      // Pip builds #1 on its offer: nothing more is offered to it.
      expect(f.server.state.offered).toEqual([])
      expect(f.numbers.mock.calls[0]![1]).toMatchObject({ free: [], open: 1 })
    })

    // Review of #4153: a live offer the PM did not see (its read failed, after a restart; or another agent's it is refused on)
    // opened the label path for the same task to a builder on a CLI from before.
    it('leaves out of the plan a task another agent\'s offer holds, and gives it nobody by label meanwhile', async () => {
      // The task needs docker, which only Juno's computer (from before offers) has: given it, it would go to Juno by label.
      const docker: Crew = { ...offering(true), machines: [offering().machines[0]!, { machineId: 'old', observation: { tools: { docker: true },
        resources: { memoryTotalBytes: 64 * GiB, projectDiskFreeBytes: 500 * GiB } } }] }
      const f = setup([issue(1, ['size:s', 'needs:docker'])], { crew: docker })
      f.server.records.set(1, { agentId: 'someone', offeredAt: f.clock.now, expiresAt: f.clock.now + 120_000 })
      await f.assigner.tick()
      f.clock.now += 1_000
      await f.assigner.tick()
      expect([f.server.state.offered, f.labelled()]).toEqual([[], []])
      // Once that offer ends, Juno is given it.
      f.clock.now += 120_000
      await f.assigner.tick()
      expect(f.labelled()).toEqual([[1, 'builder:juno']])
      // Refused on one it did not see (made after its read): out of the plan for as long as an offer can hold it.
      const g = setup([issue(1, ['size:s'])], { crew: offering(true) })
      g.server.offers.offer.mockRejectedValueOnce(new SuperTabHostError('OFFER_LIVE', 'This task is offered to another agent.', 409))
      for (let minute = 0; minute < 12; minute++) {
        await g.assigner.tick()
        g.clock.now += 60_000
      }
      expect(g.labelled()).toEqual([])
      expect(g.log.mock.calls.filter(([line]) => String(line).includes('OFFER_FAILED'))).toEqual([['[super-tab] Task assignment: OFFER_FAILED acme/app#1: OFFER_LIVE']])
      await g.assigner.tick()
      expect(g.server.state.offered.length + g.labelled().length).toBe(1)
    })

    // Review of #4153: a task held by an offer to an agent outside the crew was taken out of what the plan reads, so a task that
    // comes after it was planned as if it were closed, and given before it.
    it('keeps a task another agent\'s offer holds open for a task that comes after it', async () => {
      const f = setup([issue(1, ['size:s']), issue(2, ['size:s'], { body: 'After #1.' })], { crew: offering() })
      f.server.records.set(1, { agentId: 'someone', offeredAt: f.clock.now, expiresAt: f.clock.now + 120_000 })
      await f.assigner.tick()
      expect([f.server.state.offered, f.labelled()]).toEqual([[], []])
    })

    // Review of #4153: a later project's PM on the same repository offered every pass and was refused, with no end, and its person
    // heard only that there was nothing to do.
    it('offers nothing for ten minutes once another project\'s PM gives the repository\'s tasks, and says so once to its person', async () => {
      const f = setup([issue(1, ['size:s'])], { crew: offering(true) })
      f.server.state.elsewhere = true
      for (let minute = 0; minute < 60; minute++) {
        await f.assigner.tick()
        f.clock.now += 60_000
      }
      // A read each ten minutes, no offer, nothing by label (another PM gives these tasks), and one line to its person, under an
      // operation the server takes once, so a restart says it no more.
      expect(f.server.offers.listed).toHaveBeenCalledTimes(6)
      expect([f.server.offers.offer.mock.calls, f.labelled()]).toEqual([[], []])
      expect(f.say.mock.calls).toEqual([[PROJECT, expect.stringMatching(/^offers-elsewhere-[0-9a-f]{40}$/),
        'Another project\'s PM gives acme/app\'s tasks in this Swarm, so I give none of them.']])
      expect(f.make()).toBeDefined()
      // Readable, its offers alone refused: the same.
      const g = setup([issue(1, ['size:s'])], { crew: offering() })
      Object.assign(g.server.state, { elsewhere: true, unreadable: false })
      for (let minute = 0; minute < 11; minute++) {
        await g.assigner.tick()
        g.clock.now += 60_000
      }
      expect(g.server.offers.offer).toHaveBeenCalledTimes(2)
      expect(g.say).toHaveBeenCalledOnce()
      // Its person told already, a line it could not say is logged and the pass goes on.
      const h = setup([issue(1, ['size:s'])], { crew: offering() })
      h.server.state.elsewhere = true
      h.say.mockRejectedValueOnce(new SuperTabHostError('BACKEND_UNAVAILABLE', 'No answer.', 503))
      await h.assigner.tick()
      expect(h.log).toHaveBeenCalledWith('[super-tab] Task assignment: ELSEWHERE_UNSAID acme/app: BACKEND_UNAVAILABLE')
    })

    it('gives nothing by label in a pass that could not read its offers', async () => {
      const f = setup([issue(1, ['size:s']), issue(2, ['size:s'])], { crew: offering(true) })
      f.server.state.down = true
      await f.assigner.tick()
      expect(f.labelled()).toEqual([])
      expect(f.log).toHaveBeenCalledWith('[super-tab] Task assignment: OFFER_FAILED acme/app: BACKEND_UNAVAILABLE')
      f.server.state.down = false
      await f.assigner.tick()
      expect(f.labelled()).toEqual([[expect.any(Number), 'builder:juno']])
    })

    it('gives by label while the server has no offers, and asks it again ten minutes on', async () => {
      const f = setup([issue(1, ['size:s']), issue(2, ['size:s'])], { crew: offering() })
      f.server.state.missing = true
      await f.assigner.tick()
      expect(f.labelled()).toEqual([[1, 'builder:pip']])
      expect(f.server.offers.offer).not.toHaveBeenCalled()
      expect(f.log).toHaveBeenCalledWith('[super-tab] Task assignment: NO_OFFERS: this Swarm\'s server takes no offers, so tasks are given by label')
      expect(f.server.offers.listed).toHaveBeenCalledOnce()
      // An offer refused so (a server rolled back between its read and the offer) goes by label at once.
      const g = setup([issue(1, ['size:s'])], { crew: offering() })
      g.server.offers.offer.mockRejectedValueOnce(new SuperTabHostError('BACKEND_UNAVAILABLE', 'Route not found', 404))
      await g.assigner.tick()
      expect(g.labelled()).toEqual([[1, 'builder:pip']])
      expect(g.server.offers.listed).toHaveBeenCalledOnce()
      f.server.state.missing = false
      f.clock.now += 10 * 60_000 - 1
      await f.assigner.tick()
      expect(f.server.offers.listed).toHaveBeenCalledOnce()
      f.clock.now += 1
      await f.assigner.tick()
      expect(f.server.offers.listed).toHaveBeenCalledTimes(2)
    })
  })

  describe('one task building, at most four open', () => {
    /** Pip builds alone, so what it is given, or not, is the rule's own doing. */
    const alone: Crew = { builders: [crew().builders[0]!], machines: crew().machines }
    const head = (n: number) => `${(0xf6edb40 + n).toString(16)}${'0'.repeat(33)}`
    const taken = (n: number) => issue(n, ['size:m', 'builder:pip', 'status:taken'])
    /** Pip's pull request for task [n], not a draft, into main: it waits for its read. */
    const up = (n: number, extra: Json = {}): Json => ({ number: 100 + n, draft: false, base: { ref: 'main' }, head: { sha: head(n), ref: `pip/${n}` },
      labels: [{ name: 'builder:pip' }], body: `Closes #${n}`, ...extra })
    const given = (f: ReturnType<typeof setup>) => f.said().filter(([, body]) => /^Harness, \d\d:\d\d: for \*\*/.test(String(body))).map(([n, body]) => [n, String(body).replace(/^Harness, \d\d:\d\d: /, '')])

    // The fault's own test: on the allocator before this, nothing was given.
    it('gives a builder whose two tasks wait on their pull requests\' reads the free task, to start now', async () => {
      const f = setup([taken(14), taken(15), issue(16, ['size:s'])], { crew: alone })
      f.github.state.pulls = [up(14), up(15)]
      await f.assigner.tick()
      expect(f.labelled()).toEqual([[16, 'builder:pip']])
      // Nothing of what is in review is its work now: the line that gives the task says so truly.
      expect(given(f)).toEqual([[16, 'for **Pip**: it can start now.']])
      // Its two in review and the one given are all it holds; with the task given it has something to do.
      expect(f.numbers.mock.calls.at(-1)![1]).toMatchObject({ free: [], open: 0, held: 3 })
    })

    it('gives nothing to a builder with a task still its own to build: given, taken with no pull request, with a draft, or with a HOLD on its head', async () => {
      const building: Array<[string, Json, Json[], Json[]]> = [
        ['given and not taken', issue(14, ['size:m', 'builder:pip']), [], []],
        ['taken, with no pull request', taken(14), [], []],
        ['a draft', taken(14), [up(14, { draft: true })], []],
        ['a HOLD on its head', taken(14), [up(14)], [{ body: `Faye, 07:10, to **Pip**: HOLD ${head(14).slice(0, 7)} app.ts:3 add the test`, created_at: '2026-11-09T07:10:00Z', author_association: 'OWNER' }]],
      ]
      for (const [what, task, pulls, comments] of building) {
        const f = setup([task, issue(16, ['size:s'])], { crew: alone })
        f.github.state.pulls = pulls
        f.github.state.comments.set(114, comments)
        await f.assigner.tick()
        expect(f.labelled(), what).toEqual([])
        // Not counted as waiting for a task either: it has one.
        expect(f.numbers.mock.calls.at(-1)![1], what).toMatchObject({ free: [], open: 1, held: 1 })
      }
    })

    it('gives a builder one task a pass, and the next only once the first is up for its read', async () => {
      const f = setup([issue(1, ['size:s', 'p0']), issue(2, ['size:s', 'p1']), issue(3, ['size:s'])], { crew: alone })
      f.github.state.applied = true
      await f.assigner.tick()
      expect(f.labelled()).toEqual([[1, 'builder:pip']])
      // Given and not taken, then taken, then a draft: still the one it builds, pass after pass.
      await f.assigner.tick()
      f.github.state.open[0] = taken(1)
      await f.assigner.tick()
      f.github.state.pulls = [up(1, { draft: true })]
      await f.assigner.tick()
      expect(f.labelled()).toEqual([[1, 'builder:pip']])
      // Its pull request is up: the next task is given in that pass, to start now.
      f.github.state.pulls = [up(1)]
      await f.assigner.tick()
      expect(f.labelled()).toEqual([[1, 'builder:pip'], [2, 'builder:pip']])
      expect(given(f).at(-1)).toEqual([2, 'for **Pip**: it can start now.'])
    })

    it('gives nothing more to a builder with four open, all in review, and does not count it as waiting for a task', async () => {
      const f = setup([taken(11), taken(12), taken(13), issue(16, ['size:s'])], { crew: alone })
      f.github.state.pulls = [up(11), up(12), up(13)]
      f.github.state.applied = true
      await f.assigner.tick()
      // Three in review: there is room for a fourth.
      expect(f.labelled()).toEqual([[16, 'builder:pip']])
      f.github.state.open[3] = taken(16)
      f.github.state.pulls.push(up(16))
      f.github.state.open.push(issue(17, ['size:s']))
      await f.assigner.tick()
      expect(f.labelled()).toEqual([[16, 'builder:pip']])
      // Its PM cannot end that wait by opening tasks, so it is not told of it.
      expect(f.numbers.mock.calls.at(-1)![1]).toMatchObject({ free: [], open: 1, held: 4 })
    })

  })

  // The allocator's design, package 11 (docs/design/2026-11-11-swarm-allocator/one-view.md, option (a)): every regular agent builds
  // for every public project of its Swarm, and each project's plan read only its own repository, so an agent of a Swarm of three
  // public projects was given a task building by each.
  describe('one task building across the Swarm\'s projects', () => {
    const alone: Crew = { builders: [crew().builders[0]!], machines: crew().machines }
    const SWARM = async () => ['acme/app', 'acme/web']
    /** A builder's own open list in another repository, as read: its issues and pull requests that carry its label. */
    const listOf = (repo: string, label: string) => `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`
    const asked = (f: ReturnType<typeof setup>, repo: string, label = 'builder:pip') => f.github.state.asked.filter(path => path === listOf(repo, label)).length
    const answered = (f: ReturnType<typeof setup>, repo: string, label = 'builder:pip') => f.github.state.replies.filter(([path]) => path === listOf(repo, label)).map(([, status]) => status)
    const taken = (n: number, size = 'm') => issue(n, [`size:${size}`, 'builder:pip', 'status:taken'])
    const pullFor = (n: number, extra: Json = {}): Json => issue(100 + n, ['builder:pip'], { pull_request: {}, draft: false, body: `Closes #${n}`, ...extra })
    const minutes = async (f: ReturnType<typeof setup>, count: number) => { for (let minute = 0; minute < count; minute++) { f.clock.now += 60_000; await f.assigner.tick() } }

    // Review of #4144: read for every builder with room each pass, a Swarm of twelve builders and ten other projects asked GitHub
    // 120 times a pass in its person's name. A builder's lists elsewhere are read only as a task is about to be given to it.
    it('reads a builder\'s lists elsewhere only as it is about to be given a task, and gives the task to another while it builds there', async () => {
      const f = setup([issue(16, ['size:s', 'part:api'])], { repositories: SWARM })
      // Pip works on the task's area, so the plan gives it to Pip first; Pip builds a task in the other project.
      f.github.state.files.set('agents/Pip.md', 'Works on: api')
      f.github.state.elsewhere.set('acme/web', [taken(3)])
      await f.assigner.tick()
      expect([f.labelled(), asked(f, 'acme/web'), asked(f, 'acme/web', 'builder:juno')]).toEqual([[], 1, 0])
      // The next pass Pip counts as building there, and is not read again: the task goes to Juno, read just before it is given.
      await minutes(f, 1)
      expect([f.labelled(), asked(f, 'acme/web'), asked(f, 'acme/web', 'builder:juno')]).toEqual([[[16, 'builder:juno']], 1, 1])
      // Nothing to give, nothing read; nor for a team with no builder, which reads not even the Swarm.
      const swarm = vi.fn(SWARM)
      const g = setup([], { repositories: swarm })
      await g.assigner.tick()
      const h = setup([issue(16, ['size:s'])], { crew: { builders: [], machines: [] }, repositories: swarm })
      await h.assigner.tick()
      expect([swarm.mock.calls.length, [...g.github.state.asked, ...h.github.state.asked].filter(path => path.startsWith('/repos/acme/web/')).length]).toEqual([0, 0])
    })

    it('reads a builder found building elsewhere again fifteen minutes on, with its ETag, and gives it the task once that task\'s pull request is up', async () => {
      const f = setup([issue(16, ['size:s'])], { crew: alone, repositories: SWARM })
      f.github.state.elsewhere.set('acme/web', [taken(3)])
      await f.assigner.tick()
      // A middle task it took keeps it busy for forty-five minutes in the plan; for fifteen it is not read, given nothing, nor
      // counted as waiting.
      await minutes(f, 14)
      expect([f.labelled(), answered(f, 'acme/web'), f.numbers.mock.calls.at(-1)![1].free]).toEqual([[], [200], []])
      await minutes(f, 1)
      expect(answered(f, 'acme/web')).toEqual([200, 304])
      // Its pull request goes up there: the next read, fifteen minutes on, finds it with nothing to build there, and it is given the task.
      f.github.state.elsewhere.set('acme/web', [taken(3), pullFor(3)])
      await minutes(f, 15)
      expect([answered(f, 'acme/web'), f.labelled()]).toEqual([[200, 304, 200], [[16, 'builder:pip']]])
    })

    // Review of #4144: read again only when the plan's estimate ran out, a builder only given a large task elsewhere, which it
    // finished in eight minutes, sat with nothing beside free tasks until the four hours of that estimate were over.
    it('gives a builder that finishes early elsewhere a task here within fifteen minutes', async () => {
      const f = setup([issue(16, ['size:s'])], { crew: alone, repositories: SWARM })
      f.github.state.elsewhere.set('acme/web', [issue(3, ['size:l', 'builder:pip'])])
      await f.assigner.tick()
      await minutes(f, 8)
      f.github.state.elsewhere.set('acme/web', [])
      await minutes(f, 6)
      expect(f.labelled()).toEqual([])
      await minutes(f, 1)
      expect(f.labelled()).toEqual([[16, 'builder:pip']])
    })

    // A project whose merger is off keeps its builders' pull requests waiting for ever: counted against a builder's four everywhere,
    // they would cap it in every other project too (review of #4144). Each project counts its own four, as before.
    it('counts no task that waits for its read in another project against a builder\'s four here', async () => {
      const f = setup([taken(11), taken(12), taken(13), issue(16, ['size:s'])], { crew: alone, repositories: SWARM })
      f.github.state.pulls = [11, 12, 13].map(n => ({ ...pullFor(n), number: 100 + n, base: { ref: 'main' }, head: { sha: `${(0xf6edb40 + n).toString(16)}${'0'.repeat(33)}`, ref: `pip/${n}` } }))
      f.github.state.elsewhere.set('acme/web', [taken(3), taken(4), issue(23, ['builder:pip'], { pull_request: {}, draft: false, body: 'Closes #3 and fixes #4' })])
      await f.assigner.tick()
      expect(f.labelled()).toEqual([[16, 'builder:pip']])
    })

    // GitHub reads a comma in `labels` as "and", so a builder whose name has one had an empty list there for ever.
    it('reads a builder whose label has a comma among the repository\'s newest open items, as a claim looks for one', async () => {
      const comma: Crew = { builders: [{ id: 'pj', name: 'Pip, Jr', label: 'builder:pip,-jr', machineId: 'mac', engine: 'claude' }], machines: crew().machines }
      const f = setup([issue(16, ['size:s'])], { crew: comma, repositories: SWARM })
      f.github.state.elsewhere.set('acme/web', [issue(2, ['size:s', 'builder:pip']), issue(3, ['size:m', 'builder:pip,-jr', 'status:taken'])])
      await f.assigner.tick()
      expect([f.labelled(), f.github.state.asked.filter(path => path.startsWith('/repos/acme/web/issues?'))]).toEqual([[], ['/repos/acme/web/issues?state=open&per_page=100']])
    })

    it('takes back no task for a builder that has nothing here but builds in another project', async () => {
      const at = new Date(Date.parse('2026-11-09T07:31:00Z') - 11 * 60_000).toISOString()
      // Juno was given #5 eleven minutes ago and has not taken it; Pip has nothing here, and builds a task in the other project.
      const f = setup([issue(5, ['size:s', 'builder:juno'])], { repositories: SWARM })
      f.github.state.comments.set(5, [{ body: 'Harness, 07:20: for **Juno**: it can start now.', author_association: 'MEMBER', created_at: at }])
      f.github.state.elsewhere.set('acme/web', [taken(3)])
      await f.assigner.tick()
      expect([f.github.sent.filter(s => s.method === 'DELETE'), asked(f, 'acme/web')]).toEqual([[], 1])
      // With nothing there, it goes back for Pip, as before.
      const g = setup([issue(5, ['size:s', 'builder:juno'])], { repositories: SWARM })
      g.github.state.comments.set(5, [{ body: 'Harness, 07:20: for **Juno**: it can start now.', author_association: 'MEMBER', created_at: at }])
      g.github.state.elsewhere.set('acme/web', [])
      await g.assigner.tick()
      expect(g.github.sent.filter(s => s.method === 'DELETE').map(s => s.path)).toEqual(['/repos/acme/app/issues/5/labels/builder%3Ajuno', '/repos/acme/app/issues/5/labels/status%3Ataken'])
    })

    it('counts a builder as building nothing in a repository this login cannot read, says so once, and asks it again only after a wait', async () => {
      const f = setup([issue(16, ['size:s'])], { crew: alone, repositories: async () => ['acme/app', 'acme/secret'] })
      f.github.state.elsewhere.set('acme/secret', null)
      await f.assigner.tick()
      expect(f.labelled()).toEqual([[16, 'builder:pip']])
      const said = (g: ReturnType<typeof setup>) => g.log.mock.calls.filter(([line]) => String(line).includes('acme/secret'))
      expect(said(f)).toEqual([['[super-tab] Task assignment: UNREADABLE acme/secret: this computer\'s gh login cannot read acme/secret. acme/app\'s builders count as building nothing there.']])
      // GitHub refusing the label keeps the task free, so each pass is about to give it to Pip again: asked again ten minutes on,
      // not each pass, and not said again; left alone longer each time, to a quarter of an hour; once read again, a new failure
      // waits ten minutes, not the longest.
      const g = setup([issue(16, ['size:s'])], { crew: alone, repositories: async () => ['acme/app', 'acme/secret'] })
      g.github.state.labelAnswer = 403
      g.github.state.elsewhere.set('acme/secret', null)
      const asks = async (count: number) => {
        const before = asked(g, 'acme/secret')
        for (let minute = 0; minute < count; minute++) { await g.assigner.tick(); g.clock.now += 60_000 }
        return asked(g, 'acme/secret') - before
      }
      expect(await asks(11)).toBe(2)
      expect(await asks(60)).toBe(5)
      // Readable again: read as its wait ends, and each pass from then on.
      g.github.state.elsewhere.set('acme/secret', [])
      expect(await asks(15)).toBe(6)
      g.github.state.elsewhere.set('acme/secret', null)
      expect([await asks(1), await asks(10)]).toEqual([1, 1])
      expect(said(g)).toHaveLength(1)
      // GitHub failing on its own side stops the pass, as for the project's own repository: nothing is given on a count it lacks.
      const h = setup([issue(16, ['size:s'])], { crew: alone, repositories: SWARM })
      h.github.state.elsewhere.set('acme/web', [])
      h.github.state.failing = /^\/repos\/acme\/web\/issues$/
      await h.assigner.tick()
      expect(h.labelled()).toEqual([])
      expect(h.log).toHaveBeenCalledWith('[super-tab] Task assignment stopped · GH_FAILED GitHub answered 500.')
    })

    // Review of #4144: a Swarm that could not be read stopped the whole project's pass, and its repository's kept answers went.
    it('counts nothing in the Swarm\'s other projects while the Swarm cannot be read, says so once, and plans the project all the same', async () => {
      const unread = async (): Promise<string[]> => { throw new Error('The backend did not answer.') }
      const f = setup([issue(16, ['size:s'])], { crew: alone, repositories: unread })
      await f.assigner.tick()
      expect(f.labelled()).toEqual([[16, 'builder:pip']])
      // GitHub refusing the label keeps the task free: each pass is about to give it again, and the Swarm is asked each time.
      const g = setup([issue(16, ['size:s'])], { crew: alone, repositories: unread })
      g.github.state.labelAnswer = 403
      await g.assigner.tick()
      await g.assigner.tick()
      expect(g.log.mock.calls.filter(([line]) => String(line).includes('SWARM_UNREAD')))
        .toEqual([['[super-tab] Task assignment: SWARM_UNREAD acme/app: The backend did not answer. Its builders count as building nothing in the Swarm\'s other projects.']])
      // The pass ran through: its own list's answer was kept, so the next read of it is a 304.
      expect(g.github.state.replies.filter(([path]) => path === '/repos/acme/app/issues?state=open&per_page=100').map(([, status]) => status)).toEqual([200, 304])
      expect(g.log.mock.calls.some(([line]) => String(line).includes('Task assignment stopped'))).toBe(false)
    })

    it('reads ten of the Swarm\'s other projects at most, and says once that there are more', async () => {
      const others = Array.from({ length: 12 }, (_, i) => `acme/p${i}`)
      const f = setup([issue(16, ['size:s'])], { crew: alone, repositories: async () => ['acme/app', ...others, 'acme/app'] })
      for (const repo of others) f.github.state.elsewhere.set(repo, [])
      // Pip builds a task in the eleventh: past the ten read, it counts as building nothing there.
      f.github.state.elsewhere.set('acme/p10', [taken(3)])
      await f.assigner.tick()
      expect(others.map(repo => asked(f, repo))).toEqual([...Array<number>(10).fill(1), 0, 0])
      // All ten at once, so two PMs' plans race for one builder within one round trip, not ten.
      expect(f.github.state.most).toBe(10)
      expect(f.labelled()).toEqual([[16, 'builder:pip']])
      expect(f.log.mock.calls.filter(([line]) => String(line).includes('OTHER_PROJECTS')))
        .toEqual([['[super-tab] Task assignment: OTHER_PROJECTS acme/app: of the Swarm\'s 12 other projects, the first 10 are read for what its builders build']])
      // Ten are all read, and nothing is said.
      const g = setup([issue(16, ['size:s'])], { crew: alone, repositories: async () => ['acme/app', ...others.slice(0, 10)] })
      for (const repo of others) g.github.state.elsewhere.set(repo, [])
      await g.assigner.tick()
      expect([others.filter(repo => asked(g, repo)).length, g.log.mock.calls.some(([line]) => String(line).includes('OTHER_PROJECTS'))]).toEqual([10, false])
    })

    it('reads the Swarm\'s repositories as its PM\'s person reads them: each once, in its order, none of a closed tab\'s project', () => {
      const project = (url: unknown, extra: Json = {}) => ({ repository: { repositoryUrl: url }, ...extra })
      expect(swarmRepositories({ projects: [project('https://github.com/Acme/App'), project('git@github.com:acme/web.git'), project('https://github.com/acme/app.git'),
        project('https://github.com/acme/old', { archived: true }), project(null), project('https://gitlab.com/acme/x'), { name: 'no repository' }] }))
        .toEqual(['acme/app', 'acme/web'])
      expect(swarmRepositories({})).toEqual([])
    })

    // A Personal Swarm's project made from a pane's folder has no address to clone, only the GitHub repository Desktop named for it
    // (backend commands.ts project.github): what its builders build counts as a cloned project's does.
    it('reads the GitHub repository a project was given when its folder has no address', () => {
      expect(swarmRepositories({ projects: [{ repository: { repositoryUrl: null }, githubRepository: 'Acme/Pane' }, { githubRepository: 'acme/web' },
        { repository: { repositoryUrl: 'https://github.com/acme/app' }, githubRepository: 'acme/app' }, { githubRepository: 'acme/old', archived: true }] }))
        .toEqual(['acme/pane', 'acme/web', 'acme/app'])
    })
  })

  // The allocator's design, package 3: a task that says "after #B" was given as soon as #B was taken, before #B had any code; and
  // of #1 and #2 "after #1", both free, with two builders, both were given in one pass.
  describe('a task that comes after another', () => {
    const head = (n: number) => `${(0xa6edb40 + n).toString(16)}${'0'.repeat(33)}`
    /** [builder]'s pull request for task [n], into main. */
    const pullFor = (n: number, builder: string, extra: Json = {}): Json => ({ number: 100 + n, draft: false, base: { ref: 'main' }, head: { sha: head(n), ref: `${builder}/${n}` },
      labels: [{ name: `builder:${builder}` }], body: `Closes #${n}`, author_association: 'MEMBER', ...extra })
    const lines = (f: ReturnType<typeof setup>, number: number) => f.said().filter(([n]) => n === number).map(([, body]) => String(body).replace(/^Harness, \d\d:\d\d: /, ''))

    it('is given once what it comes after has its pull request up, only to that builder, with the branch to build it on', async () => {
      const f = setup([issue(1, ['size:s']), issue(2, ['size:s', 'p0'], { body: 'Do this after #1.' })])
      f.github.state.applied = true
      await f.assigner.tick()
      // Only #1 is given: Juno has nothing, and the task that comes after waits, urgent as it is.
      expect(f.labelled()).toEqual([[1, 'builder:pip']])
      expect(f.numbers.mock.calls.at(-1)![1]).toMatchObject({ free: [{ id: 'juno', name: 'Juno' }], open: 1 })
      // Taken, then a draft: #1 has no code to build on yet.
      f.github.state.open[0] = issue(1, ['size:s', 'builder:pip', 'status:taken'])
      await f.assigner.tick()
      f.github.state.pulls = [pullFor(1, 'pip', { draft: true })]
      await f.assigner.tick()
      expect(f.labelled()).toEqual([[1, 'builder:pip']])
      // Its pull request is up: the next goes to Pip, who has the branch, not to Juno, who has nothing.
      f.github.state.pulls = [pullFor(1, 'pip')]
      await f.assigner.tick()
      expect(f.labelled()).toEqual([[1, 'builder:pip'], [2, 'builder:pip']])
      expect(lines(f, 2)).toEqual(['for **Pip**: it can start now. Build it on the branch of #101 (`pip/1`); its pull request still goes into the default branch.'])
    })

    it('waits until what it comes after lands when that builder is away, then goes to who can start it', async () => {
      const team: Crew = { ...crew(), builders: [crew().builders[0]!], away: [{ name: 'Juno', label: 'builder:juno', why: 'stopping' }] }
      const f = setup([issue(1, ['size:s', 'builder:juno', 'status:taken']), issue(2, ['size:s'], { body: 'after #1' })], { crew: team })
      f.github.state.pulls = [pullFor(1, 'juno')]
      await f.assigner.tick()
      await f.assigner.tick()
      // Juno's task is kept while its pull request waits for its read; what comes after it is given to nobody.
      expect(f.labelled()).toEqual([])
      // It lands: #1 is closed, and nothing is left to wait for.
      f.github.state.open.shift()
      f.github.state.pulls = []
      await f.assigner.tick()
      expect(f.labelled()).toEqual([[2, 'builder:pip']])
      expect(lines(f, 2)).toEqual(['for **Pip**: it can start now.'])
    })

    // Taken back for a builder with nothing, it could go to that one builder only: three writes, and an untrue line.
    it('stays with its builder, untaken for ten minutes, while another builder has nothing', async () => {
      const f = setup([issue(1, ['size:s', 'builder:pip', 'status:taken']), issue(2, ['size:s', 'builder:pip'], { body: 'after #1' })])
      f.github.state.pulls = [pullFor(1, 'pip')]
      f.github.state.comments.set(2, [{ body: 'Harness, 07:20: for **Pip**: it can start now. Build it on the branch of #101 (`pip/1`); its pull request still goes into the default branch.',
        author_association: 'MEMBER', user: { login: 'deehw' }, created_at: '2026-11-09T07:20:00Z' }])
      await f.assigner.tick()
      expect(f.github.sent.filter(s => s.method === 'DELETE')).toEqual([])
      expect(lines(f, 2)).toEqual([])
      // What it came after has landed and is closed: it is any builder's now, and goes back for the one with nothing.
      f.github.state.open.shift()
      f.github.state.pulls = []
      await f.assigner.tick()
      expect(lines(f, 2)).toEqual(['Pip has not started it in 11 minutes, and Juno has nothing to do, so this task goes to the builder who can start it next.'])
    })

    // Anything from outside is data: anyone can name a fork's branch `pip/1` and say it closes #1. Read as Pip's, it got #2
    // given to Pip before #1 had code, on an outsider's branch (review of #4121). GitHub's own word that its author is a
    // member of the repository is asked too.
    it('takes no outsider\'s pull request for what it comes after, on a branch named like a builder\'s', async () => {
      const f = setup([issue(1, ['size:s', 'builder:juno', 'status:taken']), issue(2, ['size:s'], { body: 'after #1' })])
      f.github.state.pulls = [pullFor(1, 'pip', { labels: [], author_association: 'CONTRIBUTOR', head: { sha: head(1), ref: 'pip/1', repo: { full_name: 'kai/app' } } })]
      await f.assigner.tick()
      expect(f.labelled()).toEqual([])
      expect(lines(f, 2)).toEqual([])
      expect(f.numbers.mock.calls.at(-1)![1]).toMatchObject({ open: 1 })
    })

    // On hold, or with failed checks, it has the code a later task is built on, and its builder, who fixes it first, has room.
    it.each<[string, (f: ReturnType<typeof setup>) => void]>([
      ['on hold', f => { f.github.state.pulls = [pullFor(1, 'pip', { labels: [{ name: 'builder:pip' }, { name: 'hold' }] })] }],
      ['with failed checks', f => {
        f.github.state.pulls = [pullFor(1, 'pip')]
        f.github.state.headChecks.set(head(1), [{ name: 'ci/required', status: 'completed', conclusion: 'failure' }])
      }],
    ])('is given to the builder whose pull request for what it comes after is up, %s', async (_case, arrange) => {
      const f = setup([issue(1, ['size:s', 'builder:pip', 'status:taken']), issue(2, ['size:s'], { body: 'after #1' })])
      arrange(f)
      await f.assigner.tick()
      expect(f.labelled()).toEqual([[2, 'builder:pip']])
    })

    it('waits while two builders each have a pull request up for what it comes after', async () => {
      const team: Crew = { ...crew(), builders: [...crew().builders, { id: 'atlas', name: 'Atlas', label: 'builder:atlas', machineId: 'mac', engine: 'codex' }] }
      const f = setup([issue(1, ['size:s', 'builder:pip', 'status:taken']), issue(2, ['size:s'], { body: 'after #1' })], { crew: team })
      f.github.state.pulls = [pullFor(1, 'pip'), { ...pullFor(1, 'juno'), number: 111 }]
      await f.assigner.tick()
      expect(f.labelled()).toEqual([])
      // One of them closes its own: the other's branch is the one to build on.
      f.github.state.pulls = [{ ...pullFor(1, 'juno'), number: 111 }]
      await f.assigner.tick()
      expect(f.labelled()).toEqual([[2, 'builder:juno']])
      expect(lines(f, 2)).toEqual(['for **Juno**: it can start now. Build it on the branch of #111 (`juno/1`); its pull request still goes into the default branch.'])
    })
  })

  it('gives a task once, though GitHub\'s lists have not caught up with its label yet', async () => {
    const f = setup([issue(1, ['size:s'])])
    await f.assigner.tick()
    await f.assigner.tick()
    expect(f.labelled()).toHaveLength(1)
    expect(f.said()).toHaveLength(1)
  })

  it('keeps one task with each builder while GitHub\'s list lags behind the labels it gave', async () => {
    const f = setup([issue(1, ['size:s']), issue(2, ['size:s']), issue(3, ['size:s']), issue(4, ['size:s']), issue(5, ['size:s']), issue(6, ['size:s'])])
    await f.assigner.tick()
    // The list still shows no labels: nobody gets a second task, and no task is given twice.
    f.github.state.open.push(issue(7, ['size:s']))
    await f.assigner.tick()
    await f.assigner.tick()
    const count = (label: string) => f.labelled().filter(([, l]) => l === label).length
    expect([count('builder:pip'), count('builder:juno')]).toEqual([1, 1])
    expect(new Set(f.labelled().map(([n]) => n)).size).toBe(2)
  })

  it('leaves a task a person took without a builder label', async () => {
    const f = setup([issue(1, ['size:s', 'status:taken']), issue(2, ['size:s'])])
    await f.assigner.tick()
    expect(f.labelled().map(([n]) => n)).toEqual([2])
  })

  it('never moves a task its PM or a person gave, and counts it in that builder\'s list', async () => {
    const f = setup([issue(1, ['size:m', 'builder:juno']), issue(2, ['size:m', 'builder:juno', 'status:taken']), issue(3, ['size:s'])])
    await f.assigner.tick()
    expect(f.labelled()).toEqual([[3, 'builder:pip']])
  })

  it('plans the oldest of a busy repository\'s open issues too, and says when they fill every page it reads', async () => {
    const unsized = (n: number) => issue(n, [])
    const f = setup([...Array.from({ length: 340 }, (_, i) => unsized(1000 + i)), issue(7, ['size:s']), ...Array.from({ length: 9 }, (_, i) => unsized(2000 + i))])
    await f.assigner.tick()
    expect(f.labelled().map(([n]) => n)).toEqual([7])
    expect(f.log.mock.calls.some(([line]) => String(line).includes('TOO_MANY_OPEN'))).toBe(false)
    const full = setup(Array.from({ length: 1000 }, (_, i) => unsized(1000 + i)))
    await full.assigner.tick()
    await full.assigner.tick()
    expect(full.log.mock.calls.filter(([line]) => String(line).includes('TOO_MANY_OPEN acme/app: the newest 1000 open issues'))).toHaveLength(1)
  })

  it('gives nothing the PM has not sized, nothing to a team with no builders, and nothing while every builder has a task to build', async () => {
    const unsized = setup([issue(1, ['part:api'])])
    await unsized.assigner.tick()
    expect(unsized.github.sent).toEqual([])
    const nobody = setup([issue(1, ['size:s'])], { crew: { builders: [], machines: [] } })
    await nobody.assigner.tick()
    expect(nobody.github.sent).toEqual([])
    // No plan is made then, so a backlog costs nothing each minute: a task no machine can build is said once somebody has room.
    const building = setup([issue(1, ['size:m', 'builder:pip']), issue(3, ['size:m', 'builder:juno', 'status:taken']), issue(5, ['size:s']), issue(6, ['size:s', 'needs:robot-arm'])])
    await building.assigner.tick()
    expect(building.github.sent).toEqual([])
    expect(building.log.mock.calls.some(([line]) => String(line).includes('UNPLACED'))).toBe(false)
  })

  it('gives what only one machine can build to a builder on it, and says when none can', async () => {
    const team: Crew = { builders: [...crew().builders, { id: 'atlas', name: 'Atlas', label: 'builder:atlas', machineId: 'box', engine: 'codex' }],
      machines: [{ machineId: 'mac', observation: { tools: { xcode: true }, resources: { memoryTotalBytes: 64 * GiB } } }, { machineId: 'box', observation: {} }] }
    const f = setup([issue(1, ['size:s', 'needs:xcode', 'p0']), issue(2, ['size:s', 'needs:robot-arm'])], { crew: team })
    await f.assigner.tick()
    expect(f.labelled().find(([n]) => n === 1)?.[1]).toMatch(/^builder:(pip|juno)$/)
    expect(f.labelled().some(([n]) => n === 2)).toBe(false)
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('UNPLACED acme/app#2'))
    // Its PM is told why, by name, on the task: only its person can add the tool, or the PM change the task.
    const told = () => f.said().filter(([n]) => n === 2).map(([, body]) => String(body))
    expect(told()).toEqual([expect.stringMatching(/^Harness, \d\d:\d\d, to \*\*Faye\*\*: nobody can start this yet: it needs robot-arm, which no builder's machine has\.$/)])
    // Said once, not every pass, nor again after a restart that finds it on the task.
    await f.assigner.tick()
    expect(f.log.mock.calls.filter(([line]) => String(line).includes('UNPLACED'))).toHaveLength(1)
    f.github.state.comments.set(2, told().map(body => ({ body, created_at: '2026-11-09T07:31:00Z', author_association: 'OWNER' })))
    await f.make().tick()
    expect(told()).toHaveLength(1)
  })

  it('tells the PM of "after #N" lines that wait on each other, and of a task larger than every machine', async () => {
    const f = setup([issue(1, ['size:s'], { body: 'after #2' }), issue(2, ['size:s'], { body: 'after #1' }), issue(3, ['size:l'])],
      { crew: { builders: crew().builders, machines: [{ machineId: 'mac', observation: { resources: { memoryTotalBytes: 4 * GiB, projectDiskFreeBytes: 500 * GiB } } }] } })
    await f.assigner.tick()
    const lines = f.said().map(([n, body]) => [n, String(body).replace(/^Harness, \d\d:\d\d, /, '')]).sort()
    expect(lines).toEqual([[1, 'to **Faye**: nobody can start this yet: its "after #N" lines wait on each other.'],
      [2, 'to **Faye**: nobody can start this yet: its "after #N" lines wait on each other.'],
      [3, 'to **Faye**: nobody can start this yet: it needs more than any builder\'s machine has.']])
  })

  it('says a label GitHub refused once, and gives the task again on the next pass', async () => {
    const f = setup([issue(1, ['size:s'])])
    f.github.state.labelAnswer = 403
    await f.assigner.tick()
    await f.assigner.tick()
    expect(f.said()).toEqual([])
    expect(f.log.mock.calls.filter(([line]) => String(line).includes('LABEL_REFUSED'))).toHaveLength(1)
    f.github.state.labelAnswer = 200
    await f.assigner.tick()
    expect(f.labelled()).toEqual([[1, 'builder:pip'], [1, 'builder:pip'], [1, expect.stringMatching(/^builder:(pip|juno)$/)]])
    expect(f.said()).toHaveLength(1)
  })

  it('makes the labels a fresh repository lacks, the flow\'s and each builder\'s, once, and says one GitHub refuses', async () => {
    const f = setup([])
    f.github.state.labels = [{ name: 'P1' }]
    await f.assigner.tick()
    const made = () => f.github.sent.filter(s => s.path === '/repos/acme/app/labels').map(s => s.body.name)
    expect(made()).toEqual([MARK, 'status:taken', 'size:s', 'size:m', 'size:l', 'p0', 'p2', 'builder:pip', 'builder:juno'])
    expect(f.github.sent.find(s => s.body.name === 'size:s')!.body).toEqual({ name: 'size:s', color: 'c2e0c6', description: 'About half an hour of work' })
    // Read and made once: the next pass asks GitHub for nothing about labels.
    await f.assigner.tick()
    expect(made()).toHaveLength(9)
    const refused = setup([])
    refused.github.state.labels = refused.github.state.labels.filter(label => label.name === MARK)
    const send = refused.github.send
    refused.github.send = (async (method, path, body) => path === '/repos/acme/app/labels' ? { status: 403, etag: null, body: {}, resetAt: null }
      : send(method, path, body)) as typeof send
    const again = refused.make()
    await again.tick(); await again.tick()
    expect(refused.log.mock.calls.filter(([line]) => String(line).includes('LABEL_NOT_MADE acme/app status:taken: GitHub answered 403'))).toHaveLength(1)
  })

  it('gives a builder the tasks of the area its instructions say it works on, and makes that area\'s label', async () => {
    const f = setup([issue(1, ['size:s', 'part:mobile']), issue(2, ['size:s', 'part:api'])])
    f.github.state.files.set('agents/Pip.md', '# Pip\nWorks on: Mobile\n\nMy rules.')
    f.github.state.labels.push({ name: 'part:api' })
    await f.assigner.tick()
    expect(f.labelled().sort()).toEqual([[1, 'builder:pip'], [2, 'builder:juno']])
    expect(new Map(f.said() as Array<[number, string]>).get(1)).toMatch(/for \*\*Pip\*\*: it can start now, and it works on mobile\.$/)
    // The area its person named becomes a label the PM labels tasks with, once.
    expect(f.github.sent.filter(s => s.path === '/repos/acme/app/labels').map(s => s.body)).toEqual([{ name: 'part:mobile', color: 'c5def5', description: 'An area of the project' }])
    await f.assigner.tick()
    expect(f.github.sent.filter(s => s.path === '/repos/acme/app/labels')).toHaveLength(1)
  })

  // The allocator's design, package 5: the label's side was compared as written, so a task labelled `part:Backend` was no task
  // of the area of an agent that "Works on: backend", and Harness made a second label beside the repository's own.
  it('gives a task to the builder that works on its area however the label spells it, and makes no second label for that area', async () => {
    const f = setup([issue(1, ['size:s', 'part:Backend']), issue(2, ['size:s', 'part:Mobile App'])])
    f.github.state.files.set('agents/Pip.md', 'Works on: mobile app')
    f.github.state.files.set('agents/Juno.md', 'Works on: backend')
    f.github.state.labels.push({ name: 'part:Mobile App' }, { name: 'part:Backend' })
    await f.assigner.tick()
    expect(f.labelled().sort()).toEqual([[1, 'builder:juno'], [2, 'builder:pip']])
    const why = new Map(f.said() as Array<[number, string]>)
    expect(why.get(1)).toMatch(/for \*\*Juno\*\*: it can start now, and it works on backend\.$/)
    expect(why.get(2)).toMatch(/for \*\*Pip\*\*: it can start now, and it works on mobile-app\.$/)
    expect(f.github.sent.filter(s => s.path === '/repos/acme/app/labels')).toEqual([])
  })

  // The study of an area's worth (docs/research/2026-11-12-area-worth): in lampOS's record a builder was no quicker in an area
  // for the work it had landed there (0.83, 0.93 and 0.90 of the time after 1, 2 and 3 or more, each interval holding 1). The
  // plan took 15% off a builder's time in a part for each task it had finished there, to 40%, and the line said how many.
  it('plans a builder no quicker in a part for the tasks it finished there and does not count them; the area its person names still counts', async () => {
    // Juno holds a p0 api task, and Pip, which works on ui, may take the ui one. The Mac has room for one middle task at a
    // time. Each has finished two tasks of the part it is on.
    const finished = [issue(10, ['builder:juno', 'part:api']), issue(11, ['builder:juno', 'part:api']), issue(12, ['builder:pip', 'part:ui']),
      issue(13, ['builder:pip', 'part:ui'])]
    const f = setup([issue(1, ['size:m', 'part:api', 'p0', 'builder:juno']), issue(2, ['size:m', 'part:ui'])], { closed: finished,
      crew: { builders: crew().builders, machines: [{ machineId: 'mac', observation: { resources: { memoryTotalBytes: 6 * GiB, projectDiskFreeBytes: 500 * GiB } } }] } })
    f.github.state.files.set('agents/Pip.md', 'Works on: ui')
    await f.assigner.tick()
    // Juno's task takes the 90 minutes a middle one is guessed at, not 63: Pip starts when the Mac has room after it.
    expect(f.said().map(([number, body]) => [number, String(body).replace(/^Harness, \d\d:\d\d: /, '')]))
      .toEqual([[2, 'for **Pip**: it can start in 2 h, and it works on ui.']])
  })

  describe('readers', () => {
    const HEAD = 'f6edb44c0ffee0000000000000000000000000ab'
    const pull = (extra: Json = {}): Json => ({ number: 30, draft: false, base: { ref: 'main' }, head: { sha: HEAD, ref: 'pip/14' },
      labels: [{ name: 'builder:pip' }], body: 'Closes #14', ...extra })
    const comment = (body: string, extra: Json = {}): Json => ({ body, author_association: 'MEMBER', user: { login: 'deehw' },
      created_at: '2026-11-09T07:20:00Z', ...extra })
    /** Pip (Claude Code) builds; Juno (Claude Code) and Atlas (Codex) can read. */
    const team: Crew = { builders: [...crew().builders, { id: 'atlas', name: 'Atlas', label: 'builder:atlas', machineId: 'mac', engine: 'codex' }],
      machines: crew().machines }
    const asks = (f: ReturnType<typeof setup>) => f.said().filter(([n]) => n === 30).map(([, body]) => String(body))

    // lampOS #5212: a read posted as a review is a read; asked for another, its pull request waited on a reader it already had.
    // Plan item 3 (review of #3708): a READ-OK typed by hand, as a review or a comment, is no read. Its reader is asked again, by
    // name, to make it by command, and counted as reading meanwhile; pull requests read before the command now read again so.
    it('asks a reader whose READ-OK on the head was typed to read it again by command, once, and nobody else', async () => {
      for (const typed of [{ reviews: [{ id: 7, state: 'APPROVED', body: 'Juno, 07:10, to **Pip**: READ-OK f6edb44', submitted_at: '2026-11-09T07:10:00Z',
        author_association: 'MEMBER', user: { login: 'deehw' } }], comments: [] }, { reviews: [], comments: [comment('Juno, 07:10: READ-OK f6edb44', { typed: true, created_at: '2026-11-09T07:10:00Z' })] }]) {
        const f = setup([], { crew: team })
        f.github.state.pulls = [pull()]
        f.github.state.reviews.set(30, typed.reviews)
        f.github.state.comments.set(30, typed.comments)
        await f.assigner.tick()
        expect(asks(f)).toEqual([expect.stringMatching(/^Harness, \d\d:\d\d, to \*\*Juno\*\*: your READ-OK on f6edb44 was typed, and only one made by command counts: please read it again, .*super-tab read ok acme\/app#30 f6edb44/)])
        // GitHub shows the ask: Juno is reading, and is not asked again until it answers.
        f.github.state.comments.set(30, [...typed.comments, comment(asks(f)[0]!, { created_at: '2026-11-09T07:31:00Z' })])
        await f.make().tick()
        expect(asks(f)).toHaveLength(1)
        // It answers by command: a read, and nobody more is asked.
        f.github.state.comments.set(30, [...f.github.state.comments.get(30)!, comment('Juno, 07:40: READ-OK f6edb44', { created_at: '2026-11-09T07:40:00Z' })])
        f.clock.now += 10 * 60_000
        await f.make().tick()
        expect(asks(f)).toHaveLength(1)
      }
    })

    // lampOS lib.sh patch_of: a verdict on an earlier head whose change is the head's still stands. Updated from main with nothing of
    // its own changed, the pull request was read again for nothing, or its HOLD asked about before its author fixed anything.
    it('asks nobody again for a verdict on an earlier head whose change is the head\'s: a READ-OK stands, a HOLD waits for its author', async () => {
      const change = { files: [{ filename: 'sandbox/quotes.py', status: 'modified', changes: 1, patch: '@@ -4,3 +4,3 @@\n x\n-    days = 1\n+    days = int(n)' }] }
      for (const verdict of ['READ-OK', 'HOLD']) {
        const f = setup([], { crew: team })
        f.github.state.pulls = [pull()]
        f.github.state.comments.set(30, [comment(`Juno, 07:10, to **Pip**: ${verdict} a1b2c3d`)])
        f.github.state.compare.set('a1b2c3d', change)
        f.github.state.compare.set(HEAD, change)
        await f.assigner.tick()
        expect(asks(f), verdict).toEqual([])
      }
    })

    it('counts no READ-OK its author signed, however its two-word name is written, and asks a reader', async () => {
      const two: Crew = { builders: [...crew().builders, { id: 'pip-two', name: 'Pip Two', label: 'builder:pip-two', machineId: 'mac', engine: 'claude' }],
        machines: crew().machines }
      const f = setup([], { crew: two })
      f.github.state.pulls = [pull({ labels: [{ name: 'builder:pip-two' }], head: { sha: HEAD, ref: 'pip-two/14' } })]
      f.github.state.comments.set(30, [comment('Pip Two, 07:10, to **Juno**: READ-OK f6edb44')])
      await f.assigner.tick()
      expect(asks(f)).toEqual([expect.stringMatching(/to \*\*(Pip|Juno)\*\*: please read this pull request/)])
    })

    // A name the signature pattern cannot read fell back to the shared GitHub login, so its author's own READ-OK read as a reader's.
    it.each([['Atlas Reed Two', 'builder:atlas-reed-two'], ['Đức Anh', 'builder:đức-anh']])('counts no READ-OK its author %s signed, and asks a reader', async (name, label) => {
      const own: Crew = { builders: [...crew().builders, { id: 'writer', name, label, machineId: 'mac', engine: 'claude' }], machines: crew().machines }
      const f = setup([], { crew: own })
      f.github.state.pulls = [pull({ labels: [{ name: label }], head: { sha: HEAD, ref: 'task/14' } })]
      f.github.state.comments.set(30, [comment(`${name}, 07:10, to **Juno**: READ-OK f6edb44`)])
      await f.assigner.tick()
      expect(asks(f)).toEqual([expect.stringMatching(/: please read this pull request/)])
      expect(asks(f)[0]).not.toContain(name)
    })

    // Review of #3957: a reader that answers its own HOLD with a typed READ-OK is asked for the command; one asked READ_ASKS times
    // for the head is no longer counted on; and a READ-OK made before a HOLD of the pull request's own side lifts nothing.
    it('asks for the command after a typed answer to a HOLD, another reader once one is asked out, and another after an own-side HOLD', async () => {
      const held = setup([], { crew: team })
      held.github.state.pulls = [pull()]
      held.github.state.comments.set(30, [comment('Juno, 07:00: HOLD f6edb44 off by one', { created_at: '2026-11-09T07:00:00Z' }),
        comment('Juno, 07:10: READ-OK f6edb44', { typed: true, created_at: '2026-11-09T07:10:00Z' })])
      await held.assigner.tick()
      expect(asks(held)).toEqual([expect.stringMatching(/to \*\*Juno\*\*: your READ-OK on f6edb44 was typed/)])
      const out = setup([], { crew: team })
      out.github.state.pulls = [pull()]
      const ask = (at: string) => comment(`Harness, ${at.slice(11, 16)}, to **Juno**: please read this pull request, then run \`harness super-tab read ok acme/app#30 f6edb44 'what you found'\`.`, { created_at: at })
      out.github.state.comments.set(30, [ask('2026-11-09T06:00:00Z'), ask('2026-11-09T06:20:00Z'), ask('2026-11-09T06:40:00Z'),
        comment('Juno, 07:00: READ-OK f6edb44', { typed: true, created_at: '2026-11-09T07:00:00Z' })])
      await out.assigner.tick()
      expect(asks(out)).toEqual([expect.stringMatching(/to \*\*Atlas\*\*: please read this pull request/)])
      const after = setup([], { crew: team })
      after.github.state.pulls = [pull({ user: { login: 'deehw' } })]
      after.github.state.comments.set(30, [comment('Juno, 07:00: READ-OK f6edb44', { created_at: '2026-11-09T07:00:00Z' }),
        comment('HOLD f6edb44: wait', { created_at: '2026-11-09T07:05:00Z' })])
      await after.assigner.tick()
      expect(asks(after)).toEqual([expect.stringMatching(/to \*\*Atlas\*\*: please read this pull request/)])
    })

    // Review of #3957: while the backend gives no records, only a pull request with a verdict never answered for waits; one
    // with none is read, and its reader asked.
    it('waits only on a verdict never answered for while the backend gives no records', async () => {
      const records = new VerdictRecords(async () => { throw new Error('down') }, () => Date.parse('2026-11-09T07:31:00Z'), () => {})
      const thanks = { id: 2, body: 'Thanks.', created_at: '2026-11-09T07:00:00Z' }
      expect(await records.named(PROJECT, [{ id: 1, body: 'Juno, 07:00: READ-OK f6edb44', created_at: '2026-11-09T07:00:00Z' }])).toBeNull()
      expect(await records.named(PROJECT, [thanks])).toEqual([thanks])
    })

    // Review of #3708: every agent of a person posts as the login that opened its pull request, its writer too. Asked to answer
    // as that login, the writer, which hears its own pull request, could lift the HOLD. Another agent's READ-OK made by command
    // lifts it (githubMerge.ts verdicts): a reader is asked, on any head.
    it('asks a reader, never the login that opened it, while that login\'s unsigned HOLD stands, on an older head or the head', async () => {
      for (const sha of ['1234567', 'f6edb44']) {
        const f = setup([], { crew: team })
        f.github.state.pulls = [pull({ user: { login: 'deehw' } })]
        f.github.state.comments.set(30, [comment(`HOLD ${sha}: off by one`)])
        await f.assigner.tick()
        expect(asks(f), sha).toEqual([expect.stringMatching(/to \*\*Atlas\*\*: please read this pull request/)])
      }
    })

    // Review of #3708: a task taken over makes the reader Harness asked one of its writers. Counted as still reading, it kept
    // anyone who could read it from being asked for two hours.
    it('counts no writer it asked before as still reading: a task taken over by the reader asked is read by another', async () => {
      const f = setup([], { crew: team })
      f.github.state.pulls = [pull({ labels: [{ name: 'builder:atlas' }] })]
      f.github.state.comments.set(30, [comment('Harness, 07:20, to **Atlas**: please read this pull request, and start your comment with your name, '
        + 'as in "Atlas, 07:20: READ-OK f6edb44" or "Atlas, 07:20: HOLD f6edb44" with the file, line and fix.', { created_at: '2026-11-09T07:20:00Z' })])
      await f.assigner.tick()
      expect(asks(f)).toEqual([expect.stringMatching(/to \*\*Juno\*\*: please read this pull request/)])
    })

    // Swarm-sandbox #24, 2026-11-10: after a push, Harness asked "deehw" to read again for an unsigned READ-OK that never
    // counted, and took that ask for a reader on its way, so it asked nobody who could read it.
    it('asks no login to read again for its unsigned READ-OK on an older head, and asks a reader who signs', async () => {
      const f = setup([], { crew: team })
      f.github.state.pulls = [pull({ user: { login: 'deehw' } })]
      f.github.state.comments.set(30, [comment('READ-OK 1234567')])
      await f.assigner.tick()
      expect(asks(f)).toEqual([expect.stringMatching(/: please read this pull request/)])
      expect(asks(f)[0]).not.toContain('deehw')
    })

    it('counts no unsigned READ-OK from the login that opened the pull request, and asks a reader who signs', async () => {
      const f = setup([], { crew: team })
      f.github.state.pulls = [pull({ user: { login: 'deehw' } })]
      f.github.state.comments.set(30, [comment('READ-OK f6edb44')])
      await f.assigner.tick()
      expect(asks(f)).toEqual([expect.stringMatching(/^Harness, \d\d:\d\d, to \*\*Atlas\*\*: please read this pull request, then run `harness super-tab read ok acme\/app#30 f6edb44 /)])
    })

    // The reader Harness asked as "Kai Lee" and that answered as "kai-lee" is one: it read, and is not still waited for.
    it('knows a reader it asked by its verdict however it writes its name, and asks another for TWO READS', async () => {
      const f = setup([], { crew: team })
      f.github.state.pulls = [pull({ body: 'Closes #14. TWO READS' })]
      f.github.state.comments.set(30, [comment('Harness, 07:20, to **Kai Lee**: please read this pull request, and start your comment with READ-OK f6edb44 '
        + 'or HOLD f6edb44 (with the file, line and fix).', { created_at: '2026-11-09T07:20:00Z' }), comment('kai-lee, 07:25: READ-OK f6edb44', { created_at: '2026-11-09T07:25:00Z' })])
      await f.assigner.tick()
      expect(asks(f)).toEqual([expect.stringMatching(/to \*\*Atlas\*\*: please read this pull request/)])
    })

    it('asks none of a pull request\'s writers to read it: its label\'s agent nor its branch\'s', async () => {
      const f = setup([], { crew: team })
      f.github.state.pulls = [pull({ labels: [{ name: 'builder:atlas' }], head: { sha: HEAD, ref: 'juno/14' } })]
      await f.assigner.tick()
      expect(asks(f)).toEqual([expect.stringMatching(/to \*\*Pip\*\*: please read this pull request/)])
    })

    it('counts a reader who signs its name two ways once for TWO READS, as the merger does, and asks another', async () => {
      const f = setup([])
      f.github.state.pulls = [pull({ body: 'Closes #14. TWO READS' })]
      f.github.state.comments.set(30, [comment('Kai Lee, 07:10: READ-OK f6edb44'), comment('kai-lee, 07:12: READ-OK f6edb44')])
      await f.assigner.tick()
      expect(asks(f)).toEqual([expect.stringMatching(/to \*\*Juno\*\*: please read this pull request/)])
    })

    it('asks a reader for the team\'s pull request wherever it is among a busy repository\'s hundred and more', async () => {
      const f = setup([], { crew: team })
      const people = Array.from({ length: 119 }, (_, i) => pull({ number: 100 + i, labels: [], head: { sha: HEAD, ref: `fix-${i}` }, body: '' }))
      f.github.state.pulls = [...people.slice(0, 110), pull(), ...people.slice(110)]
      await f.assigner.tick()
      expect(asks(f)).toEqual([expect.stringMatching(/to \*\*Atlas\*\*: please read this pull request/)])
    })

    it('takes no outsider\'s comment for its own ask, so the reader it names is still asked', async () => {
      const f = setup([], { crew: team })
      f.github.state.pulls = [pull()]
      f.github.state.comments.set(30, [comment('Harness, 07:30, to **Atlas**: please read this pull request, and start your comment with READ-OK f6edb44 '
        + 'or HOLD f6edb44 (with the file, line and fix).', { author_association: 'NONE', user: { login: 'stranger' } })])
      await f.assigner.tick()
      expect(asks(f)).toEqual([expect.stringMatching(/to \*\*Atlas\*\*: please read this pull request/)])
    })

    it('asks nobody for a pull request that is not the team\'s: a person\'s, or a branch no builder of the team made', async () => {
      const f = setup([], { crew: team })
      f.github.state.pulls = [pull({ number: 31, head: { sha: HEAD, ref: 'ken/fix-login' }, labels: [], body: '' }),
        pull({ number: 32, head: { sha: HEAD, ref: 'fix-login' }, labels: [], body: '' })]
      await f.assigner.tick()
      expect(f.said()).toEqual([])
      // Their comments are not even read.
      expect(f.github.sent).toEqual([])
    })

    // Swarm plan, step 1, item 1: "No verdict in 30 minutes: another is asked." Until 11-11, two hours.
    it('asks another reader once the one asked has not read for 30 minutes, and nobody more once a READ-OK is on the head', async () => {
      const ask = (name: string, at: string) => comment(`Harness, ${at.slice(11, 16)}, to **${name}**: please read this pull request, `
        + 'and start your comment with READ-OK f6edb44 or HOLD f6edb44 (with the file, line and fix).', { created_at: at })
      // Atlas (Codex) was asked 20 minutes ago: still reading.
      const recent = setup([], { crew: team })
      recent.github.state.pulls = [pull()]
      recent.github.state.comments.set(30, [ask('Atlas', '2026-11-09T07:11:00Z')])
      await recent.assigner.tick()
      expect(asks(recent)).toEqual([])
      // Asked 45 minutes ago with no word since: Juno is asked too.
      const f = setup([], { crew: team })
      f.github.state.pulls = [pull()]
      f.github.state.comments.set(30, [ask('Atlas', '2026-11-09T06:46:00Z')])
      await f.assigner.tick()
      await f.assigner.tick()
      expect(asks(f)).toEqual([expect.stringMatching(/to \*\*Juno\*\*: please read this pull request/)])
      // Atlas reads after all: its READ-OK counts, and nobody more is asked when Juno's ask is old too.
      f.github.state.comments.set(30, [ask('Atlas', '2026-11-09T06:46:00Z'), ask('Juno', '2026-11-09T06:50:00Z'),
        comment('Atlas, 07:30, to **Pip**: READ-OK f6edb44', { created_at: '2026-11-09T07:30:00Z' })])
      await f.make().tick()
      expect(asks(f)).toHaveLength(1)
    })

    // #4055, anh Dee, 2026-11-11: "never spam github as user accounts could be banned". Asked again each silent half hour, the
    // pull request had one more comment, in its person's name, each time; its reader is reminded in its own terminal instead.
    it('asks the only reader once for a head, and not again however long it is silent, after a restart too', async () => {
      const askedAt = (at: string) => comment(`Harness, ${at.slice(11, 16)}, to **Faye**: please read this pull request, and start your `
        + 'comment with READ-OK f6edb44 or HOLD f6edb44 (with the file, line and fix).', { created_at: at })
      // Pip builds alone; Faye, its PM, was asked 45 minutes ago and has said nothing since.
      const f = setup([], { crew: { builders: [crew().builders[0]!], machines: crew().machines } })
      f.github.state.pulls = [pull()]
      f.github.state.comments.set(30, [askedAt(new Date(f.clock.now - 45 * 60_000).toISOString())])
      for (const later of [0, 60, 240]) {
        f.clock.now += later * 60_000
        await f.make().tick()
      }
      expect(asks(f)).toEqual([])
    })

    // Code review of #4060: a push is a change to read. The reader asked about the head before, with no verdict on it, is asked
    // about the new one once, half an hour after its last ask at the soonest, and then not again.
    it('asks a reader asked about an earlier head about the new one, once, half an hour after its last ask', async () => {
      const f = setup([], { crew: { builders: [crew().builders[0]!], machines: crew().machines } })
      f.github.state.pulls = [pull()]
      f.github.state.comments.set(30, [comment('Harness, 05:00, to **Faye**: please read this pull request, and start your comment with '
        + 'READ-OK 1234567 or HOLD 1234567 (with the file, line and fix).', { created_at: new Date(f.clock.now - 10 * 60_000).toISOString() })])
      await f.make().tick()
      expect(asks(f)).toEqual([])
      // Each pass a fresh process, which knows what it asked only as GitHub keeps it.
      let kept = 0
      for (const later of [20, 0, 60, 240]) {
        f.clock.now += later * 60_000
        await f.make().tick()
        for (const body of asks(f).slice(kept)) f.github.state.comments.get(30)!.push(comment(body, { created_at: new Date(f.clock.now).toISOString() }))
        kept = asks(f).length
      }
      expect(asks(f)).toEqual([expect.stringMatching(/to \*\*Faye\*\*: the head is now f6edb44: please read this pull request/)])
      // Said in the daemon's log, once a process.
      expect(f.log.mock.calls.some(([line]) => /NO_READER acme\/app#30@f6edb44: its readers asked have not read it/.test(String(line)))).toBe(true)
    })

    // The swarm-sandbox, 2026-11-10: Juno, its PM and only reader, was asked while stopped and never heard it (GitHub news brings
    // what is said only while an agent runs). Asked once it runs; until then the daemon says why nobody reads it.
    it('asks its PM to read only while it runs here', async () => {
      const f = setup([], { crew: { builders: [crew().builders[0]!], machines: crew().machines } })
      f.github.state.pulls = [pull()]
      f.pm.running = false
      await f.assigner.tick()
      expect(asks(f)).toEqual([])
      expect(f.log.mock.calls.some(([line]) => /NO_READER acme\/app#30@f6edb44: its PM, the reader left, is stopped/.test(String(line)))).toBe(true)
      f.pm.running = true
      await f.assigner.tick()
      await f.assigner.tick()
      expect(asks(f)).toEqual([expect.stringMatching(/to \*\*Faye\*\*: please read this pull request/)])
    })

    // Code review of #4060: a stopped PM asked about an earlier head is not asked about the new one either; one whose state cannot be
    // read is taken as stopped, and the pass goes on.
    it('asks a stopped PM about a new head no more than about the first, and goes on when its state cannot be read', async () => {
      const f = setup([], { crew: { builders: [crew().builders[0]!], machines: crew().machines } })
      f.github.state.pulls = [pull()]
      f.github.state.comments.set(30, [comment('Harness, 05:00, to **Faye**: please read this pull request, and start your comment with '
        + 'READ-OK 1234567 or HOLD 1234567 (with the file, line and fix).', { created_at: new Date(f.clock.now - 40 * 60_000).toISOString() })])
      f.pm.running = false
      await f.assigner.tick()
      f.pm.unreadable = true
      f.clock.now += 60 * 60_000
      await f.make().tick()
      expect(asks(f)).toEqual([])
      expect(f.log.mock.calls.filter(([line]) => /NO_READER acme\/app#30@f6edb44: its PM, the reader left, is stopped/.test(String(line)))).toHaveLength(2)
    })

    // A stop for every repository (GitHub limiting this computer) stops the pass, as any read's: nothing is asked meanwhile.
    it('stops its pass when GitHub limits the read of the checks', async () => {
      const f = setup([], { crew: team })
      f.github.state.pulls = [pull()]
      f.github.state.checksLimited = true
      await f.assigner.tick()
      expect(asks(f)).toEqual([])
      expect(f.log.mock.calls.some(([line]) => /RATE_LIMITED|limiting/.test(String(line)))).toBe(true)
    })

    it('asks readers as before when the checks cannot be read, and says so once', async () => {
      const f = setup([], { crew: team })
      f.github.state.pulls = [pull()]
      f.github.state.checksDown = true
      await f.assigner.tick()
      await f.assigner.tick()
      expect(asks(f)).toHaveLength(1)
      expect(f.log.mock.calls.filter(([line]) => /CHECKS_UNREAD acme\/app/.test(String(line)))).toHaveLength(1)
    })

    it('asks nobody to read a pull request on hold, nor one whose checks failed at its head, until they pass', async () => {
      const f = setup([], { crew: team })
      // On hold, in any case: its task waits with it, so its builder is not called quiet on it (code review of #4060).
      f.github.state.pulls = [pull({ labels: [{ name: 'builder:pip' }, { name: 'Hold' }] })]
      await f.assigner.tick()
      expect(asks(f)).toEqual([])
      expect(f.numbers.mock.calls.at(-1)![1].free.map(free => free.name)).toContain('Pip')
      const failing = pull()
      f.github.state.pulls = [failing]
      f.github.state.headChecks.set(String((failing.head as Json).sha), [{ name: 'ci/required', status: 'completed', conclusion: 'failure' }])
      await f.assigner.tick()
      expect(asks(f)).toEqual([])
      // Run again and passed: read again once ten minutes are up (a failing head is not read each pass), and its reader asked.
      f.github.state.headChecks.set(String((failing.head as Json).sha), [{ name: 'ci/required', status: 'completed', conclusion: 'success' }])
      await f.assigner.tick()
      expect(asks(f)).toEqual([])
      f.clock.now += 10 * 60_000
      await f.assigner.tick()
      expect(asks(f)).toHaveLength(1)
    })

    it('measures a reader asked again after a push from that ask, and one that never answered from its last', async () => {
      const f = setup([], { crew: team })
      f.github.state.pulls = [pull()]
      // Atlas held an older head, was asked again for this one 2.5 hours ago, and has said nothing since.
      f.github.state.comments.set(30, [comment('Atlas, 04:00, to **Pip**: HOLD 1234567 app.ts:3 add the test', { created_at: '2026-11-09T04:00:00Z' }),
        comment('Harness, 05:01, to **Atlas**: the head is now f6edb44, after your HOLD on 1234567: please read it again, and start your comment '
          + 'with READ-OK f6edb44 or HOLD f6edb44 (with the file, line and fix).', { created_at: '2026-11-09T05:01:00Z' })])
      await f.assigner.tick()
      expect(asks(f)).toEqual([expect.stringMatching(/to \*\*Juno\*\*: please read this pull request/)])
      // Juno, asked for an older head 3 hours ago, never answered: Atlas is asked for this one.
      const g = setup([], { crew: team })
      g.github.state.pulls = [pull()]
      g.github.state.comments.set(30, [comment('Harness, 04:31, to **Juno**: please read this pull request, and start your comment with '
        + 'READ-OK 1234567 or HOLD 1234567 (with the file, line and fix).', { created_at: '2026-11-09T04:31:00Z' })])
      await g.assigner.tick()
      expect(asks(g)).toEqual([expect.stringMatching(/to \*\*Atlas\*\*: please read this pull request/)])
    })

    it('asks one reader for a pull request, never its author, of another model family first, once', async () => {
      const f = setup([], { crew: team })
      f.github.state.pulls = [pull()]
      await f.assigner.tick()
      // A verdict is a command (githubVerdict.ts): the ask carries it whole, with the pull request and the head, and no form
      // to type by hand. Harness writes the comment, so the reader's own name and the time are not the reader's to get right.
      expect(asks(f)).toEqual([expect.stringMatching(/^Harness, \d\d:\d\d, to \*\*Atlas\*\*: please read this pull request, then run `harness super-tab read ok acme\/app#30 f6edb44 'what you found'`\. For a HOLD, read hold in place of read ok, with the file, line and fix\.$/)])
      expect(asks(f)[0]).not.toMatch(/READ-OK|start your comment/)
      // In backticks, so GitHub's page shows it as written (it shortens acme/app#30 to #30 elsewhere), and one the CLI takes.
      const command = /`harness super-tab (read ok \S+ \S+) 'what you found'`/.exec(asks(f)[0]!)![1]!
      expect(parseSuperTabArgs(['--tab', 'tab', '--agent', 'atlas', ...command.split(' '), 'what you found'], { port: 14001, dataDir: '/fixture', machineId: 'mac' }).payload)
        .toMatchObject({ action: 'read', repository: 'acme/app', number: 30, verdict: 'READ-OK', sha: 'f6edb44', text: 'what you found' })
      await f.assigner.tick()
      expect(asks(f)).toHaveLength(1)
      // Read back from GitHub after a restart, the ask is known for what it is: Atlas is not asked twice.
      f.github.state.comments.set(30, [comment(asks(f)[0]!)])
      await f.make().tick()
      expect(asks(f)).toHaveLength(1)
    })

    // Of two readers of another model family, the one that holds fewer open tasks, however their names sort.
    it('asks the reader that holds the fewest tasks, among those of another model family', async () => {
      const four: Crew = { builders: [...team.builders, { id: 'bo', name: 'Bo', label: 'builder:bo', machineId: 'mac', engine: 'codex' }], machines: team.machines }
      const f = setup([issue(40, ['size:s', 'builder:atlas', 'status:taken'])], { crew: four })
      f.github.state.pulls = [pull()]
      await f.assigner.tick()
      expect(asks(f)).toEqual([expect.stringMatching(/to \*\*Bo\*\*: please read this pull request/)])
    })

    it('asks two for TWO READS, none while a HOLD stands or for a draft, and none once its head has its READ-OK', async () => {
      const two = setup([], { crew: team })
      two.github.state.pulls = [pull({ body: 'Closes #14. TWO READS' })]
      await two.assigner.tick()
      expect(asks(two).map(body => /\*\*(\w+)\*\*/.exec(body)![1]).sort()).toEqual(['Atlas', 'Juno'])
      const held = setup([], { crew: team })
      held.github.state.pulls = [pull()]
      held.github.state.comments.set(30, [comment('Juno, 14:00: HOLD f6edb44: the day count is off by one.')])
      await held.assigner.tick()
      expect(asks(held)).toEqual([])
      const draft = setup([], { crew: team })
      draft.github.state.pulls = [pull({ draft: true })]
      await draft.assigner.tick()
      expect(asks(draft)).toEqual([])
      const read = setup([], { crew: team })
      read.github.state.pulls = [pull()]
      read.github.state.comments.set(30, [comment('Juno, 14:00: READ-OK f6edb44')])
      await read.assigner.tick()
      expect(asks(read)).toEqual([])
    })

    it('counts a reader it asked who has not answered as still reading, and asks again for a new head only when none is', async () => {
      const f = setup([], { crew: team })
      f.github.state.pulls = [pull()]
      f.github.state.comments.set(30, [comment('Harness, 07:30, to **Atlas**: please read this pull request, and start your comment with READ-OK f6edb44 or HOLD f6edb44 (with the file, line and fix).')])
      await f.assigner.tick()
      expect(asks(f)).toEqual([])
    })

    it('asks a reader again, once, when the head moves past its HOLD or READ-OK, and nobody else', async () => {
      const NEW = 'abcdef1c0ffee0000000000000000000000000ab'
      for (const verdict of ['HOLD', 'READ-OK']) {
        const f = setup([], { crew: team })
        f.github.state.pulls = [pull({ head: { sha: NEW, ref: 'pip/14' } })]
        f.github.state.comments.set(30, [comment(`Juno, 14:00: ${verdict} f6edb44${verdict === 'HOLD' ? ': the day count is off by one.' : ''}`)])
        await f.assigner.tick()
        expect(asks(f).map(body => body.replaceAll(/\d\d:\d\d/g, 'HH:MM'))).toEqual([`Harness, HH:MM, to **Juno**: the head is now abcdef1, `
          + `after your ${verdict} on f6edb44: please read it again, then run \`harness super-tab read ok acme/app#30 abcdef1 'what you found'\`. For a HOLD, read hold in place of read ok, with the file, line and fix.`])
        // Once: GitHub shows the ask, and Juno is still reading.
        f.github.state.comments.set(30, [...f.github.state.comments.get(30)!, comment(asks(f)[0]!)])
        await f.make().tick()
        expect(asks(f)).toHaveLength(1)
      }
    })

    it('asks the PM when the team has no other builder, and a builder for the PM\'s own pull request', async () => {
      const f = setup([], { crew: { builders: [crew().builders[0]!], machines: crew().machines } })
      f.github.state.pulls = [pull()]
      await f.assigner.tick()
      expect(asks(f)).toEqual([expect.stringMatching(/to \*\*Faye\*\*: please read this pull request/)])
      const own = setup([], { crew: { builders: [crew().builders[0]!], machines: crew().machines } })
      own.github.state.pulls = [pull({ labels: [{ name: 'builder:faye' }], head: { sha: 'f6edb44c0ffee0000000000000000000000000ab', ref: 'faye/14' } })]
      await own.assigner.tick()
      await own.assigner.tick()
      expect(asks(own).filter(body => !body.includes('**Pip**'))).toEqual([])
      expect(own.log.mock.calls.filter(([line]) => String(line).includes('NO_READER'))).toHaveLength(0)
    })
  })

  // Swarm plan, step 1, item 6: "Nobody waits on it: a task not taken in 10 minutes is open to any agent with room." A task
  // waits with a builder that does not take it while another builder sits with nothing.
  describe('a task Harness gave that is not taken in 10 minutes, while a builder has nothing', () => {
    const gave = (name: string, at: string): Json => ({ body: `Harness, ${at.slice(11, 16)}: for **${name}**: it can start in 30 min.`,
      author_association: 'MEMBER', user: { login: 'deehw' }, created_at: at })
    const waiting = () => {
      const f = setup([issue(14, ['size:m', 'builder:pip', 'status:taken']), issue(15, ['size:m', 'builder:pip'])])
      f.github.state.applied = true
      return f
    }

    it('goes back with a line of why, once, and the next plan gives it to the builder with nothing', async () => {
      const f = waiting()
      f.github.state.comments.set(15, [gave('Pip', '2026-11-09T07:20:00Z')])
      await f.assigner.tick()
      expect(f.github.sent.filter(s => s.method === 'DELETE').map(s => s.path)).toEqual(['/repos/acme/app/issues/15/labels/builder%3Apip',
        '/repos/acme/app/issues/15/labels/status%3Ataken'])
      expect(f.said().filter(([n]) => n === 15).map(([, body]) => String(body).replace(/\d\d:\d\d/, 'HH:MM'))).toEqual(['Harness, HH:MM: Pip has not '
        + 'started it in 11 minutes, and Juno has nothing to do, so this task goes to the builder who can start it next.'])
      await f.assigner.tick()
      expect(f.labelled()).toEqual([[15, 'builder:juno']])
      // Given back to Pip by a person, or by a later plan, while Juno has nothing again: it stays with Pip.
      f.github.state.open[1] = issue(15, ['size:m', 'builder:pip'])
      f.clock.now += 60 * 60_000
      await f.assigner.tick()
      expect(f.said().filter(([n, body]) => n === 15 && String(body).includes('has nothing to do'))).toHaveLength(1)
    })

    // The sandbox, 2026-11-11: with one builder free, both of two waiting tasks went back, and the plan then had two to give to it.
    it('takes back one task for each builder with nothing, the oldest first', async () => {
      const team: Crew = { ...crew(), builders: [...crew().builders, { id: 'atlas', name: 'Atlas', label: 'builder:atlas', machineId: 'mac', engine: 'codex' }] }
      // Pip works on #14 and waits on #15; Atlas waits on #17, untaken; Juno has nothing.
      const f = setup([issue(14, ['size:m', 'builder:pip', 'status:taken']), issue(15, ['size:m', 'builder:pip']), issue(17, ['size:m', 'builder:atlas'])],
        { crew: team })
      f.github.state.applied = true
      f.github.state.comments.set(15, [gave('Pip', '2026-11-09T07:00:00Z')])
      f.github.state.comments.set(17, [gave('Atlas', '2026-11-09T07:05:00Z')])
      await f.assigner.tick()
      expect(f.said().filter(([, body]) => String(body).includes('has nothing to do')).map(([n]) => n)).toEqual([15])
    })

    it('stays while it is new, given by hand, or while nobody else has nothing; and the read is made only then', async () => {
      const fresh = waiting()
      fresh.github.state.comments.set(15, [gave('Pip', '2026-11-09T07:25:00Z')])
      await fresh.assigner.tick()
      const hand = waiting()
      hand.github.state.comments.set(15, [gave('Juno', '2026-11-09T07:00:00Z'), { ...gave('Pip', '2026-11-09T07:00:00Z'), author_association: 'NONE' }])
      await hand.assigner.tick()
      const busy = waiting()
      busy.github.state.open.push(issue(16, ['size:s', 'builder:juno']))
      busy.github.state.comments.set(15, [gave('Pip', '2026-11-09T07:00:00Z')])
      await busy.assigner.tick()
      for (const f of [fresh, hand, busy]) expect(f.github.sent.filter(s => s.method === 'DELETE')).toEqual([])
      expect(busy.github.sent).toEqual([])
    })

    // The allocator's design, package 2: a builder whose tasks are all up for their read has nothing to build, and with fewer
    // than four open it would be given the task; with four it would not, so the task stays where it is.
    it('goes back for a builder whose own tasks wait on their pull requests\' reads, while that builder has room for it', async () => {
      const inReview = (count: number) => {
        const tasks = Array.from({ length: count }, (_, i) => 20 + i)
        const f = setup([issue(15, ['size:m', 'builder:pip']), ...tasks.map(n => issue(n, ['size:m', 'builder:juno', 'status:taken']))])
        f.github.state.pulls = tasks.map(n => ({ number: 100 + n, draft: false, base: { ref: 'main' }, head: { sha: `${(0xf6edb40 + n).toString(16)}${'0'.repeat(33)}`, ref: `juno/${n}` },
          labels: [{ name: 'builder:juno' }], body: `Closes #${n}` }))
        f.github.state.comments.set(15, [gave('Pip', '2026-11-09T07:20:00Z')])
        return f
      }
      const back = (f: ReturnType<typeof setup>) => f.said().filter(([n]) => n === 15).map(([, body]) => String(body).replace(/\d\d:\d\d/, 'HH:MM'))
      const room = inReview(3)
      await room.assigner.tick()
      expect(back(room)).toEqual(['Harness, HH:MM: Pip has not started it in 11 minutes, and Juno has nothing to do, so this task goes to the builder who can start it next.'])
      const full = inReview(4)
      await full.assigner.tick()
      expect(back(full)).toEqual([])
      expect(full.github.sent.filter(s => s.method === 'DELETE')).toEqual([])
    })

    // Pip's computer has the GPU #15 needs, and Juno's has none: Juno could not take it.
    it('stays when the builder with nothing cannot take it', async () => {
      const resources = { memoryTotalBytes: 64 * GiB, projectDiskFreeBytes: 500 * GiB }
      const team: Crew = { machines: [{ machineId: 'pc', observation: { resources: { ...resources, gpuPercent: 3 } } }, { machineId: 'mac', observation: { resources } }],
        builders: [{ ...crew().builders[0]!, machineId: 'pc' }, crew().builders[1]!] }
      const f = setup([issue(14, ['size:m', 'builder:pip', 'status:taken']), issue(15, ['size:m', 'builder:pip', 'needs:gpu'])], { crew: team })
      f.github.state.comments.set(15, [gave('Pip', '2026-11-09T07:00:00Z')])
      await f.assigner.tick()
      expect(f.github.sent.filter(s => s.method === 'DELETE')).toEqual([])
    })
  })

  it('takes back the tasks of a builder its person is stopping, says why, and gives them to another', async () => {
    const team: Crew = { ...crew(), builders: [crew().builders[0]!], away: [{ name: 'Juno', label: 'builder:juno', why: 'stopping' }] }
    const f = setup([issue(1, ['size:s', 'builder:juno', 'status:taken']), issue(2, ['size:m', 'builder:juno'])], { crew: team })
    f.github.state.applied = true
    await f.assigner.tick()
    // status:taken comes off after the builder's label too, taken at the read or not: a claim that lands while the task is
    // taken back (githubClaim.ts) would leave it taken with no builder, which nobody plans and neither side repairs.
    expect(f.github.sent.filter(s => s.method === 'DELETE').map(s => s.path)).toEqual(['/repos/acme/app/issues/1/labels/status%3Ataken',
      '/repos/acme/app/issues/1/labels/builder%3Ajuno', '/repos/acme/app/issues/1/labels/status%3Ataken',
      '/repos/acme/app/issues/2/labels/builder%3Ajuno', '/repos/acme/app/issues/2/labels/status%3Ataken'])
    expect(f.said().filter(([, body]) => String(body).includes('is being stopped')).map(([n]) => n)).toEqual([1, 2])
    // The next plan gives Pip the first of them, and the other once that one is up for its read.
    await f.assigner.tick()
    await f.assigner.tick()
    expect(f.labelled()).toEqual([[1, 'builder:pip']])
    f.github.state.open[0] = issue(1, ['size:s', 'builder:pip', 'status:taken'])
    f.github.state.pulls = [{ number: 30, draft: false, base: { ref: 'main' }, head: { sha: 'f6edb44c0ffee0000000000000000000000000ab', ref: 'pip/1' }, labels: [{ name: 'builder:pip' }], body: 'Closes #1' }]
    await f.assigner.tick()
    expect(f.labelled()).toEqual([[1, 'builder:pip'], [2, 'builder:pip']])
  })

  // githubClaim.ts marks a task taken, and takes its own mark off only when it sees its builder's label gone. One that lands
  // just before the label goes left the task taken with no builder: nobody plans it (readProblem), and neither side repaired it.
  it('leaves no task taken with no builder when a claim lands while the task is taken back', async () => {
    const team: Crew = { ...crew(), builders: [crew().builders[0]!], away: [{ name: 'Juno', label: 'builder:juno', why: 'stopping' }] }
    const f = setup([issue(2, ['size:m', 'builder:juno'])], { crew: team })
    // Juno's claim lands as its label is about to go.
    f.github.state.deleted = (task, label) => { if (label === 'builder:juno') task.labels = [...task.labels as Json[], { name: 'status:taken' }] }
    await f.assigner.tick()
    expect((f.github.state.open[0]!.labels as Json[]).map(l => l.name)).toEqual(['size:m', MARK])
    expect(f.said().filter(([, body]) => String(body).includes('is being stopped')).map(([n]) => n)).toEqual([2])
  })

  it('says so when GitHub refuses to take the taken mark off last, and has still taken the task back', async () => {
    const team: Crew = { ...crew(), builders: [crew().builders[0]!], away: [{ name: 'Juno', label: 'builder:juno', why: 'stopping' }] }
    const f = setup([issue(2, ['size:m', 'builder:juno'])], { crew: team })
    f.github.state.deleted = (_task, label) => label === 'status:taken' ? 403 : undefined
    await f.assigner.tick()
    // The builder's label is off: the task is taken back, and said so once.
    expect((f.github.state.open[0]!.labels as Json[]).map(l => l.name)).toEqual(['size:m', MARK])
    expect(f.said().filter(([, body]) => String(body).includes('is being stopped')).map(([n]) => n)).toEqual([2])
    expect(f.log.mock.calls.map(([line]) => String(line))).toContainEqual('[super-tab] Task assignment: TAKEN_NOT_CLEARED acme/app#2: GitHub answered 403')
    expect(f.log.mock.calls.some(([line]) => String(line).includes('TAKE_BACK_REFUSED'))).toBe(false)
  })

  // Moved by hand to another builder since the read, who may have claimed it: that claim is not this pass's to undo.
  it('takes no taken mark off a task whose builder label was already gone', async () => {
    const team: Crew = { ...crew(), builders: [crew().builders[0]!], away: [{ name: 'Juno', label: 'builder:juno', why: 'stopping' }] }
    const f = setup([issue(2, ['size:m', 'builder:juno'])], { crew: team })
    f.github.state.deleted = (task, label) => { if (label === 'builder:juno') task.labels = [{ name: 'size:m' }, { name: 'builder:pip' }, { name: 'status:taken' }] }
    await f.assigner.tick()
    expect(f.github.sent.filter(s => s.method === 'DELETE').map(s => s.path)).toEqual(['/repos/acme/app/issues/2/labels/builder%3Ajuno'])
    expect((f.github.state.open[0]!.labels as Json[]).map(l => l.name)).toEqual(['size:m', 'builder:pip', 'status:taken'])
  })

  it('keeps the task of a builder that went away while its pull request waits for its readers or its merge', async () => {
    const team: Crew = { ...crew(), builders: [crew().builders[0]!], away: [{ name: 'Juno', label: 'builder:juno', why: 'stopping' }] }
    const f = setup([issue(1, ['size:s', 'builder:juno', 'status:taken']), issue(2, ['size:s', 'builder:juno', 'status:taken'])], { crew: team })
    const head = (n: number) => `f6edb4${n}${'0'.repeat(33)}`
    f.github.state.pulls = [1, 2].map(n => ({ number: 8 + n, draft: false, base: { ref: 'main' }, labels: [{ name: 'builder:juno' }],
      head: { sha: head(n), ref: `juno/${n}` }, body: `Closes #${n}`, updated_at: '2026-11-09T07:00:00Z' }))
    // #9 (for #1) has its READ-OK and waits to merge; #10 (for #2) has a HOLD on its head, which Juno will not fix.
    f.github.state.comments.set(9, [{ body: `Pip, 07:10, to **Juno**: READ-OK ${head(1).slice(0, 7)}`, created_at: '2026-11-09T07:10:00Z', author_association: 'OWNER' }])
    f.github.state.comments.set(10, [{ body: `Pip, 07:10, to **Juno**: HOLD ${head(2).slice(0, 7)} app.ts:3 add the test`, created_at: '2026-11-09T07:10:00Z',
      author_association: 'OWNER' }])
    await f.assigner.tick()
    expect(f.github.sent.filter(s => s.method === 'DELETE').map(s => s.path)).toEqual(['/repos/acme/app/issues/2/labels/status%3Ataken',
      '/repos/acme/app/issues/2/labels/builder%3Ajuno', '/repos/acme/app/issues/2/labels/status%3Ataken'])
  })

  it('keeps a down builder\'s tasks while nobody else can take them, and gives back a stopping one\'s all the same', async () => {
    const long = new Date(Date.parse('2026-11-09T07:31:00Z') - 4 * 60 * 60_000).toISOString()
    const down = setup([issue(1, ['size:s', 'builder:pip']), issue(2, ['size:s', 'builder:pip', 'status:taken'])],
      { crew: { builders: [], machines: crew().machines, away: [{ name: 'Pip', label: 'builder:pip', why: 'down', since: long }] } })
    await down.assigner.tick()
    expect(down.github.sent.filter(s => s.method === 'DELETE')).toEqual([])
    const stopping = setup([issue(1, ['size:s', 'builder:pip'])],
      { crew: { builders: [], machines: crew().machines, away: [{ name: 'Pip', label: 'builder:pip', why: 'stopping' }] } })
    await stopping.assigner.tick()
    expect(stopping.github.sent.filter(s => s.method === 'DELETE').map(s => s.path)).toEqual(['/repos/acme/app/issues/1/labels/builder%3Apip',
      '/repos/acme/app/issues/1/labels/status%3Ataken'])
  })

  it('forgets the asks and take backs it made once their pull request or task is no longer open', async () => {
    const team: Crew = { ...crew(), away: [{ name: 'Atlas', label: 'builder:atlas', why: 'stopping' }] }
    const f = setup([issue(1, ['size:s', 'builder:atlas'])], { crew: team })
    f.github.state.pulls = [{ number: 30, draft: false, base: { ref: 'main' }, labels: [{ name: 'builder:pip' }],
      head: { sha: `f6edb44${'0'.repeat(33)}`, ref: 'pip/14' }, body: 'Closes #14' }]
    await f.assigner.tick()
    const memory = f.assigner as unknown as { asks: Set<string>; backs: Set<string> }
    expect([memory.asks.size, memory.backs.size]).toEqual([1, 1])
    f.github.state.pulls = []
    f.github.state.open = []
    await f.assigner.tick()
    expect([memory.asks.size, memory.backs.size]).toEqual([0, 0])
  })

  it('says a take back GitHub refuses, leaves the task as it was, and takes it back next pass', async () => {
    const team: Crew = { ...crew(), builders: [crew().builders[0]!], away: [{ name: 'Juno', label: 'builder:juno', why: 'stopping' }] }
    const f = setup([issue(1, ['size:s', 'builder:juno', 'status:taken'])], { crew: team })
    f.github.state.deleteAnswer = 403
    await f.assigner.tick()
    await f.assigner.tick()
    expect(f.said()).toEqual([])
    expect(f.log.mock.calls.filter(([line]) => String(line).includes('TAKE_BACK_REFUSED acme/app#1: GitHub answered 403'))).toHaveLength(1)
    f.github.state.deleteAnswer = 200
    await f.assigner.tick()
    expect(f.github.state.open[0]!.labels).toEqual([{ name: 'size:s' }, { name: MARK }])
    expect(f.said().filter(([, body]) => String(body).includes('is being stopped')).map(([n]) => n)).toEqual([1])
  })

  it('asks a PM again by the name it signs with, when it reads for a team of one builder', async () => {
    const f = setup([], { crew: { builders: [crew().builders[0]!], machines: crew().machines } })
    f.github.state.pulls = [{ number: 15, draft: false, base: { ref: 'main' }, labels: [{ name: 'builder:pip' }],
      head: { sha: `6b5ae5a${'0'.repeat(33)}`, ref: 'pip/13' }, body: '' }]
    f.github.state.comments.set(15, [{ body: 'Faye, 18:03, to **Pip**: HOLD c208f63 rebase on main', created_at: '2026-11-09T11:03:00Z',
      author_association: 'OWNER' }])
    await f.assigner.tick()
    expect(f.said()).toEqual([[15, expect.stringMatching(/^Harness, \d\d:\d\d, to \*\*Faye\*\*: the head is now 6b5ae5a, after your HOLD on c208f63/)]])
  })

  // A task that waits on pieces cut off it (githubSplit.ts) is others' to move: never called quiet while they are open. GitHub
  // does not touch a task as its piece closes (seen on a real repository, 2026-11-11), so by its own time it is quiet since its
  // builder's last cut: its quiet is counted from when it last waited, or from the word that its pieces are closed.
  it('never calls quiet a task that waits on its pieces, and counts its quiet from when they closed', async () => {
    const HOUR = 3_600_000
    const f = setup([issue(1, ['size:l', 'builder:pip', 'status:taken'], { sub_issues_summary: { total: 2, completed: 1 } })])
    f.github.state.open[0]!.updated_at = new Date(f.clock.now).toISOString()
    const asks = () => f.said().filter(([, body]) => String(body).includes('Are you still on it?'))
    const told = () => f.said().filter(([, body]) => String(body).includes('cut off this task'))
    for (const hours of [5, 20, 30]) { f.clock.now += hours * HOUR; await f.assigner.tick() }
    expect(asks()).toEqual([])
    expect(f.github.state.asked.filter(path => path.includes('/issues/1/comments'))).toEqual([])
    f.github.state.open[0]!.sub_issues_summary = { total: 2, completed: 2 }
    await f.assigner.tick()
    expect(told()).toHaveLength(1)
    // GitHub's list still shows the task's old time on the passes that follow, and for good had the word been refused: it
    // is quiet four hours after that word, as any task after its last touch.
    f.clock.now += 60_000
    await f.assigner.tick()
    f.clock.now += 3 * HOUR
    await f.assigner.tick()
    expect(asks()).toEqual([])
    f.clock.now += HOUR
    await f.assigner.tick()
    expect(asks()).toHaveLength(1)
    expect(told()).toHaveLength(1)
  })

  it('counts a task\'s quiet from when it last waited, whatever else is so: a piece opened again, a draft of its builder\'s, a word GitHub refused', async () => {
    const HOUR = 3_600_000, long = new Date(Date.parse('2026-11-09T07:31:00Z') - 9 * HOUR).toISOString()
    const asks = (f: ReturnType<typeof setup>) => f.said().filter(([, body]) => String(body).includes('Are you still on it?'))
    const told = (f: ReturnType<typeof setup>) => f.said().filter(([, body]) => String(body).includes('cut off this task')).map(([, body]) => String(body).replace(/^Harness, \d\d:\d\d, /, ''))
    // Both pieces close and its builder is told; one is opened again for six hours, and closes again: told again, not asked.
    const f = setup([issue(1, ['size:l', 'builder:pip', 'status:taken'], { sub_issues_summary: { total: 2, completed: 2 }, updated_at: long })])
    await f.assigner.tick()
    // The word of the first time they closed is on the task: it is not the word of the second.
    f.github.state.comments.set(1, [{ body: `Harness, 07:31, ${told(f)[0]}`, author_association: 'MEMBER', created_at: new Date(f.clock.now).toISOString() }])
    f.github.state.open[0]!.sub_issues_summary = { total: 2, completed: 1 }
    for (let hour = 0; hour < 6; hour++) { f.clock.now += HOUR; await f.assigner.tick() }
    f.github.state.open[0]!.sub_issues_summary = { total: 2, completed: 2 }
    await f.assigner.tick()
    expect(told(f)).toHaveLength(2)
    expect(asks(f)).toEqual([])
    // A draft pull request of its builder's for the task, older than the cut, is no touch since: told, and not asked.
    const g = setup([issue(1, ['size:l', 'builder:pip', 'status:taken'], { sub_issues_summary: { total: 1, completed: 0 }, updated_at: long })])
    g.github.state.pulls = [{ number: 30, draft: true, base: { ref: 'main' }, head: { sha: 'f6edb44c0ffee0000000000000000000000000ab', ref: 'pip/1' }, labels: [{ name: 'builder:pip' }], body: 'Closes #1',
      updated_at: long }]
    await g.assigner.tick()
    g.github.state.open[0]!.sub_issues_summary = { total: 1, completed: 1 }
    await g.assigner.tick()
    expect(told(g)).toEqual(['to **Pip**: the piece cut off this task is closed. It is yours to finish, or to close if nothing is left.'])
    expect(asks(g)).toEqual([])
    // A word GitHub would not take is tried again each pass, and the task is not called quiet meanwhile.
    const h = setup([issue(1, ['size:l', 'builder:pip', 'status:taken'], { sub_issues_summary: { total: 1, completed: 1 }, updated_at: long })])
    h.github.state.commentAnswer = 403
    await h.assigner.tick()
    h.clock.now += 5 * HOUR
    await h.assigner.tick()
    expect(h.said().map(([, body]) => String(body).replace(/^Harness, \d\d:\d\d, /, ''))).toEqual(Array(2).fill('to **Pip**: the piece cut off this task is closed. It is yours to finish, or to close if nothing is left.'))
    expect(h.log).toHaveBeenCalledWith('[super-tab] Task assignment: ASK_REFUSED acme/app#1: GitHub answered 403')
  })

  it('tells the PM once of a sized task nobody holds that waits on its pieces, and gives it to nobody', async () => {
    const f = setup([issue(1, ['size:l'], { sub_issues_summary: { total: 2, completed: 1 } }),
      // Not sized, held, or taken with no builder: not the PM's to be told of so.
      issue(2, [], { sub_issues_summary: { total: 1, completed: 0 } }), issue(3, ['size:s', 'builder:pip'], { sub_issues_summary: { total: 1, completed: 0 } }),
      issue(4, ['size:s', 'status:taken'], { sub_issues_summary: { total: 1, completed: 0 } })])
    await f.assigner.tick()
    await f.assigner.tick()
    expect(f.labelled()).toEqual([])
    expect(f.said()).toEqual([[1, expect.stringMatching(/^Harness, \d\d:\d\d, to \*\*Faye\*\*: nobody can start this yet: pieces cut off it are still open\.$/)]])
  })

  it('tells a task\'s builder once that every piece cut off it is closed, and finds that word after a restart', async () => {
    const HOUR = 3_600_000
    const f = setup([issue(1, ['size:l', 'builder:pip', 'status:taken'], { sub_issues_summary: { total: 2, completed: 1 } }),
      // Given and not taken, with no pieces, and another team's: nothing is said of them.
      issue(2, ['size:l', 'builder:juno'], { sub_issues_summary: { total: 1, completed: 1 } }), issue(3, ['size:l', 'builder:pip', 'status:taken'], { sub_issues_summary: { total: 0, completed: 0 } }),
      issue(4, ['size:l', 'builder:stranger', 'status:taken'], { sub_issues_summary: { total: 1, completed: 1 } })])
    const told = () => f.said().filter(([, body]) => String(body).includes('cut off this task')).map(([number, body]) => [number, String(body).replace(/^Harness, \d\d:\d\d, /, '')])
    const line = 'to **Pip**: all 2 pieces cut off this task are closed. It is yours to finish, or to close if nothing is left.'
    await f.assigner.tick()
    expect(told()).toEqual([])
    f.github.state.open[0]!.sub_issues_summary = { total: 2, completed: 2 }
    await f.assigner.tick()
    await f.assigner.tick()
    expect(told()).toEqual([[1, line]])
    // After a restart it is found said among the task's comments of the last day, and not said again.
    const said = (hoursAgo: number, association = 'MEMBER') => f.github.state.comments.set(1, [{ body: `Harness, 07:31, ${line}`, author_association: association,
      created_at: new Date(f.clock.now - hoursAgo * HOUR).toISOString() }])
    said(20)
    await f.make().tick()
    expect(told()).toHaveLength(1)
    // Said twenty hours ago and nothing since, the task is quiet from that word, and its builder is asked, as of any task.
    const asks = () => f.said().filter(([, body]) => String(body).includes('Are you still on it?')).length
    expect(asks()).toBe(1)
    // Found said an hour ago, with GitHub's list still showing the task's older time: quiet from that word, not asked now.
    f.github.state.open[0]!.updated_at = new Date(f.clock.now - 9 * HOUR).toISOString()
    said(1)
    await f.make().tick()
    expect(asks()).toBe(1)
    // A stranger's comment in the same words is not Harness's, and one of two days ago is not looked back to: it is said.
    for (const [hoursAgo, association] of [[1, 'NONE'], [48, 'MEMBER']] as const) {
      said(hoursAgo, association)
      const before = told().length
      await f.make().tick()
      expect(told()).toHaveLength(before + 1)
    }
    // A task closed is forgotten: opened again as it was, its builder is told again.
    const [first] = f.github.state.open.splice(0, 1)
    await f.assigner.tick()
    f.github.state.open.unshift(first!)
    f.github.state.comments.delete(1)
    const before = told().length
    await f.assigner.tick()
    expect(told()).toHaveLength(before + 1)
  })

  it('tells the PM of no more waiting tasks in a pass than it tells of blocked ones', async () => {
    const f = setup(Array.from({ length: 7 }, (_, n) => issue(n + 1, ['size:l'], { sub_issues_summary: { total: 1, completed: 0 } })))
    await f.assigner.tick()
    expect(f.said()).toHaveLength(5)
    await f.assigner.tick()
    expect(f.said().map(([number]) => number).sort()).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('moves nothing within a team of one builder: a quiet task stays, and so does one waiting for its quota', async () => {
    const HOUR = 3_600_000
    const one: Crew = { builders: [crew().builders[0]!], machines: crew().machines }
    const f = setup([issue(1, ['size:s', 'builder:pip', 'status:taken'])], { crew: one })
    f.github.state.open[0]!.updated_at = new Date(f.clock.now - 5 * HOUR).toISOString()
    await f.assigner.tick()
    f.clock.now += 5 * HOUR
    await f.assigner.tick()
    expect(f.said().filter(([, body]) => String(body).includes('Are you still on it?')).map(([, body]) => body))
      .toEqual([expect.stringMatching(/Say where it stands, or what you need\.$/)])
    expect(f.github.sent.some(s => s.method === 'DELETE')).toBe(false)
    // Out of quota for 3 hours, with a task waiting for it: with nobody else, it waits.
    const resetsAt = new Date(Date.parse('2026-11-09T07:31:00Z') + 3 * HOUR).toISOString()
    const short: Crew = { builders: one.builders, machines: [{ machineId: 'mac', observation: { ...crew().machines[0]!.observation,
      quotas: [{ engine: 'claude', known: true, windows: [{ name: 'five_hour', usedPercent: 99, resetsAt }] }] } }] }
    const waiting = setup([issue(2, ['size:s', 'builder:pip'])], { crew: short })
    await waiting.assigner.tick()
    expect(waiting.github.sent.some(s => s.method === 'DELETE')).toBe(false)
    // Juno, on another machine with its own subscription, can start it now.
    const two = setup([issue(2, ['size:s', 'builder:pip'])], { crew: { builders: [one.builders[0]!, { ...crew().builders[1]!, machineId: 'box' }],
      machines: [...short.machines, { machineId: 'box', observation: crew().machines[0]!.observation }] } })
    await two.assigner.tick()
    expect(two.github.sent.filter(s => s.method === 'DELETE').map(s => s.path)).toEqual(['/repos/acme/app/issues/2/labels/builder%3Apip',
      '/repos/acme/app/issues/2/labels/status%3Ataken'])
  })

  describe('quiet tasks', () => {
    const HOUR = 3_600_000
    const ago = (f: ReturnType<typeof setup>, hours: number) => new Date(f.clock.now - hours * HOUR).toISOString()
    const quietAsks = (f: ReturnType<typeof setup>) => f.said().filter(([, body]) => String(body).includes('Are you still on it?'))

    it('asks a builder about a task quiet for 4 hours, once, and gives it to another 4 hours after with no word', async () => {
      const f = setup([issue(1, ['size:s', 'builder:juno', 'status:taken'])])
      f.github.state.open[0]!.updated_at = ago(f, 5)
      f.github.state.applied = true
      await f.assigner.tick()
      expect(quietAsks(f)).toEqual([[1, expect.stringMatching(/to \*\*Juno\*\*: nothing has moved on this task for 5 h\. Are you still on it\?/)]])
      // The ask itself touches the issue; that is no answer.
      f.github.state.open[0]!.updated_at = new Date(f.clock.now + 1_000).toISOString()
      f.clock.now += 2 * HOUR
      await f.assigner.tick()
      expect(quietAsks(f)).toHaveLength(1)
      expect(f.github.sent.some(s => s.method === 'DELETE')).toBe(false)
      f.clock.now += 2 * HOUR
      await f.assigner.tick()
      expect(f.github.sent.filter(s => s.method === 'DELETE').map(s => s.path)).toEqual(['/repos/acme/app/issues/1/labels/status%3Ataken',
        '/repos/acme/app/issues/1/labels/builder%3Ajuno', '/repos/acme/app/issues/1/labels/status%3Ataken'])
      expect(f.said().some(([, body]) => String(body).includes('Juno has had no activity on it since it was asked'))).toBe(true)
    })

    // Code review of #4084: a line held back (githubWrites.ts) or refused was dropped without a word; the task moves all the same.
    it('takes a task back and gives it on all the same when GitHub refuses their lines, and says each line was not written', async () => {
      const f = setup([issue(1, ['size:s', 'builder:juno', 'status:taken'])])
      f.github.state.open[0]!.updated_at = ago(f, 5)
      await f.assigner.tick()
      f.github.state.commentAnswer = 429
      f.clock.now += 5 * HOUR
      await f.assigner.tick()
      await f.assigner.tick()
      expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/^\[super-tab\] took acme\/app#1 back: /))
      expect(f.log).toHaveBeenCalledWith('[super-tab] Task assignment: LINE_REFUSED acme/app#1: GitHub answered 429')
      expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/^\[super-tab\] gave acme\/app#1 to /))
    })

    it('after a restart, asks no second time, and gives the task to another 4 hours after its ask', async () => {
      const f = setup([issue(1, ['size:s', 'builder:juno', 'status:taken'])])
      f.github.state.open[0]!.updated_at = ago(f, 5)
      await f.assigner.tick()
      const [[, ask]] = quietAsks(f) as [[number, string]]
      // GitHub keeps the ask, and it is the issue's last touch.
      f.github.state.comments.set(1, [{ body: ask, created_at: new Date(f.clock.now).toISOString(), author_association: 'OWNER' }])
      f.github.state.open[0]!.updated_at = new Date(f.clock.now + 1_000).toISOString()
      f.clock.now += 2 * HOUR
      const restarted = f.make()
      await restarted.tick()
      expect(quietAsks(f)).toHaveLength(1)
      expect(f.github.sent.some(s => s.method === 'DELETE')).toBe(false)
      f.clock.now += 2 * HOUR + 60_000
      await restarted.tick()
      expect(quietAsks(f)).toHaveLength(1)
      expect(f.github.sent.filter(s => s.method === 'DELETE').map(s => s.path)).toEqual(['/repos/acme/app/issues/1/labels/status%3Ataken',
        '/repos/acme/app/issues/1/labels/builder%3Ajuno', '/repos/acme/app/issues/1/labels/status%3Ataken'])
    })

    it('says an ask GitHub refuses, and asks again next pass', async () => {
      const f = setup([issue(1, ['size:s', 'builder:juno', 'status:taken'])])
      f.github.state.open[0]!.updated_at = ago(f, 5)
      f.github.state.commentAnswer = 403
      await f.assigner.tick()
      expect(f.log.mock.calls.filter(([line]) => String(line).includes('ASK_REFUSED acme/app#1: GitHub answered 403'))).toHaveLength(1)
      f.github.state.commentAnswer = 201
      await f.assigner.tick()
      expect(quietAsks(f)).toHaveLength(2)
      expect(f.log).toHaveBeenCalledWith('[super-tab] asked Juno about quiet acme/app#1')
    })

    it('asks nothing while its pull request waits for its readers or its merge, and asks once a HOLD stands on its head', async () => {
      const f = setup([issue(1, ['size:s', 'builder:juno', 'status:taken'])])
      f.github.state.open[0]!.updated_at = ago(f, 5)
      const head = `f6edb44${'0'.repeat(33)}`
      f.github.state.pulls = [{ number: 9, draft: false, base: { ref: 'main' }, labels: [{ name: 'builder:juno' }], head: { sha: head, ref: 'juno/1' },
        body: 'Closes #1', updated_at: ago(f, 5) }]
      f.github.state.comments.set(9, [{ body: 'Pip, 02:31, to **Juno**: READ-OK f6edb44', created_at: ago(f, 5), author_association: 'OWNER' }])
      await f.assigner.tick()
      expect(quietAsks(f)).toEqual([])
      // A HOLD on its head: the builder's turn, and nothing has moved since.
      f.github.state.comments.set(9, [{ body: 'Pip, 02:31, to **Juno**: HOLD f6edb44 app.ts:3 add the test', created_at: ago(f, 5),
        author_association: 'OWNER' }])
      await f.assigner.tick()
      expect(quietAsks(f)).toEqual([[1, expect.stringContaining('to **Juno**: nothing has moved on this task for 5 h')]])
    })

    it('asks nothing while a pull request for it moves, and stands down once its builder answers', async () => {
      const busy = setup([issue(1, ['size:s', 'builder:juno', 'status:taken'])])
      busy.github.state.open[0]!.updated_at = ago(busy, 5)
      busy.github.state.pulls = [{ number: 9, draft: true, base: { ref: 'main' }, head: { sha: 'f6edb44c0ffee0000000000000000000000000ab', ref: 'juno/1' },
        body: 'Work in progress', updated_at: ago(busy, 1) }]
      await busy.assigner.tick()
      expect(quietAsks(busy)).toEqual([])
      const answered = setup([issue(1, ['size:s', 'builder:juno', 'status:taken'])])
      answered.github.state.open[0]!.updated_at = ago(answered, 5)
      await answered.assigner.tick()
      expect(quietAsks(answered)).toHaveLength(1)
      answered.clock.now += 30 * 60_000
      answered.github.state.open[0]!.updated_at = new Date(answered.clock.now).toISOString()
      answered.clock.now += 4 * HOUR
      await answered.assigner.tick()
      expect(answered.github.sent.some(s => s.method === 'DELETE')).toBe(false)
    })
  })

  /** Pip and Juno on one computer with memory for one middle task at a time. Juno holds #1, which its PM gave it; #2 is free. A
   *  builder is given one task at a time, so the time the plan gives a size shows in when Pip can start #2: once #1 ends. */
  const oneAtATime = (closed: Json[]) => {
    const f = setup([issue(1, ['size:m', 'builder:juno']), issue(2, ['size:m'])], { closed,
      crew: { builders: crew().builders, machines: [{ machineId: 'mac', observation: { resources: { memoryTotalBytes: 6 * GiB, projectDiskFreeBytes: 500 * GiB } } }] } })
    for (const n of [10, 11, 12]) f.github.state.comments.set(n, [{ body: 'Juno, 12:00, taken by Juno.', created_at: '2026-11-09T05:00:00Z' }])
    return f
  }

  it('plans with the time this project\'s finished tasks of a size took', async () => {
    const closedAt = (n: number) => ({ ...issue(n, ['size:m', 'builder:juno']), closed_at: '2026-11-09T05:40:00Z' })
    const f = oneAtATime([closedAt(10), closedAt(11), closedAt(12)])
    await f.assigner.tick()
    // Middle tasks took 40 minutes here, not the 90 a size:m is guessed at: Pip starts after 40.
    expect(f.said().map(([, body]) => String(body).replace(/^Harness, \d\d:\d\d: /, ''))).toEqual(['for **Pip**: it can start in 40 min.'])
  })

  it('learns only from tasks done: one closed as not planned is no measure of its size', async () => {
    const closedAt = (n: number, reason: string) => ({ ...issue(n, ['size:m', 'builder:juno']), closed_at: '2026-11-09T05:10:00Z', state_reason: reason })
    // Three middle tasks closed 10 minutes after they were taken, all dropped: nothing learned, the guess of 90 stands.
    const f = oneAtATime([closedAt(10, 'not_planned'), closedAt(11, 'not_planned'), closedAt(12, 'not_planned')])
    await f.assigner.tick()
    expect(f.said().map(([, body]) => String(body).replace(/^Harness, \d\d:\d\d: /, ''))).toEqual(['for **Pip**: it can start in 2 h.'])
  })

  it('stops while gh is signed out, says so once, and says when it runs again', async () => {
    const f = setup([issue(1, ['size:s'])])
    f.github.state.signedOut = true
    await f.assigner.tick()
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('Task assignment stopped · GH_SIGNED_OUT'))
    expect(f.github.sent).toEqual([])
  })
})
