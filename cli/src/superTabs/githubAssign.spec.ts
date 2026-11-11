import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Crew } from './assign/crew.js'
import { parseSuperTabArgs } from './command.js'
import { GitHubAssign } from './githubAssign.js'
import { VerdictRecords } from './githubMerge.js'
import type { GitHubGet, GitHubSend } from './githubRest.js'
import { commandRecords } from './commandRecords.fake.js'

type Json = Record<string, unknown>
const GiB = 1024 ** 3
const issue = (number: number, labels: string[], extra: Json = {}): Json => ({ number, labels: labels.map(name => ({ name })), ...extra })
const PROJECT = { repo: 'acme/app', pm: 'Faye', tabId: 'tab', pmAgentId: 'faye', projectId: 'app', channel: 'lead' }

/** One repository's issues as GitHub's REST API answers them, with ETags, and what was sent to it. Labels sent are kept
 *  only once [applied] says GitHub's lists show them. */
function fakeGitHub(open: Json[], closed: Json[] = []) {
  const records = commandRecords()
  // A repository already set up for the flow: its labels, and its builders' (a fresh one is set apart below).
  const labels = ['status:taken', 'size:s', 'size:m', 'size:l', 'p0', 'p1', 'p2', 'builder:pip', 'builder:juno', 'builder:atlas'].map(name => ({ name }))
  const state = { open, closed, labelAnswer: 200, deleteAnswer: 200, commentAnswer: 201, signedOut: false, applied: false,
    /** Runs as a label's DELETE arrives, before it is answered: a test changes the issue here, or refuses the call with a status. */
    deleted: null as ((issue: Json, label: string) => number | void) | null,
    files: new Map<string, string>(), labels: labels as Json[], pulls: [] as Json[], comments: new Map<number, Json[]>(), reviews: new Map<number, Json[]>(), compare: new Map<string, Json>() }
  const sent: Array<{ method: string; path: string; body: Json }> = []
  const get: GitHubGet = async (path, etag) => {
    if (state.signedOut) throw Object.assign(new Error('gh is not signed in on this computer: run `gh auth login`.'), { code: 'GH_SIGNED_OUT' })
    const url = new URL(`https://api.github.com${path}`)
    const file = /^\/repos\/acme\/app\/contents\/(.+)$/.exec(url.pathname)
    const text = file ? state.files.get(decodeURIComponent(file[1]!)) : undefined
    if (file && text === undefined) return { status: 404, etag: null, body: null, resetAt: null }
    const body = file ? { encoding: 'base64', content: Buffer.from(text!).toString('base64') }
      : url.pathname === '/repos/acme/app' ? { default_branch: 'main' }
      // A page of the list, as GitHub pages it.
      : url.pathname === '/repos/acme/app/pulls' ? state.pulls.slice((Number(url.searchParams.get('page') ?? 1) - 1) * Number(url.searchParams.get('per_page') ?? 30),
        Number(url.searchParams.get('page') ?? 1) * Number(url.searchParams.get('per_page') ?? 30))
      : /^\/repos\/acme\/app\/issues\/\d+\/comments$/.test(url.pathname) ? (state.comments.get(Number(url.pathname.split('/').at(-2))) ?? []).map(records.served)
      : /^\/repos\/acme\/app\/pulls\/\d+\/reviews$/.test(url.pathname) ? state.reviews.get(Number(url.pathname.split('/').at(-2))) ?? []
      // A head against main, from the commit of main it stands on.
      : /^\/repos\/acme\/app\/compare\/main\.\.\.[0-9a-f]+$/.test(url.pathname) ? state.compare.has(url.pathname.split('...').at(-1)!)
        ? { merge_base_commit: { sha: 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0' }, ...state.compare.get(url.pathname.split('...').at(-1)!) as Json } : null
      : url.pathname === '/repos/acme/app/labels' ? state.labels
      // A page of the list, as GitHub pages it.
      : url.pathname === '/repos/acme/app/issues' ? (url.searchParams.get('state') === 'closed' ? state.closed : state.open)
        .slice((Number(url.searchParams.get('page') ?? 1) - 1) * Number(url.searchParams.get('per_page') ?? 30), Number(url.searchParams.get('page') ?? 1) * Number(url.searchParams.get('per_page') ?? 30))
      : null
    if (body === null) return { status: 404, etag: null, body: null, resetAt: null }
    const tag = `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`
    return etag === tag ? { status: 304, etag: tag, body: null, resetAt: null } : { status: 200, etag: tag, body, resetAt: null }
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
  return { state, sent, get, send, authors: records.authors }
}

/** Pip and Juno on one Mac with room and quota. */
const crew = (): Crew => ({
  builders: [{ id: 'pip', name: 'Pip', label: 'builder:pip', machineId: 'mac', engine: 'claude' },
    { id: 'juno', name: 'Juno', label: 'builder:juno', machineId: 'mac', engine: 'claude' }],
  machines: [{ machineId: 'mac', observation: { resources: { memoryTotalBytes: 64 * GiB, projectDiskFreeBytes: 500 * GiB } } }],
})

function setup(open: Json[], options: { closed?: Json[]; crew?: Crew } = {}) {
  const github = fakeGitHub(open, options.closed)
  const log = vi.fn()
  const clock = { now: Date.parse('2026-11-09T07:31:00Z') }
  const make = () => new GitHubAssign({ projects: async () => [PROJECT], crew: async () => options.crew ?? crew(), get: github.get, send: github.send,
    now: () => clock.now, log, records: new VerdictRecords(github.authors, () => clock.now, log) })
  const assigner = make()
  const labelled = () => github.sent.filter(s => /\/issues\/\d+\/labels$/.test(s.path)).map(s => [Number(s.path.split('/').at(-2)), (s.body.labels as string[])[0]])
  const said = () => github.sent.filter(s => s.path.endsWith('/comments')).map(s => [Number(s.path.split('/').at(-2)), String(s.body.body)])
  return { github, assigner, make, log, labelled, said, clock }
}

describe('Harness gives a team\'s tasks to its builders (githubAssign.ts)', () => {
  it('gives each builder what it starts next, two deep, labelled, with one line of why', async () => {
    const f = setup([issue(1, ['size:s', 'p0']), issue(2, ['size:m', 'p1']), issue(3, ['size:m']), issue(4, ['size:m']), issue(5, ['size:m'])])
    await f.assigner.tick()
    const given = f.labelled()
    expect(given).toHaveLength(4)
    expect(given.filter(([, label]) => label === 'builder:pip')).toHaveLength(2)
    expect(given.filter(([, label]) => label === 'builder:juno')).toHaveLength(2)
    // The p0 and the p1 go first, each to a builder that can start it now.
    expect(given.map(([n]) => n)).toEqual(expect.arrayContaining([1, 2]))
    const why = new Map(f.said() as Array<[number, string]>)
    expect(why.get(1)).toMatch(/^Harness, \d\d:\d\d: for \*\*(Pip|Juno)\*\*: it can start now\.$/)
    expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/^\[super-tab\] gave acme\/app#1 to (Pip|Juno) \(it can start now\)$/))
  })

  it('gives a task once, though GitHub\'s lists have not caught up with its label yet', async () => {
    const f = setup([issue(1, ['size:s'])])
    await f.assigner.tick()
    await f.assigner.tick()
    expect(f.labelled()).toHaveLength(1)
    expect(f.said()).toHaveLength(1)
  })

  it('keeps two deep while GitHub\'s list lags behind the labels it gave', async () => {
    const f = setup([issue(1, ['size:s']), issue(2, ['size:s']), issue(3, ['size:s']), issue(4, ['size:s']), issue(5, ['size:s']), issue(6, ['size:s'])])
    await f.assigner.tick()
    // The list still shows no labels: nobody gets a third task.
    f.github.state.open.push(issue(7, ['size:s']))
    await f.assigner.tick()
    const count = (label: string) => f.labelled().filter(([, l]) => l === label).length
    expect([count('builder:pip'), count('builder:juno')]).toEqual([2, 2])
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

  it('gives nothing the PM has not sized, nothing to a team with no builders, and keeps a full list full', async () => {
    const unsized = setup([issue(1, ['part:api'])])
    await unsized.assigner.tick()
    expect(unsized.github.sent).toEqual([])
    const nobody = setup([issue(1, ['size:s'])], { crew: { builders: [], machines: [] } })
    await nobody.assigner.tick()
    expect(nobody.github.sent).toEqual([])
    const full = setup([issue(1, ['size:m', 'builder:pip']), issue(2, ['size:m', 'builder:pip']), issue(3, ['size:m', 'builder:juno']),
      issue(4, ['size:m', 'builder:juno']), issue(5, ['size:s'])])
    await full.assigner.tick()
    expect(full.github.sent).toEqual([])
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
    expect(made()).toEqual(['status:taken', 'size:s', 'size:m', 'size:l', 'p0', 'p2', 'builder:pip', 'builder:juno'])
    expect(f.github.sent.find(s => s.body.name === 'size:s')!.body).toEqual({ name: 'size:s', color: 'c2e0c6', description: 'About half an hour of work' })
    // Read and made once: the next pass asks GitHub for nothing about labels.
    await f.assigner.tick()
    expect(made()).toHaveLength(8)
    const refused = setup([])
    refused.github.state.labels = []
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

    it('asks the only reader again after 30 silent minutes, at most twice more for a head, after a restart too', async () => {
      // Half the wait for a verdict.
      const STEP = 15 * 60_000
      const askedAt = (at: string) => comment(`Harness, ${at.slice(11, 16)}, to **Faye**: please read this pull request, and start your `
        + 'comment with READ-OK f6edb44 or HOLD f6edb44 (with the file, line and fix).', { created_at: at })
      // Pip builds alone; Faye, its PM, was asked 45 minutes ago and has said nothing since (stopped when it was asked).
      const f = setup([], { crew: { builders: [crew().builders[0]!], machines: crew().machines } })
      f.github.state.pulls = [pull()]
      const iso = (ms: number) => new Date(ms).toISOString()
      const first = iso(f.clock.now - 3 * STEP)
      f.github.state.comments.set(30, [askedAt(first)])
      await f.assigner.tick()
      expect(asks(f)).toEqual([expect.stringMatching(/to \*\*Faye\*\*: please read this pull request/)])
      f.github.state.comments.set(30, [askedAt(first), askedAt(iso(f.clock.now))])
      f.clock.now += STEP
      await f.assigner.tick()
      expect(asks(f)).toHaveLength(1)
      f.clock.now += STEP + 60_000
      await f.make().tick()
      expect(asks(f)).toHaveLength(2)
      f.github.state.comments.set(30, [askedAt(first), askedAt(iso(f.clock.now - 2 * STEP)), askedAt(iso(f.clock.now))])
      f.clock.now += 3 * STEP
      await f.make().tick()
      expect(asks(f)).toHaveLength(2)
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
  // waits two deep behind its builder's other work while another builder sits with nothing.
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
    // The next plan gives both to Pip, two deep.
    await f.assigner.tick()
    expect(f.labelled().map(([n, label]) => [n, label]).sort()).toEqual([[1, 'builder:pip'], [2, 'builder:pip']])
  })

  // githubClaim.ts marks a task taken, and takes its own mark off only when it sees its builder's label gone. One that lands
  // just before the label goes left the task taken with no builder: nobody plans it (readProblem), and neither side repaired it.
  it('leaves no task taken with no builder when a claim lands while the task is taken back', async () => {
    const team: Crew = { ...crew(), builders: [crew().builders[0]!], away: [{ name: 'Juno', label: 'builder:juno', why: 'stopping' }] }
    const f = setup([issue(2, ['size:m', 'builder:juno'])], { crew: team })
    // Juno's claim lands as its label is about to go.
    f.github.state.deleted = (task, label) => { if (label === 'builder:juno') task.labels = [...task.labels as Json[], { name: 'status:taken' }] }
    await f.assigner.tick()
    expect((f.github.state.open[0]!.labels as Json[]).map(l => l.name)).toEqual(['size:m'])
    expect(f.said().filter(([, body]) => String(body).includes('is being stopped')).map(([n]) => n)).toEqual([2])
  })

  it('says so when GitHub refuses to take the taken mark off last, and has still taken the task back', async () => {
    const team: Crew = { ...crew(), builders: [crew().builders[0]!], away: [{ name: 'Juno', label: 'builder:juno', why: 'stopping' }] }
    const f = setup([issue(2, ['size:m', 'builder:juno'])], { crew: team })
    f.github.state.deleted = (_task, label) => label === 'status:taken' ? 403 : undefined
    await f.assigner.tick()
    // The builder's label is off: the task is taken back, and said so once.
    expect((f.github.state.open[0]!.labels as Json[]).map(l => l.name)).toEqual(['size:m'])
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
    expect(f.github.state.open[0]!.labels).toEqual([{ name: 'size:s' }])
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

  it('plans with the time this project\'s finished tasks of a size took', async () => {
    const closedAt = (n: number) => ({ ...issue(n, ['size:m', 'builder:juno']), closed_at: '2026-11-09T05:40:00Z' })
    const one: Crew = { ...crew(), builders: [crew().builders[0]!] }
    const f = setup([issue(1, ['size:m']), issue(2, ['size:m'])], { crew: one, closed: [closedAt(10), closedAt(11), closedAt(12)] })
    for (const n of [10, 11, 12]) f.github.state.comments.set(n, [{ body: 'Juno, 12:00, taken by Juno.', created_at: '2026-11-09T05:00:00Z' }])
    await f.assigner.tick()
    // Middle tasks took 40 minutes here, not the 90 a size:m is guessed at: Pip's second starts after 40.
    expect(f.said().map(([, body]) => String(body).replace(/^Harness, \d\d:\d\d: /, '')).sort())
      .toEqual(['for **Pip**: it can start in 40 min.', 'for **Pip**: it can start now.'])
  })

  it('learns only from tasks done: one closed as not planned is no measure of its size', async () => {
    const closedAt = (n: number, reason: string) => ({ ...issue(n, ['size:m', 'builder:juno']), closed_at: '2026-11-09T05:10:00Z', state_reason: reason })
    const one: Crew = { ...crew(), builders: [crew().builders[0]!] }
    // Three middle tasks closed 10 minutes after they were taken, all dropped: nothing learned, the guess of 90 stands.
    const f = setup([issue(1, ['size:m']), issue(2, ['size:m'])], { crew: one,
      closed: [closedAt(10, 'not_planned'), closedAt(11, 'not_planned'), closedAt(12, 'not_planned')] })
    for (const n of [10, 11, 12]) f.github.state.comments.set(n, [{ body: 'Juno, 12:00, taken by Juno.', created_at: '2026-11-09T05:00:00Z' }])
    await f.assigner.tick()
    expect(f.said().map(([, body]) => String(body).replace(/^Harness, \d\d:\d\d: /, '')).sort())
      .toEqual(['for **Pip**: it can start in 2 h.', 'for **Pip**: it can start now.'])
  })

  it('stops while gh is signed out, says so once, and says when it runs again', async () => {
    const f = setup([issue(1, ['size:s'])])
    f.github.state.signedOut = true
    await f.assigner.tick()
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('Task assignment stopped · GH_SIGNED_OUT'))
    expect(f.github.sent).toEqual([])
  })
})
