import { describe, expect, it, vi } from 'vitest'
import type { GitHubGet, GitHubSend } from './githubRest.js'
import { PIECES_MAX, sameCut, splitAsked, splitTask } from './githubSplit.js'
import { SuperTabHostError } from './wire.js'

type Json = Record<string, unknown>
const NOW = new Date(2026, 10, 11, 14, 5).getTime()
const HERE = 'https://api.github.com/repos/acme/app'

/** One repository's issues as GitHub's REST API answers for them (an issue, its sub-issues, its comments, a login's own open
 *  issues), and what was sent to it. */
function setup() {
  const task: Json = { id: 3400, number: 34, state: 'open', title: 'Sync the settings', labels: [{ name: 'builder:pip' }, { name: 'status:taken' }, { name: 'size:l' },
    { name: 'part:sync' }, { name: 'needs:macos' }, { name: 'p1' }], html_url: 'https://github.com/acme/app/issues/34', repository_url: HERE }
  const repo = { issues: new Map<number, Json>([[34, task]]), under: new Map<number, number[]>(), comments: new Map<number, Json[]>(), next: 57, comment: 9001,
    down: false as boolean | 'unsaid', fail: null as null | Failure | Failure[],
    /** GitHub takes no label from this login, as from one that may not label: an issue opens without any, and a label put on is not kept. */
    unlabelled: false,
    /** GitHub lists every login's open issues, whatever creator was asked for. */
    everyone: false }
  const sent: Array<{ method: string; path: string; body: unknown }> = []
  const answer = (status: number, body: unknown = null, resetAt: number | null = null) => ({ status, etag: null, body, resetAt })
  const failing = (method: string, path: string) => {
    const fail = [repo.fail ?? []].flat().find(each => each.method === method && each.path.test(path))
    if (!fail) return null
    if (!fail.status) throw new Error('fetch failed')
    return answer(fail.status, null, fail.resetAt ?? null)
  }
  const get: GitHubGet = async path => {
    // gh says why it failed; a failure that says nothing is no Error.
    if (repo.down) throw repo.down === 'unsaid' ? 'no words' : new Error('gh is not signed in on this computer: run `gh auth login`.')
    const failed = failing('GET', path)
    if (failed) return failed
    const url = new URL(`https://api.github.com${path}`), p = url.pathname, page = Number(url.searchParams.get('page') ?? 1), per = Number(url.searchParams.get('per_page') ?? 30)
    const one = /^\/repos\/acme\/app\/issues\/(\d+)$/.exec(p), under = /^\/repos\/acme\/app\/issues\/(\d+)\/sub_issues$/.exec(p), said = /^\/repos\/acme\/app\/issues\/(\d+)\/comments$/.exec(p)
    if (one) {
      const issue = repo.issues.get(Number(one[1]))
      return issue ? answer(200, { ...issue, comments: (repo.comments.get(Number(one[1])) ?? []).length }) : answer(404)
    }
    if (under) return answer(200, (repo.under.get(Number(under[1])) ?? []).map(number => repo.issues.get(number)!).slice((page - 1) * per, page * per))
    if (said) return answer(200, (repo.comments.get(Number(said[1])) ?? []).slice((page - 1) * per, page * per))
    if (p === '/repos/acme/app/issues') {
      const since = Date.parse(url.searchParams.get('since') ?? '')
      return answer(200, [...repo.issues.values()].filter(issue => issue.state === 'open'
        && (repo.everyone || String((issue.user as Json | undefined)?.login ?? '').toLowerCase() === url.searchParams.get('creator')?.toLowerCase())
        && Date.parse(String(issue.updated_at)) >= since).slice((page - 1) * per, page * per))
    }
    return answer(404)
  }
  const send: GitHubSend = async (method, path, body) => {
    sent.push({ method, path, body })
    const failed = failing(method, path)
    if (failed) return failed
    const under = /^\/repos\/acme\/app\/issues\/(\d+)\/sub_issues$/.exec(path), said = /^\/repos\/acme\/app\/issues\/(\d+)\/comments$/.exec(path)
    const labels = /^\/repos\/acme\/app\/issues\/(\d+)\/labels$/.exec(path), one = /^\/repos\/acme\/app\/issues\/(\d+)$/.exec(path)
    if (path === '/repos/acme/app/issues' && method === 'POST') {
      const asked = body as { title: string; body: string; labels: string[] }, number = repo.next++
      const made = { id: number * 100, number, state: 'open', title: asked.title, body: asked.body, labels: repo.unlabelled ? [] : asked.labels.map(name => ({ name })),
        html_url: `https://github.com/acme/app/issues/${number}`, user: { login: 'Pips-Person' }, updated_at: new Date(NOW).toISOString(), repository_url: HERE }
      repo.issues.set(number, made)
      return answer(201, made)
    }
    if (under && method === 'POST') {
      const piece = [...repo.issues.values()].find(issue => issue.id === (body as Json).sub_issue_id)
      if (!piece) return answer(404)
      repo.under.set(Number(under[1]), [...repo.under.get(Number(under[1])) ?? [], Number(piece.number)])
      return answer(201, repo.issues.get(Number(under[1])))
    }
    if (labels && method === 'POST') {
      const issue = repo.issues.get(Number(labels[1]))!
      if (!repo.unlabelled) issue.labels = [...issue.labels as Json[], ...(body as { labels: string[] }).labels.map(name => ({ name }))]
      return answer(200, issue.labels)
    }
    if (one && method === 'PATCH') {
      Object.assign(repo.issues.get(Number(one[1]))!, body)
      return answer(200, repo.issues.get(Number(one[1])))
    }
    if (said && method === 'POST') {
      const made = { id: repo.comment++, html_url: `https://github.com/acme/app/issues/${said[1]}#issuecomment-${repo.comment - 1}`, body: String((body as Json).body),
        created_at: new Date(NOW).toISOString(), user: { login: 'Pips-Person' } }
      repo.comments.set(Number(said[1]), [...repo.comments.get(Number(said[1])) ?? [], made])
      return answer(201, made)
    }
    return answer(404)
  }
  const record = vi.fn(async (_repository: string, _commentId: string) => {})
  const pip = { name: 'Pip', repositories: new Set(['acme/app']) }
  const split = (over: Partial<{ number: number; size: 's' | 'm' | 'l'; title: string; text: string; repository: string }> = {}, agent = pip) =>
    splitTask({ get, send, record, login: async () => 'Pips-Person', now: () => NOW }, agent,
      { repository: 'acme/app', number: 34, size: 'm', title: 'Sync the theme', text: 'Only the theme: read it at start, write it on change.', ...over })
  /** A piece under task 34 as an earlier cut of this login's left it, or as [over] says. */
  const piece = (title: string, over: Json = {}) => {
    const number = repo.next++
    repo.issues.set(number, { id: number * 100, number, state: 'open', title, body: 'Part of #34.', labels: [{ name: 'size:s' }], html_url: `https://github.com/acme/app/issues/${number}`,
      user: { login: 'pips-person' }, updated_at: new Date(NOW).toISOString(), repository_url: HERE, ...over })
    repo.under.set(34, [...repo.under.get(34) ?? [], number])
    return number
  }
  const calls = (from = 0) => sent.slice(from).map(call => `${call.method} ${call.path.replace('/repos/acme/app', '')}`)
  return { repo, sent, record, split, pip, piece, task, calls, get, send }
}
/** A call GitHub fails: with [status], or with no answer at all when it is 0. */
interface Failure { method: string; path: RegExp; status: number; resetAt?: number }
const refusal = async (made: Promise<unknown>) => made.then(() => null, error => error instanceof SuperTabHostError ? { code: error.code, message: error.message } : { thrown: error })
const AGAIN = '#57 is open and not yet acme/app#34\'s piece in full. Run the same command again: it finishes the cut and opens nothing twice.'

