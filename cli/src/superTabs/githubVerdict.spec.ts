import { describe, expect, it, vi } from 'vitest'
import { postVerdict, verdictAsked, type Verdict } from './githubVerdict.js'
import type { GitHubGet, GitHubSend } from './githubRest.js'
import { SuperTabHostError } from './wire.js'

type Json = Record<string, unknown>
const HEAD = 'f6edb44c0ffee0000000000000000000000000ab'
const NEXT = 'abcdef1c0ffee0000000000000000000000000cd'
const NOW = new Date(2026, 10, 11, 16, 21).getTime()

/** One pull request as GitHub's REST API answers for it, and what was sent to it. */
function setup() {
  const repo = { pull: { number: 27, state: 'open', head: { sha: HEAD, ref: 'pip/12' }, labels: [{ name: 'builder:pip' }] } as Json | null,
    comments: [] as Json[], status: 0, postStatus: 201, down: false, garbled: false }
  const sent: Array<{ method: string; path: string; body: unknown }> = []
  const asked: string[] = []
  const get: GitHubGet = async path => {
    asked.push(path)
    if (repo.down) throw new Error('gh is not signed in on this computer: run `gh auth login`.')
    if (repo.status) return { status: repo.status, etag: null, body: null, resetAt: null }
    const p = new URL(`https://api.github.com${path}`).pathname
    const page = Number(new URL(`https://api.github.com${path}`).searchParams.get('page') ?? 1)
    const body = p === '/repos/acme/app/pulls/27' ? repo.pull
      : p === '/repos/acme/app/issues/27/comments' ? (repo.garbled ? { message: 'not a list' } : repo.comments.slice((page - 1) * 100, page * 100)) : null
    return body === null ? { status: 404, etag: null, body: null, resetAt: null } : { status: 200, etag: null, body, resetAt: null }
  }
  const send: GitHubSend = async (method, path, body) => {
    sent.push({ method, path, body })
    if (repo.postStatus !== 201) return { status: repo.postStatus, etag: null, body: null, resetAt: null }
    const made = { id: 9001 + repo.comments.length, html_url: `https://github.com/acme/app/pull/27#issuecomment-${9001 + repo.comments.length}`, body: String((body as Json).body),
      user: { login: 'Reader-Login' } }
    repo.comments.push(made)
    return { status: 201, etag: null, body: made, resetAt: null }
  }
  const record = vi.fn(async (_repository: string, _commentId: string) => {})
  const juno = { name: 'Juno', repositories: new Set(['acme/app']) }
  const ok: Verdict = { repository: 'acme/app', number: 27, verdict: 'READ-OK', sha: 'f6edb44', text: 'Ran the tests on the head: 12 pass.' }
  const run = (asked: Verdict = ok, reader = juno) => postVerdict({ get, send, record, login: async () => 'reader-login', now: () => NOW }, reader, asked)
  return { repo, sent, asked, record, run, ok, juno }
}
const refusal = async (made: Promise<unknown>) => made.then(() => null, error => error instanceof SuperTabHostError ? { code: error.code, message: error.message } : { thrown: error })

