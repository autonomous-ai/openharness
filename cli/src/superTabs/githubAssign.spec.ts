import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Crew } from './assign/crew.js'
import { GitHubAssign } from './githubAssign.js'
import type { GitHubGet, GitHubSend } from './githubRest.js'

type Json = Record<string, unknown>
const GiB = 1024 ** 3
const issue = (number: number, labels: string[], extra: Json = {}): Json => ({ number, labels: labels.map(name => ({ name })), ...extra })
const PROJECT = { repo: 'acme/app', pm: 'Faye', tabId: 'tab', pmAgentId: 'faye', projectId: 'app' }

/** One repository's issues as GitHub's REST API answers them, with ETags, and what was sent to it. Labels sent are kept
 *  only once [applied] says GitHub's lists show them. */
function fakeGitHub(open: Json[], closed: Json[] = []) {
  // A repository already set up for the flow: its labels, and its builders' (a fresh one is set apart below).
  const labels = ['status:taken', 'size:s', 'size:m', 'size:l', 'p0', 'p1', 'p2', 'builder:pip', 'builder:juno', 'builder:atlas'].map(name => ({ name }))
  const state = { open, closed, labelAnswer: 200, deleteAnswer: 200, commentAnswer: 201, signedOut: false, applied: false,
    files: new Map<string, string>(), labels: labels as Json[], pulls: [] as Json[], comments: new Map<number, Json[]>() }
  const sent: Array<{ method: string; path: string; body: Json }> = []
  const get: GitHubGet = async (path, etag) => {
    if (state.signedOut) throw Object.assign(new Error('gh is not signed in on this computer: run `gh auth login`.'), { code: 'GH_SIGNED_OUT' })
    const url = new URL(`https://api.github.com${path}`)
    const file = /^\/repos\/acme\/app\/contents\/(.+)$/.exec(url.pathname)
    const text = file ? state.files.get(decodeURIComponent(file[1]!)) : undefined
    if (file && text === undefined) return { status: 404, etag: null, body: null, resetAt: null }
    const body = file ? { encoding: 'base64', content: Buffer.from(text!).toString('base64') }
      : url.pathname === '/repos/acme/app' ? { default_branch: 'main' }
      : url.pathname === '/repos/acme/app/pulls' ? state.pulls
      : /^\/repos\/acme\/app\/issues\/\d+\/comments$/.test(url.pathname) ? state.comments.get(Number(url.pathname.split('/').at(-2))) ?? []
      : url.pathname === '/repos/acme/app/labels' ? state.labels
      : url.pathname === '/repos/acme/app/issues' ? url.searchParams.get('state') === 'closed' ? state.closed : state.open
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
      if (state.deleteAnswer !== 200) return { status: state.deleteAnswer, etag: null, body: {}, resetAt: null }
      const target = state.open.find(i => i.number === Number(removed[1]))!
      target.labels = (target.labels as Json[]).filter(l => l.name !== decodeURIComponent(removed[2]!))
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
  return { state, sent, get, send }
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
    now: () => clock.now, log })
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
    // Said once, not every pass.
    await f.assigner.tick()
    expect(f.log.mock.calls.filter(([line]) => String(line).includes('UNPLACED'))).toHaveLength(1)
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
      created_at: '2026-11-09T07:00:00Z', ...extra })
    /** Pip (Claude Code) builds; Juno (Claude Code) and Atlas (Codex) can read. */
    const team: Crew = { builders: [...crew().builders, { id: 'atlas', name: 'Atlas', label: 'builder:atlas', machineId: 'mac', engine: 'codex' }],
      machines: crew().machines }
    const asks = (f: ReturnType<typeof setup>) => f.said().filter(([n]) => n === 30).map(([, body]) => String(body))

    it('asks nobody for a pull request that is not the team\'s: a person\'s, or a branch no builder of the team made', async () => {
      const f = setup([], { crew: team })
      f.github.state.pulls = [pull({ number: 31, head: { sha: HEAD, ref: 'ken/fix-login' }, labels: [], body: '' }),
        pull({ number: 32, head: { sha: HEAD, ref: 'fix-login' }, labels: [], body: '' })]
      await f.assigner.tick()
      expect(f.said()).toEqual([])
      // Their comments are not even read.
      expect(f.github.sent).toEqual([])
    })

    it('asks another reader once the one asked has not read for 2 hours, and nobody more once a READ-OK is on the head', async () => {
      const ask = (name: string, at: string) => comment(`Harness, ${at.slice(11, 16)}, to **${name}**: please read this pull request, `
        + 'and start your comment with READ-OK f6edb44 or HOLD f6edb44 (with the file, line and fix).', { created_at: at })
      // Atlas (Codex) was asked an hour and a half ago: still reading.
      const recent = setup([], { crew: team })
      recent.github.state.pulls = [pull()]
      recent.github.state.comments.set(30, [ask('Atlas', '2026-11-09T06:01:00Z')])
      await recent.assigner.tick()
      expect(asks(recent)).toEqual([])
      // Asked three hours ago with no word since: Juno is asked too.
      const f = setup([], { crew: team })
      f.github.state.pulls = [pull()]
      f.github.state.comments.set(30, [ask('Atlas', '2026-11-09T04:31:00Z')])
      await f.assigner.tick()
      await f.assigner.tick()
      expect(asks(f)).toEqual([expect.stringMatching(/to \*\*Juno\*\*: please read this pull request/)])
      // Atlas reads after all: its READ-OK counts, and nobody more is asked when Juno's ask is old too.
      f.github.state.comments.set(30, [ask('Atlas', '2026-11-09T04:31:00Z'), ask('Juno', '2026-11-09T04:40:00Z'),
        comment('Atlas, 07:30, to **Pip**: READ-OK f6edb44', { created_at: '2026-11-09T07:30:00Z' })])
      await f.make().tick()
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
      expect(asks(f)).toEqual([expect.stringMatching(/^Harness, \d\d:\d\d, to \*\*Atlas\*\*: please read this pull request, and start your comment with READ-OK f6edb44 or HOLD f6edb44/)])
      await f.assigner.tick()
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
        expect(asks(f).map(body => body.replace(/^Harness, \d\d:\d\d,/, 'Harness, HH:MM,'))).toEqual([`Harness, HH:MM, to **Juno**: the head is now abcdef1, `
          + `after your ${verdict} on f6edb44: please read it again, and start your comment with READ-OK abcdef1 or HOLD abcdef1 (with the file, line and fix).`])
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

  it('takes back the tasks of a builder its person is stopping, says why, and gives them to another', async () => {
    const team: Crew = { ...crew(), builders: [crew().builders[0]!], away: [{ name: 'Juno', label: 'builder:juno', why: 'stopping' }] }
    const f = setup([issue(1, ['size:s', 'builder:juno', 'status:taken']), issue(2, ['size:m', 'builder:juno'])], { crew: team })
    f.github.state.applied = true
    await f.assigner.tick()
    expect(f.github.sent.filter(s => s.method === 'DELETE').map(s => s.path)).toEqual(['/repos/acme/app/issues/1/labels/status%3Ataken',
      '/repos/acme/app/issues/1/labels/builder%3Ajuno', '/repos/acme/app/issues/2/labels/builder%3Ajuno'])
    expect(f.said().filter(([, body]) => String(body).includes('is being stopped')).map(([n]) => n)).toEqual([1, 2])
    // The next plan gives both to Pip, two deep.
    await f.assigner.tick()
    expect(f.labelled().map(([n, label]) => [n, label]).sort()).toEqual([[1, 'builder:pip'], [2, 'builder:pip']])
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
      '/repos/acme/app/issues/2/labels/builder%3Ajuno'])
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
    expect(two.github.sent.filter(s => s.method === 'DELETE').map(s => s.path)).toEqual(['/repos/acme/app/issues/2/labels/builder%3Apip'])
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
        '/repos/acme/app/issues/1/labels/builder%3Ajuno'])
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
        '/repos/acme/app/issues/1/labels/builder%3Ajuno'])
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