describe('a piece cut off a task, by command', () => {
  it('opens the piece with the task\'s own labels, makes it a sub-issue, sizes it last, says so on the task and records that', async () => {
    const t = setup()
    expect(await t.split()).toEqual({ url: 'https://github.com/acme/app/issues/57', number: 57, cut: true, sized: true })
    expect(t.sent).toEqual([
      // Never its builder's label or its claim: Harness gives the piece to whoever can ship it soonest. Nor its size yet: an
      // issue with none is no task, so one that is never attached is never given out.
      { method: 'POST', path: '/repos/acme/app/issues', body: { title: 'Sync the theme', body: 'Only the theme: read it at start, write it on change.\n\nPart of #34.',
        labels: ['part:sync', 'needs:macos', 'p1'] } },
      { method: 'POST', path: '/repos/acme/app/issues/34/sub_issues', body: { sub_issue_id: 5700 } },
      { method: 'POST', path: '/repos/acme/app/issues/57/labels', body: { labels: ['size:m'] } },
      { method: 'POST', path: '/repos/acme/app/issues/34/comments', body: { body: 'Pip, 14:05: split off #57: Sync the theme' } },
    ])
    expect(t.record.mock.calls).toEqual([['acme/app', '9001']])
  })

  it('opens a piece with no words of its own as the line that names its task, in the repository as GitHub names it', async () => {
    const t = setup()
    await t.split({ text: '  ', repository: 'Acme/App' })
    expect(t.sent[0]).toMatchObject({ path: '/repos/acme/app/issues', body: { body: 'Part of #34.' } })
  })

  it('refuses, with nothing sent, a task that is not the builder\'s own, or that it has not taken', async () => {
    const t = setup()
    const not = 'acme/app#34 is not a task of yours: you cut pieces only off one that carries builder:pip. Other work goes to your PM.'
    // Given to nobody, to another builder, and to this one and another: a label is anyone's words.
    for (const labels of [['size:l', 'status:taken'], ['builder:juno', 'status:taken'], ['builder:pip', 'builder:juno', 'status:taken'], ['builder:pip-two', 'status:taken']]) {
      t.task.labels = labels.map(name => ({ name }))
      expect(await refusal(t.split())).toEqual({ code: 'TASK_NOT_YOURS', message: not })
    }
    // Given and not taken: it may go to another builder before this one works on it.
    t.task.labels = [{ name: 'builder:pip' }]
    expect(await refusal(t.split())).toEqual({ code: 'TASK_NOT_TAKEN', message: 'acme/app#34 is given to you and not taken. Take it first: harness super-tab take acme/app#34.' })
    expect(t.sent).toEqual([])
    t.task.labels = [{ name: 'Builder:Pip' }, { name: 'Status:Taken' }]
    expect(await t.split()).toMatchObject({ cut: true })
  })

  it('refuses, with nothing sent, what is no open task of the builder\'s project', async () => {
    const t = setup()
    expect(await refusal(t.split({ repository: 'acme/other' }))).toEqual({ code: 'REPOSITORY_NOT_PROJECT', message: 'acme/other is not the repository of a project you are in.' })
    expect(await refusal(t.split({}, { ...t.pip, name: ' ' }))).toEqual({ code: 'AGENT_UNNAMED', message: 'This agent has no name to cut a task under.' })
    expect(await refusal(t.split({ number: 99 }))).toEqual({ code: 'TASK_NOT_FOUND', message: 'acme/app#99 is not an issue this computer\'s GitHub login can read.' })
    t.repo.issues.set(34, { ...t.task, repository_url: 'https://api.github.com/repos/acme/elsewhere' })
    expect(await refusal(t.split())).toEqual({ code: 'TASK_NOT_FOUND', message: 'acme/app#34 was moved to another repository.' })
    t.repo.issues.set(34, { ...t.task, pull_request: {} })
    expect(await refusal(t.split())).toEqual({ code: 'NOT_A_TASK', message: 'acme/app#34 is a pull request. A task is an issue.' })
    t.repo.issues.set(34, { ...t.task, state: 'closed' })
    expect(await refusal(t.split())).toEqual({ code: 'TASK_CLOSED', message: 'acme/app#34 is closed.' })
    t.repo.issues.set(34, t.task)
    for (const [path, status] of [[/\/issues\/34$/, 500], [/\/sub_issues/, 410], [/creator=/, 422]] as const) {
      t.repo.fail = { method: 'GET', path, status }
      expect(await refusal(t.split())).toEqual({ code: 'GITHUB_REFUSED', message: `GitHub answered ${status} for acme/app#34. Nothing was changed.` })
    }
    t.repo.fail = { method: 'POST', path: /\/issues$/, status: 403 }
    expect(await refusal(t.split())).toEqual({ code: 'GITHUB_REFUSED', message: 'GitHub answered 403 for acme/app#34. Nothing was changed.' })
    t.repo.fail = null
    t.repo.down = true
    expect(await refusal(t.split())).toEqual({ code: 'GITHUB_UNAVAILABLE', message: 'gh is not signed in on this computer: run `gh auth login`.' })
    expect(t.calls()).toEqual(['POST /issues'])
  })

  it('reads a list GitHub answers as something else as a refusal', async () => {
    for (const path of [/\/sub_issues/, /creator=/]) {
      const t = setup(), reads = realGet(t)
      const get: GitHubGet = async (asked, etag) => path.test(asked) ? { status: 200, etag: null, resetAt: null, body: { message: 'not a list' } } : reads(asked, etag)
      const made = splitTask({ get, send: async () => ({ status: 500, etag: null, resetAt: null, body: null }), record: t.record, login: async () => 'pips-person', now: () => NOW },
        t.pip, { repository: 'acme/app', number: 34, size: 'm', title: 'Sync the theme', text: '' })
      expect(await refusal(made)).toEqual({ code: 'GITHUB_REFUSED', message: 'GitHub answered 200 for acme/app#34. Nothing was changed.' })
    }
  })

  it('cuts a piece once when the command arrives twice, whatever its words or size the second time', async () => {
    const t = setup()
    await t.split()
    expect(await t.split({ size: 'l', text: 'Said another way.' })).toEqual({ url: 'https://github.com/acme/app/issues/57', number: 57, cut: false, sized: true })
    expect(t.sent).toHaveLength(4)
    // The same comment is recorded again, which costs nothing (backend githubComments.ts).
    expect(t.record.mock.calls).toEqual([['acme/app', '9001'], ['acme/app', '9001']])
    // Built and closed since, the same command opens no second one and says nothing more.
    t.repo.issues.get(57)!.state = 'closed'
    expect(await t.split()).toEqual({ url: 'https://github.com/acme/app/issues/57', number: 57, cut: false, sized: true })
    expect(t.sent).toHaveLength(4)
    expect(t.record).toHaveBeenCalledTimes(2)
    // Another title is another piece.
    expect(await t.split({ title: 'Sync the font size' })).toMatchObject({ number: 58, cut: true })
  })

  it('refuses a title another\'s piece of the task has, and takes none of them for its own', async () => {
    // Attached by its PM and given to another builder, one of another repository, one that names another task, and a pull request.
    for (const over of [{ user: { login: 'the-pm' }, labels: [{ name: 'builder:juno' }, { name: 'status:taken' }] }, { repository_url: 'https://api.github.com/repos/acme/other' },
      { body: 'Part of #35.' }, { body: 'Part of #34. And more.' }, { pull_request: {} }]) {
      const t = setup()
      t.piece('Sync the theme', over)
      expect(await refusal(t.split()), JSON.stringify(over)).toEqual({ code: 'TITLE_TAKEN',
        message: '#57 under acme/app#34 has this title and is not a piece you cut. Give yours another title.' })
      expect(t.sent).toEqual([])
      expect(t.record).not.toHaveBeenCalled()
    }
  })

  it('refuses one more piece under a task with as many open as it may have, the ones not yet attached among them', async () => {
    const t = setup()
    for (let n = 0; n < PIECES_MAX - 2; n++) t.piece(`Piece ${n}`)
    t.piece('Done already', { state: 'closed' })
    // One this login opened for the task and could not attach counts; another task's, and another login's, do not.
    const left = (number: number, over: Json = {}) => t.repo.issues.set(number, { id: number * 100, number, state: 'open', title: `Left ${number}`, body: 'Part of #34.', labels: [],
      user: { login: 'pips-person' }, updated_at: new Date(NOW).toISOString(), repository_url: HERE, ...over })
    left(201); left(202, { body: 'Part of #35.' }); left(203, { user: { login: 'someone-else' } })
    t.repo.everyone = true
    expect(await t.split()).toMatchObject({ cut: true })
    expect(await refusal(t.split({ title: 'One more' }))).toEqual({ code: 'PIECE_LIMIT',
      message: 'acme/app#34 has 10 open pieces already, and 10 is the most. Cut a piece off one of them, or wait for one to land.' })
    expect(t.sent.filter(call => call.path === '/repos/acme/app/issues')).toHaveLength(1)
  })

  it('finishes with the same command a cut whose issue GitHub could not attach then, and gives nobody the issue meanwhile', async () => {
    for (const fail of [{ status: 502 }, { status: 429 }, { status: 403, resetAt: NOW + 60_000 }, { status: 0 }]) {
      const t = setup()
      t.repo.fail = { method: 'POST', path: /\/sub_issues$/, ...fail }
      expect(await refusal(t.split())).toEqual(fail.status ? { code: 'GITHUB_REFUSED', message: `GitHub answered ${fail.status} for acme/app#34. ${AGAIN}` }
        : { code: 'GITHUB_UNAVAILABLE', message: `fetch failed. ${AGAIN}` })
      // Open, and with no size: no task for anyone (assign/crew.ts readProblem).
      expect(t.repo.issues.get(57)).toMatchObject({ state: 'open', labels: [{ name: 'part:sync' }, { name: 'needs:macos' }, { name: 'p1' }] })
      t.repo.fail = null
      expect(await t.split({ text: 'Other words.' })).toEqual({ url: 'https://github.com/acme/app/issues/57', number: 57, cut: true, sized: true })
      expect(t.calls()).toEqual(['POST /issues', 'POST /issues/34/sub_issues', 'POST /issues/34/sub_issues', 'POST /issues/57/labels', 'POST /issues/34/comments'])
      expect(t.repo.under.get(34)).toEqual([57])
    }
  })

  it('closes again an issue GitHub will not make a piece, and says so', async () => {
    for (const status of [422, 403, 404, 410]) {
      const t = setup()
      t.repo.fail = { method: 'POST', path: /\/sub_issues$/, status }
      expect(await refusal(t.split())).toEqual({ code: 'PIECE_REFUSED', message: `GitHub will not make #57 a piece of acme/app#34 (it answered ${status}): `
        + 'a task holds a hundred pieces, eight levels deep. #57 was closed again.' })
      expect(t.calls()).toEqual(['POST /issues', 'POST /issues/34/sub_issues', 'PATCH /issues/57'])
      expect(t.sent[2]!.body).toEqual({ state: 'closed', state_reason: 'not_planned' })
      expect(t.repo.issues.get(57)).toMatchObject({ state: 'closed' })
      expect(t.record).not.toHaveBeenCalled()
    }
  })

  it('says an issue it could not close again when GitHub does not answer', async () => {
    const t = setup()
    t.repo.fail = [{ method: 'POST', path: /\/sub_issues$/, status: 422 }, { method: 'PATCH', path: /\/issues\/57$/, status: 0 }]
    expect(await refusal(t.split())).toMatchObject({ code: 'PIECE_REFUSED', message: expect.stringMatching(/#57 is still open: close it\.$/) })
  })

  it('reads what GitHub leaves out of an issue or a comment as nothing, and this computer\'s clock when given none', async () => {
    const t = setup()
    // A sub-issue and an open issue with nothing but their numbers, and a comment with no words: none is this cut's.
    t.repo.issues.set(80, { id: 8000, number: 80 })
    t.repo.under.set(34, [80])
    t.repo.issues.set(81, { id: 8100, number: 81, state: 'open', updated_at: new Date(Date.now()).toISOString() })
    t.repo.everyone = true
    t.repo.comments.set(34, [{ id: 5 }])
    const cut = () => splitTask({ get: t.get, send: t.send, record: t.record, login: async () => 'pips-person' }, t.pip, { repository: 'acme/app', number: 34, size: 's', title: 'Sync the theme', text: '' })
    expect(await cut()).toMatchObject({ number: 57, cut: true })
    expect(t.sent.at(-1)!.body).toEqual({ body: expect.stringMatching(/^Pip, \d\d:\d\d: split off #57: Sync the theme$/) })
    expect(await cut()).toMatchObject({ number: 57, cut: false })
    // A piece GitHub gives no address for is answered with none.
    Object.assign(t.repo.issues.get(57)!, { state: 'closed', html_url: undefined })
    expect(await cut()).toEqual({ url: '', number: 57, cut: false, sized: true })
    t.repo.issues.get(57)!.state = 'open'
    expect(await cut()).toMatchObject({ url: '', cut: false })
    t.repo.down = 'unsaid'
    expect(await refusal(cut())).toEqual({ code: 'GITHUB_UNAVAILABLE', message: 'GitHub could not be reached.' })
  })

  it('says an issue GitHub opened whose answer could not be read, and one it could not close', async () => {
    const answers: Record<string, { status: number; body: unknown }> = { 'POST /repos/acme/app/issues': { status: 201, body: { number: 'fifty-seven' } } }
    const t = setup()
    const send: GitHubSend = async (method, path) => ({ etag: null, resetAt: null, ...answers[`${method} ${path}`] ?? { status: 404, body: null } })
    const made = () => splitTask({ get: realGet(t), send, record: t.record, login: async () => 'pips-person', now: () => NOW }, t.pip,
      { repository: 'acme/app', number: 34, size: 'm', title: 'Sync the theme', text: '' })
    expect(await refusal(made())).toEqual({ code: 'GITHUB_REFUSED',
      message: 'GitHub opened an issue for acme/app#34 and its answer could not be read. Run the same command again: it finds that issue and finishes the cut.' })
    answers['POST /repos/acme/app/issues'] = { status: 201, body: { id: 5700, number: 57 } }
    answers['POST /repos/acme/app/issues/34/sub_issues'] = { status: 422, body: null }
    answers['PATCH /repos/acme/app/issues/57'] = { status: 403, body: null }
    expect(await refusal(made())).toEqual({ code: 'PIECE_REFUSED', message: 'GitHub will not make #57 a piece of acme/app#34 (it answered 422): '
      + 'a task holds a hundred pieces, eight levels deep. #57 is still open: close it.' })
  })

  it('takes for its own only an issue this login opened in the last hour for this task', async () => {
    const t = setup()
    const left = (over: Json) => t.repo.issues.set(70, { id: 7000, number: 70, state: 'open', title: 'Sync the theme', body: 'Words.\n\nPart of #34.\n', labels: [],
      html_url: 'https://github.com/acme/app/issues/70', user: { login: 'pips-person' }, updated_at: new Date(NOW - 59 * 60_000).toISOString(), repository_url: HERE, ...over })
    // Another task's piece, one that only mentions this task, an older one, a pull request, and another login's that GitHub lists all the same.
    t.repo.everyone = true
    for (const over of [{ body: 'Part of #35.' }, { body: 'Part of #34. Not its last line.' }, { updated_at: new Date(NOW - 61 * 60_000).toISOString() }, { pull_request: {} },
      { user: { login: 'someone-else' } }]) {
      left(over)
      const before = t.sent.length
      expect(await t.split(), JSON.stringify(over)).toMatchObject({ cut: true })
      expect(t.sent[before]).toMatchObject({ method: 'POST', path: '/repos/acme/app/issues' })
      // Each run cut its own piece: it is taken off the task again, so the next finds none under it.
      t.repo.under.set(34, [])
      t.repo.issues.delete(t.repo.next - 1)
    }
    left({})
    const before = t.sent.length
    expect(await t.split()).toMatchObject({ number: 70, cut: true })
    expect(t.calls(before)).toEqual(['POST /issues/34/sub_issues', 'POST /issues/70/labels', 'POST /issues/34/comments'])
    expect(t.sent[before]!.body).toEqual({ sub_issue_id: 7000 })
  })

  it('sizes with the same command a piece its size was not put on', async () => {
    const t = setup()
    t.repo.fail = { method: 'POST', path: /\/57\/labels$/, status: 502 }
    expect(await refusal(t.split())).toEqual({ code: 'GITHUB_REFUSED', message: `GitHub answered 502 for acme/app#34. ${AGAIN}` })
    t.repo.fail = null
    expect(await t.split()).toEqual({ url: 'https://github.com/acme/app/issues/57', number: 57, cut: true, sized: true })
    expect(t.calls()).toEqual(['POST /issues', 'POST /issues/34/sub_issues', 'POST /issues/57/labels', 'POST /issues/57/labels', 'POST /issues/34/comments'])
  })

  it('posts only the line a cut left unsaid, and does not take another\'s line for it', async () => {
    for (const fail of [{ status: 0 }, { status: 502 }]) {
      const t = setup()
      t.repo.fail = { method: 'POST', path: /\/comments$/, ...fail }
      expect(await refusal(t.split())).toEqual(fail.status ? { code: 'GITHUB_REFUSED', message: `GitHub answered 502 for acme/app#34. ${AGAIN}` }
        : { code: 'GITHUB_UNAVAILABLE', message: `fetch failed. ${AGAIN}` })
      t.repo.fail = null
      // Another login's line in the same words, this login's for another agent and for another piece, and one with no time.
      t.repo.comments.set(34, [{ id: 1, body: 'Pip, 14:01: split off #57: Sync the theme', user: { login: 'someone-else' } },
        { id: 2, body: 'Pia, 14:01: split off #57: Sync the theme', user: { login: 'pips-person' } }, { id: 3, body: 'Pip, 14:01: split off #5: Sync the theme', user: { login: 'pips-person' } },
        { id: 4, body: 'Pip, later: split off #57: Sync the theme', user: { login: 'pips-person' } }])
      expect(await t.split()).toMatchObject({ number: 57, cut: true })
      expect(t.calls().slice(-2)).toEqual(['POST /issues/34/comments', 'POST /issues/34/comments'])
      expect(t.record).toHaveBeenLastCalledWith('acme/app', '9001')
      // Said once: the next finds it, the newest of its own.
      expect(await t.split()).toMatchObject({ cut: false })
      expect(t.record).toHaveBeenLastCalledWith('acme/app', '9001')
      expect(t.sent.filter(call => call.path.endsWith('/comments'))).toHaveLength(2)
    }
  })

  it('finds its line among the task\'s last two hundred comments, and says it again past them', async () => {
    const t = setup()
    await t.split()
    const own = t.repo.comments.get(34)![0]!, other = (n: number) => ({ id: n, body: `Juno, 14:0${n % 10}: a word`, user: { login: 'the-pm' } })
    t.repo.comments.set(34, [...Array.from({ length: 30 }, (_, n) => other(n)), own, ...Array.from({ length: 150 }, (_, n) => other(100 + n))])
    expect(await t.split()).toMatchObject({ cut: false })
    t.repo.comments.set(34, [own, ...Array.from({ length: 200 }, (_, n) => other(n))])
    expect(await t.split()).toMatchObject({ cut: true })
    expect(t.repo.comments.get(34)!.at(-1)).toMatchObject({ body: 'Pip, 14:05: split off #57: Sync the theme' })
    // Of two lines of its own, the newest is the one recorded.
    t.repo.comments.get(34)!.push({ id: 9999, body: 'Pip, 14:09: split off #57: Sync the theme', user: { login: 'pips-person' } })
    expect(await t.split()).toMatchObject({ cut: false })
    expect(t.record).toHaveBeenLastCalledWith('acme/app', '9999')
    t.repo.fail = { method: 'GET', path: /\/comments/, status: 500 }
    expect(await refusal(t.split())).toEqual({ code: 'GITHUB_REFUSED', message: `GitHub answered 500 for acme/app#34. ${AGAIN}` })
  })

  it('says in words a piece GitHub kept no size on, each time, without saying its line twice', async () => {
    const t = setup()
    t.repo.unlabelled = true
    const unsized = { url: 'https://github.com/acme/app/issues/57', number: 57, sized: false,
      note: 'GitHub did not keep #57\'s size, and nobody is given a task with none. Ask your PM to size it.' }
    expect(await t.split()).toEqual({ ...unsized, cut: true })
    expect(await t.split()).toEqual({ ...unsized, cut: true })
    expect(t.calls()).toEqual(['POST /issues', 'POST /issues/34/sub_issues', 'POST /issues/57/labels', 'POST /issues/34/comments', 'POST /issues/57/labels'])
  })

  it('says a cut the server did not record as the builder\'s', async () => {
    const t = setup()
    t.record.mockRejectedValueOnce(new SuperTabHostError('COMMENT_NOT_YOURS', 'Another agent wrote this comment.', 409))
    expect(await refusal(t.split())).toEqual({ code: 'NOT_RECORDED',
      message: 'Split (https://github.com/acme/app/issues/34#issuecomment-9001), but it is not recorded as yours: Another agent wrote this comment. (COMMENT_NOT_YOURS)' })
  })

  it('reads a request for a piece: a repository, a task, a size, a title on one line and its words', () => {
    const asked = { repository: 'Acme/App', number: 34, size: 'm', title: '  Sync the theme ', text: '' }
    expect(splitAsked(asked)).toEqual({ repository: 'Acme/App', number: 34, size: 'm', title: 'Sync the theme', text: '' })
    // Harness types a task's title to its builder: no line of its own inside one.
    for (const over of [{ repository: 'acme' }, { repository: 'acme/../app' }, { number: 0 }, { number: 1.5 }, { size: 'xl' }, { size: undefined }, { title: ' ' }, { title: 'a\nb' },
      { title: 'a b' }, { title: 'a b' }, { title: 'a\u0085b' }, { title: 'a\u007fb' }, { title: 'x'.repeat(201) }, { title: 7 }, { text: undefined }, { text: 'x'.repeat(32_001) }]) {
      expect(splitAsked({ ...asked, ...over }), JSON.stringify(over)).toBeNull()
    }
  })

  it('knows the same cut by its task and title, whatever its words, its size or the repository\'s case', () => {
    const asked = splitAsked({ repository: 'Acme/App', number: 34, size: 'm', title: 'Sync the theme', text: 'One way.' })!
    expect(sameCut(asked)).toBe(sameCut({ ...asked, repository: 'acme/app', size: 'l', text: 'Another way.' }))
    expect(sameCut(asked)).not.toBe(sameCut({ ...asked, title: 'Sync the font' }))
    expect(sameCut(asked)).not.toBe(sameCut({ ...asked, number: 35 }))
  })
})

/** The fake repository's reads alone, for a test that answers the writes itself. */
function realGet(t: ReturnType<typeof setup>): GitHubGet {
  return async path => {
    const url = new URL(`https://api.github.com${path}`), one = /^\/repos\/acme\/app\/issues\/(\d+)$/.exec(url.pathname)
    return { status: 200, etag: null, resetAt: null, body: one ? { ...t.repo.issues.get(Number(one[1])), comments: 0 } : [] }
  }
}