describe('a read\'s verdict, made by command', () => {
  it('posts one comment in the form the merger reads, signed with the reader\'s name and the whole head, and records it as the reader\'s', async () => {
    const t = setup()
    expect(await t.run()).toEqual({ url: 'https://github.com/acme/app/pull/27#issuecomment-9001', head: HEAD, posted: true })
    expect(t.sent).toEqual([{ method: 'POST', path: '/repos/acme/app/issues/27/comments',
      body: { body: `Juno, 16:21: READ-OK ${HEAD}\n\nRan the tests on the head: 12 pass.` } }])
    expect(t.record).toHaveBeenCalledExactlyOnceWith('acme/app', '9001')
  })

  it('posts a HOLD with what to fix, and a READ-OK with no words as its first line alone', async () => {
    const t = setup()
    await t.run({ ...t.ok, verdict: 'HOLD', text: 'src/a.ts:12 reads the old head. Compare against the new one.' })
    await t.run({ ...t.ok, text: '  ' })
    expect(t.sent.map(s => (s.body as Json).body)).toEqual([
      `Juno, 16:21: HOLD ${HEAD}\n\nsrc/a.ts:12 reads the old head. Compare against the new one.`, `Juno, 16:21: READ-OK ${HEAD}`])
  })

  it('refuses a head that moved since the reader was asked, naming the new one, and posts nothing', async () => {
    const t = setup()
    t.repo.pull = { ...t.repo.pull!, head: { sha: NEXT, ref: 'pip/12' } }
    expect(await refusal(t.run())).toEqual({ code: 'HEAD_MOVED', message: 'acme/app#27 is now at abcdef1, not f6edb44. Read that head, then run the command with it.' })
    expect(t.sent).toEqual([])
    expect(t.record).not.toHaveBeenCalled()
  })

  it('refuses the pull request\'s own writer, by its label or its branch, however the name is written', async () => {
    const t = setup()
    for (const name of ['Pip', 'pip', ' PIP ']) {
      expect(await refusal(t.run(t.ok, { ...t.juno, name }))).toEqual({ code: 'OWN_PULL_REQUEST', message: 'acme/app#27 is your own pull request. Another agent reads it.' })
    }
    // A task taken over: one agent's branch under another's label. Neither reads it.
    t.repo.pull = { ...t.repo.pull!, labels: [{ name: 'builder:atlas' }] }
    expect((await refusal(t.run(t.ok, { ...t.juno, name: 'Atlas' })))?.code).toBe('OWN_PULL_REQUEST')
    expect((await refusal(t.run(t.ok, { ...t.juno, name: 'Pip' })))?.code).toBe('OWN_PULL_REQUEST')
    expect(t.sent).toEqual([])
  })

  it('refuses an agent with no name, which could sign nothing', async () => {
    const t = setup()
    expect(await refusal(t.run(t.ok, { ...t.juno, name: '  ' }))).toEqual({ code: 'AGENT_UNNAMED', message: 'This agent has no name to sign a verdict with.' })
    expect(t.asked).toEqual([])
  })

  it('refuses a repository that is no project of the reader\'s before it asks GitHub anything', async () => {
    const t = setup()
    expect(await refusal(t.run({ ...t.ok, repository: 'other/thing' }))).toEqual({ code: 'REPOSITORY_NOT_PROJECT',
      message: 'other/thing is not the repository of a project you are in.' })
    // As GitHub writes it, in any case.
    expect((await t.run({ ...t.ok, repository: 'Acme/App' })).posted).toBe(true)
    expect(t.asked.some(path => path.includes('other/thing'))).toBe(false)
  })

  it('refuses a pull request that is closed or not there, and says what GitHub answered when it refuses', async () => {
    const t = setup()
    t.repo.pull = { ...t.repo.pull!, state: 'closed' }
    expect(await refusal(t.run())).toEqual({ code: 'PULL_CLOSED', message: 'acme/app#27 is closed: there is nothing to read.' })
    t.repo.pull = null
    expect(await refusal(t.run())).toEqual({ code: 'PULL_NOT_FOUND', message: 'acme/app#27 is not a pull request this computer\'s GitHub login can read.' })
    t.repo.status = 403
    expect(await refusal(t.run())).toEqual({ code: 'GITHUB_REFUSED', message: 'GitHub answered 403 for acme/app#27. Nothing was posted.' })
    t.repo.status = 0
    t.repo.down = true
    expect(await refusal(t.run())).toEqual({ code: 'GITHUB_UNAVAILABLE', message: 'gh is not signed in on this computer: run `gh auth login`.' })
    expect(t.sent).toEqual([])
  })

  it('says so when GitHub refuses the comment, and records nothing', async () => {
    const t = setup()
    t.repo.postStatus = 422
    expect(await refusal(t.run())).toEqual({ code: 'GITHUB_REFUSED', message: 'GitHub answered 422 for acme/app#27. Nothing was posted.' })
    expect(t.record).not.toHaveBeenCalled()
  })

  it('does its work once when the command arrives twice: the same verdict on the same head is not posted again, and is recorded again', async () => {
    const t = setup()
    const first = await t.run()
    expect(await t.run()).toEqual({ ...first, posted: false })
    expect(t.sent).toHaveLength(1)
    expect(t.record.mock.calls).toEqual([['acme/app', '9001'], ['acme/app', '9001']])
    // Only what was said in the last hour is looked at, and only this reader's own line: other words are another comment.
    expect(t.asked.find(path => path.includes('/comments'))).toBe(`/repos/acme/app/issues/27/comments?since=${new Date(NOW - 60 * 60_000).toISOString()}&per_page=100&page=1`)
    expect((await t.run({ ...t.ok, text: 'One more thing: the README names the old flag.' })).posted).toBe(true)
    expect((await t.run(t.ok, { ...t.juno, name: 'Atlas' })).posted).toBe(true)
    expect(t.sent).toHaveLength(3)
  })

  // Review of #3902: the same HOLD run again after a READ-OK was taken for the first HOLD, so the merger read READ-OK.
  it('posts again when the reader has said something else since: only its newest verdict on the head is the same command twice', async () => {
    const t = setup()
    const hold: Verdict = { ...t.ok, verdict: 'HOLD', text: 'a.ts:1 fix it' }
    await t.run(hold)
    await t.run({ ...t.ok, text: '' })
    expect(await t.run(hold)).toMatchObject({ posted: true, url: 'https://github.com/acme/app/pull/27#issuecomment-9003' })
    expect(await t.run({ ...t.ok, text: '' })).toMatchObject({ posted: true })
    expect(await t.run({ ...t.ok, text: '' })).toMatchObject({ posted: false, url: 'https://github.com/acme/app/pull/27#issuecomment-9004' })
    expect(t.sent).toHaveLength(4)
  })

  it('never takes another login\'s comment for its own, though it reads the same', async () => {
    const t = setup()
    t.repo.comments.push({ id: 7, html_url: 'https://github.com/acme/app/pull/27#issuecomment-7', body: `Juno, 09:00: READ-OK ${HEAD}`, user: { login: 'outsider' } })
    expect(await t.run({ ...t.ok, text: '' })).toMatchObject({ posted: true, url: 'https://github.com/acme/app/pull/27#issuecomment-9002' })
    expect(t.record).toHaveBeenCalledExactlyOnceWith('acme/app', '9002')
  })

  it('finds its own comment past the first hundred of a busy hour, and posts nothing on a list it cannot read', async () => {
    const t = setup()
    for (let i = 0; i < 150; i++) t.repo.comments.push({ id: i + 1, html_url: `u${i}`, body: `note ${i}`, user: { login: 'someone' } })
    const first = await t.run()
    expect(await t.run()).toEqual({ ...first, posted: false })
    expect(t.asked.filter(path => path.includes('/comments')).at(-1)).toContain('&page=2')
    t.repo.garbled = true
    expect(await refusal(t.run())).toEqual({ code: 'GITHUB_REFUSED', message: 'GitHub answered 200 for acme/app#27. Nothing was posted.' })
    expect(t.sent).toHaveLength(1)
  })

  it('names the head as far as it was asked when the two differ only further on', async () => {
    const t = setup()
    expect((await refusal(t.run({ ...t.ok, sha: 'f6edb44c1' })))?.message).toBe('acme/app#27 is now at f6edb44c0, not f6edb44c1. Read that head, then run the command with it.')
  })

  it('says a record the server refused for good as the server said it, and does not ask for the command again', async () => {
    const t = setup()
    t.record.mockRejectedValueOnce(new SuperTabHostError('COMMENT_NOT_YOURS', 'Another agent wrote this comment.', 409))
    expect(await refusal(t.run())).toEqual({ code: 'NOT_RECORDED',
      message: 'Posted (https://github.com/acme/app/pull/27#issuecomment-9001), but it is not recorded as yours: Another agent wrote this comment. (COMMENT_NOT_YOURS)' })
    // The server busy, or out of reach, is worth the same command again.
    t.record.mockRejectedValueOnce(new SuperTabHostError('RATE_LIMITED', 'Too many records this hour.', 429))
    expect((await refusal(t.run()))?.message).toContain('Run the same command again: it will not post twice.')
  })

  it('says a posted verdict was not recorded, with its link, so that the same command run again records it without posting twice', async () => {
    const t = setup()
    t.record.mockRejectedValueOnce(new SuperTabHostError('BACKEND_UNAVAILABLE', 'Could not reach this Super Tab.'))
    expect(await refusal(t.run())).toEqual({ code: 'NOT_RECORDED',
      message: 'Posted (https://github.com/acme/app/pull/27#issuecomment-9001), but Harness could not record it as yours: Could not reach this Super Tab. Run the same command again: it will not post twice.' })
    expect(await t.run()).toMatchObject({ posted: false })
    expect(t.sent).toHaveLength(1)
    expect(t.record).toHaveBeenLastCalledWith('acme/app', '9001')
  })
})

describe('what the command asked for', () => {
  it('reads a verdict from the daemon\'s request, and nothing else', () => {
    const asked = { repository: 'acme/app', number: 27, verdict: 'HOLD', sha: 'f6edb44', text: 'a.ts:1 fix it' }
    expect(verdictAsked(asked)).toEqual(asked)
    expect(verdictAsked({ ...asked, verdict: 'READ-OK', text: '' })).toEqual({ ...asked, verdict: 'READ-OK', text: '' })
    for (const wrong of [{ repository: 'acme' }, { repository: '../x/y' }, { number: 0 }, { number: 1.5 }, { number: '27' }, { verdict: 'OK' }, { sha: 'f6edb4' }, { sha: 'F6EDB44' },
      { sha: 'f6edb44z' }, { text: 7 }, { text: 'x'.repeat(32_001) }, { verdict: 'HOLD', text: '   ' }]) {
      expect(verdictAsked({ ...asked, ...wrong })).toBeNull()
    }
  })
})
