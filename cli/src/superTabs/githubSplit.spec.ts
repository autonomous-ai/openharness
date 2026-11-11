import { describe, expect, it, vi } from 'vitest'
import type { GitHubGet, GitHubSend } from './githubRest.js'
import { PIECES_MAX, splitAsked, splitTask } from './githubSplit.js'
import { SuperTabHostError } from './wire.js'

type Json = Record<string, unknown>
const NOW = new Date(2026, 10, 11, 14, 5).getTime()

/** One repository's issues as GitHub's REST API answers for them (an issue, its sub-issues, its comments, a login's own open
 *  issues), and what was sent to it. */
function setup() {
  const task = { id: 3400, number: 34, state: 'open', title: 'Sync the settings', labels: [{ name: 'builder:pip' }, { name: 'status:taken' }, { name: 'size:l' },
    { name: 'part:sync' }, { name: 'needs:macos' }, { name: 'p1' }], html_url: 'https://github.com/acme/app/issues/34' }
  const repo = { issues: new Map<number, Json>([[34, task]]), under: new Map<number, number[]>(), comments: new Map<number, Json[]>(), next: 57, comment: 9001,
    down: false, fail: null as null | { method: string; path: RegExp; status: number },
    /** GitHub opens the issue without the labels it was sent, as it does for a login that may not label. */
    unlabelled: false,
    /** GitHub lists every login's open issues, whatever creator was asked for. */
    everyone: false }
  const sent: Array<{ method: string; path: string; body: unknown }> = []
  const answer = (status: number, body: unknown = null) => ({ status, etag: null, body, resetAt: null })
  const failing = (method: string, path: string) => {
    if (!repo.fail || repo.fail.method !== method || !repo.fail.path.test(path)) return 0
    if (!repo.fail.status) throw new Error('fetch failed')
    return repo.fail.status
  }
  const get: GitHubGet = async path => {
    if (repo.down) throw new Error('gh is not signed in on this computer: run `gh auth login`.')
    const failed = failing('GET', path)
    if (failed) return answer(failed)
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
      return answer(200, [...repo.issues.values()].filter(issue => issue.state === 'open' && (repo.everyone || String((issue.user as Json | undefined)?.login ?? '').toLowerCase() === url.searchParams.get('creator')?.toLowerCase())
        && Date.parse(String(issue.updated_at)) >= since).slice((page - 1) * per, page * per))
    }
    return answer(404)
  }
  const send: GitHubSend = async (method, path, body) => {
    sent.push({ method, path, body })
    const failed = failing(method, path)
    if (failed) return answer(failed)
    const under = /^\/repos\/acme\/app\/issues\/(\d+)\/sub_issues$/.exec(path), said = /^\/repos\/acme\/app\/issues\/(\d+)\/comments$/.exec(path)
    if (path === '/repos/acme/app/issues' && method === 'POST') {
      const asked = body as { title: string; body: string; labels: string[] }, number = repo.next++
      const made = { id: number * 100, number, state: 'open', title: asked.title, body: asked.body, labels: repo.unlabelled ? [] : asked.labels.map(name => ({ name })),
        html_url: `https://github.com/acme/app/issues/${number}`, user: { login: 'Pips-Person' }, updated_at: new Date(NOW).toISOString() }
      repo.issues.set(number, made)
      return answer(201, made)
    }
    if (under && method === 'POST') {
      const piece = [...repo.issues.values()].find(issue => issue.id === (body as Json).sub_issue_id)
      if (!piece) return answer(404)
      repo.under.set(Number(under[1]), [...repo.under.get(Number(under[1])) ?? [], Number(piece.number)])
      return answer(201, repo.issues.get(Number(under[1])))
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
    splitTask({ get, send, record, login: async () => 'pips-person', now: () => NOW }, agent,
      { repository: 'acme/app', number: 34, size: 'm', title: 'Sync the theme', text: 'Only the theme: read it at start, write it on change.', ...over })
  /** An open piece under task 34, as an earlier cut left it. */
  const piece = (title: string, state = 'open') => {
    const number = repo.next++
    repo.issues.set(number, { id: number * 100, number, state, title, body: 'Part of #34.', labels: [{ name: 'size:s' }], html_url: `https://github.com/acme/app/issues/${number}`,
      user: { login: 'pips-person' }, updated_at: new Date(NOW).toISOString() })
    repo.under.set(34, [...repo.under.get(34) ?? [], number])
    return number
  }
  return { repo, sent, record, split, pip, piece, task }
}
const refusal = async (made: Promise<unknown>) => made.then(() => null, error => error instanceof SuperTabHostError ? { code: error.code, message: error.message } : { thrown: error })

describe('a piece cut off a task, by command', () => {
  it('opens the piece with its size and the task\'s own labels, makes it a sub-issue, says so on the task and records that', async () => {
    const t = setup()
    expect(await t.split()).toEqual({ url: 'https://github.com/acme/app/issues/57', number: 57, cut: true, sized: true })
    expect(t.sent).toEqual([
      { method: 'POST', path: '/repos/acme/app/issues', body: { title: 'Sync the theme', body: 'Only the theme: read it at start, write it on change.\n\nPart of #34.',
        // Never its builder's label or its claim: Harness gives the piece to whoever can ship it soonest.
        labels: ['size:m', 'part:sync', 'needs:macos', 'p1'] } },
      { method: 'POST', path: '/repos/acme/app/issues/34/sub_issues', body: { sub_issue_id: 5700 } },
      { method: 'POST', path: '/repos/acme/app/issues/34/comments', body: { body: 'Pip, 14:05: split off #57: Sync the theme' } },
    ])
    expect(t.record.mock.calls).toEqual([['acme/app', '9001']])
  })

  it('opens a piece with no words of its own as the line that names its task', async () => {
    const t = setup()
    await t.split({ text: '  ' })
    expect(t.sent[0]!.body).toMatchObject({ body: 'Part of #34.' })
  })

  it('refuses, with nothing sent, a task the builder does not hold', async () => {
    const t = setup()
    const not = 'acme/app#34 is not a task you hold: you cut pieces only off one that carries builder:pip. Other work goes to your PM.'
    // Given to nobody, to another builder, and to this one and another: a label is anyone's words.
    for (const labels of [[{ name: 'size:l' }], [{ name: 'builder:juno' }], [{ name: 'builder:pip' }, { name: 'builder:juno' }], [{ name: 'builder:pip-two' }]]) {
      t.task.labels = labels
      expect(await refusal(t.split())).toEqual({ code: 'TASK_NOT_YOURS', message: not })
    }
    t.task.labels = [{ name: 'Builder:Pip' }]
    expect(await t.split()).toMatchObject({ cut: true })
    expect(t.sent).toHaveLength(3)
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
    t.repo.fail = { method: 'GET', path: /\/issues\/34$/, status: 500 }
    expect(await refusal(t.split())).toEqual({ code: 'GITHUB_REFUSED', message: 'GitHub answered 500 for acme/app#34. Nothing was changed.' })
    t.repo.fail = { method: 'GET', path: /\/sub_issues/, status: 410 }
    expect(await refusal(t.split())).toEqual({ code: 'GITHUB_REFUSED', message: 'GitHub answered 410 for acme/app#34. Nothing was changed.' })
    t.repo.fail = null
    t.repo.down = true
    expect(await refusal(t.split())).toEqual({ code: 'GITHUB_UNAVAILABLE', message: 'gh is not signed in on this computer: run `gh auth login`.' })
    expect(t.sent).toEqual([])
  })

  it('cuts a piece once when the command arrives twice', async () => {
    const t = setup()
    await t.split()
    expect(await t.split()).toEqual({ url: 'https://github.com/acme/app/issues/57', number: 57, cut: false, sized: true })
    expect(t.sent).toHaveLength(3)
    // The same comment is recorded again, which costs nothing (backend githubComments.ts).
    expect(t.record.mock.calls).toEqual([['acme/app', '9001'], ['acme/app', '9001']])
    // Another title is another piece.
    expect(await t.split({ title: 'Sync the font size' })).toMatchObject({ number: 58, cut: true })
  })

  it('refuses one more piece under a task with as many open as it may have, and counts no closed one', async () => {
    const t = setup()
    for (let n = 0; n < PIECES_MAX - 1; n++) t.piece(`Piece ${n}`)
    t.piece('Done already', 'closed')
    expect(await t.split()).toMatchObject({ cut: true })
    expect(await refusal(t.split({ title: 'One more' }))).toEqual({ code: 'PIECE_LIMIT',
      message: 'acme/app#34 has 10 open pieces already, and 10 is the most. Cut a piece off one of them, or wait for one to land.' })
    expect(t.sent.filter(call => call.path === '/repos/acme/app/issues')).toHaveLength(1)
  })

  it('finishes with the same command a cut whose issue was opened and not attached', async () => {
    const t = setup()
    t.repo.fail = { method: 'POST', path: /\/sub_issues$/, status: 502 }
    expect(await refusal(t.split())).toEqual({ code: 'GITHUB_REFUSED', message: 'GitHub answered 502 for acme/app#34. '
      + '#57 is open and not yet acme/app#34\'s piece in full. Run the same command again: it finishes the cut and opens nothing twice.' })
    t.repo.fail = null
    expect(await t.split()).toEqual({ url: 'https://github.com/acme/app/issues/57', number: 57, cut: true, sized: true })
    expect(t.sent.map(call => `${call.method} ${call.path}`)).toEqual(['POST /repos/acme/app/issues', 'POST /repos/acme/app/issues/34/sub_issues',
      'POST /repos/acme/app/issues/34/sub_issues', 'POST /repos/acme/app/issues/34/comments'])
    expect(t.repo.under.get(34)).toEqual([57])
  })

  it('takes for its own only an issue this login opened in the last hour for this task', async () => {
    const t = setup()
    const left = (over: Json) => t.repo.issues.set(70, { id: 7000, number: 70, state: 'open', title: 'Sync the theme', body: 'Words.\n\nPart of #34.', labels: [],
      html_url: 'https://github.com/acme/app/issues/70', user: { login: 'pips-person' }, updated_at: new Date(NOW - 59 * 60_000).toISOString(), ...over })
    // Another task's piece, an older one, a pull request, and another login's that GitHub lists all the same.
    t.repo.everyone = true
    for (const over of [{ body: 'Part of #35.' }, { updated_at: new Date(NOW - 61 * 60_000).toISOString() }, { pull_request: {} }, { user: { login: 'someone-else' } }]) {
      left(over)
      const before = t.sent.length
      expect(await t.split({ title: `Sync the theme` })).toMatchObject({ cut: true })
      expect(t.sent[before]).toMatchObject({ method: 'POST', path: '/repos/acme/app/issues' })
      // Each run opened its own piece: it is closed, so the next finds none under the task.
      for (const number of t.repo.under.get(34) ?? []) t.repo.issues.get(number)!.state = 'closed'
    }
    left({})
    const before = t.sent.length
    expect(await t.split()).toMatchObject({ number: 70, cut: true })
    expect(t.sent.slice(before).map(call => `${call.method} ${call.path}`)).toEqual(['POST /repos/acme/app/issues/34/sub_issues', 'POST /repos/acme/app/issues/34/comments'])
    expect(t.sent[before]!.body).toEqual({ sub_issue_id: 7000 })
  })

  it('posts only the line a cut left unsaid, and does not take another\'s line for it', async () => {
    const t = setup()
    t.repo.fail = { method: 'POST', path: /\/comments$/, status: 0 }
    expect(await refusal(t.split())).toEqual({ code: 'GITHUB_UNAVAILABLE', message: 'fetch failed. '
      + '#57 is open and not yet acme/app#34\'s piece in full. Run the same command again: it finishes the cut and opens nothing twice.' })
    t.repo.fail = null
    // Another login's line in the same words, and this login's for another agent and another piece, are not this cut's.
    t.repo.comments.set(34, [{ id: 1, body: 'Pip, 14:01: split off #57: Sync the theme', user: { login: 'someone-else' } },
      { id: 2, body: 'Pippa, 14:01: split off #57: Sync the theme', user: { login: 'pips-person' } }, { id: 3, body: 'Pip, 14:01: split off #5: Sync the theme', user: { login: 'pips-person' } },
      { id: 4, body: 'Pip, later: split off #57: Sync the theme', user: { login: 'pips-person' } }])
    expect(await t.split()).toMatchObject({ number: 57, cut: true })
    expect(t.sent.map(call => `${call.method} ${call.path}`).slice(-2)).toEqual(['POST /repos/acme/app/issues/34/comments', 'POST /repos/acme/app/issues/34/comments'])
    expect(t.record).toHaveBeenLastCalledWith('acme/app', '9001')
    // Said once: the next finds it.
    expect(await t.split()).toMatchObject({ cut: false })
    expect(t.record).toHaveBeenLastCalledWith('acme/app', '9001')
  })

  it('says a piece GitHub opened without its size, which nobody is given', async () => {
    const t = setup()
    t.repo.unlabelled = true
    expect(await t.split()).toEqual({ url: 'https://github.com/acme/app/issues/57', number: 57, cut: true, sized: false })
  })

  it('says what GitHub answers that is no piece, a list or a comment', async () => {
    const t = setup()
    t.repo.fail = { method: 'POST', path: /\/issues$/, status: 403 }
    expect(await refusal(t.split())).toEqual({ code: 'GITHUB_REFUSED', message: 'GitHub answered 403 for acme/app#34. Nothing was changed.' })
    t.repo.fail = { method: 'GET', path: /creator=/, status: 422 }
    expect(await refusal(t.split())).toEqual({ code: 'GITHUB_REFUSED', message: 'GitHub answered 422 for acme/app#34. Nothing was changed.' })
    t.repo.fail = null
    await t.split()
    t.repo.fail = { method: 'GET', path: /\/comments/, status: 500 }
    expect(await refusal(t.split())).toMatchObject({ code: 'GITHUB_REFUSED', message: expect.stringContaining('GitHub answered 500 for acme/app#34. #57 is open') })
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
    for (const over of [{ repository: 'acme' }, { repository: 'acme/../app' }, { number: 0 }, { number: 1.5 }, { size: 'xl' }, { size: undefined }, { title: ' ' }, { title: 'a\nb' },
      { title: 'x'.repeat(201) }, { title: 7 }, { text: undefined }, { text: 'x'.repeat(32_001) }]) {
      expect(splitAsked({ ...asked, ...over })).toBeNull()
    }
  })
})
