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
  const state = { open, closed, labelAnswer: 200, signedOut: false, applied: false, files: new Map<string, string>(), labels: [] as Json[],
    pulls: [] as Json[], comments: new Map<number, Json[]>() }
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
    const labels = /\/issues\/(\d+)\/labels$/.exec(path)
    if (labels) {
      if (state.labelAnswer !== 200) return { status: state.labelAnswer, etag: null, body: {}, resetAt: null }
      if (state.applied) state.open.find(i => i.number === Number(labels[1]))!.labels = [...(state.open.find(i => i.number === Number(labels[1]))!.labels as Json[]),
        ...((body as Json).labels as string[]).map(name => ({ name }))]
      return { status: 200, etag: null, body: [], resetAt: null }
    }
    return { status: 201, etag: null, body: {}, resetAt: null }
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
  const make = () => new GitHubAssign({ projects: async () => [PROJECT], crew: async () => options.crew ?? crew(), get: github.get, send: github.send,
    now: () => Date.parse('2026-11-09T07:31:00Z'), log })
  const assigner = make()
  const labelled = () => github.sent.filter(s => /\/issues\/\d+\/labels$/.test(s.path)).map(s => [Number(s.path.split('/').at(-2)), (s.body.labels as string[])[0]])
  const said = () => github.sent.filter(s => s.path.endsWith('/comments')).map(s => [Number(s.path.split('/').at(-2)), String(s.body.body)])
  return { github, assigner, make, log, labelled, said }
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

  it('gives a builder the tasks of the area its instructions say it works on, and makes that area\'s label', async () => {
    const f = setup([issue(1, ['size:s', 'part:mobile']), issue(2, ['size:s', 'part:api'])])
    f.github.state.files.set('agents/Pip.md', '# Pip\nWorks on: Mobile\n\nMy rules.')
    f.github.state.labels = [{ name: 'part:api' }]
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

    it('says once when nobody but its author can read it', async () => {
      const f = setup([], { crew: { builders: [crew().builders[0]!], machines: crew().machines } })
      f.github.state.pulls = [pull()]
      await f.assigner.tick()
      await f.assigner.tick()
      expect(asks(f)).toEqual([])
      expect(f.log.mock.calls.filter(([line]) => String(line).includes('NO_READER acme/app#30'))).toHaveLength(1)
    })
  })

  it('stops while gh is signed out, says so once, and says when it runs again', async () => {
    const f = setup([issue(1, ['size:s'])])
    f.github.state.signedOut = true
    await f.assigner.tick()
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('Task assignment stopped · GH_SIGNED_OUT'))
    expect(f.github.sent).toEqual([])
  })
})
