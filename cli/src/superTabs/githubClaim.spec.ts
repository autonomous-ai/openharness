import { describe, expect, it, vi } from 'vitest'
import { CLAIM_LIMIT, claimAsked, takeTask } from './githubClaim.js'
import type { GitHubGet, GitHubSend } from './githubRest.js'
import { SuperTabHostError } from './wire.js'

type Json = Record<string, unknown>
const NOW = new Date(2026, 10, 11, 14, 5).getTime()

/** One repository's issues as GitHub's REST API answers for them, and what was sent to it. */
function setup() {
  const repo = { issues: new Map<number, Json>([[34, { number: 34, state: 'open', labels: [{ name: 'builder:pip' }, { name: 'size:s' }], html_url: 'https://github.com/acme/app/issues/34' }]]),
    comments: new Map<number, Json[]>(), status: 0, down: false, next: 9001 }
  const sent: Array<{ method: string; path: string; body: unknown }> = []
  const names = (issue: Json) => (issue.labels as Json[]).map(label => String(label.name))
  const get: GitHubGet = async path => {
    if (repo.down) throw new Error('gh is not signed in on this computer: run `gh auth login`.')
    if (repo.status) return { status: repo.status, etag: null, body: null, resetAt: null }
    const url = new URL(`https://api.github.com${path}`), p = url.pathname
    const one = /^\/repos\/acme\/app\/issues\/(\d+)$/.exec(p), said = /^\/repos\/acme\/app\/issues\/(\d+)\/comments$/.exec(p)
    const body = one ? repo.issues.get(Number(one[1])) ?? null
      : said ? repo.comments.get(Number(said[1])) ?? []
      : p === '/repos/acme/app/issues' ? [...repo.issues.values()].filter(issue => issue.state === 'open'
        && (url.searchParams.get('labels') ?? '').split(',').every(label => names(issue).includes(label)))
      : null
    return body === null ? { status: 404, etag: null, body: null, resetAt: null } : { status: 200, etag: null, body, resetAt: null }
  }
  const send: GitHubSend = async (method, path, body) => {
    sent.push({ method, path, body })
    const labels = /^\/repos\/acme\/app\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(path), said = /^\/repos\/acme\/app\/issues\/(\d+)\/comments$/.exec(path)
    if (labels && method === 'POST') {
      const issue = repo.issues.get(Number(labels[1]))!
      for (const name of (body as { labels: string[] }).labels) if (!names(issue).includes(name)) (issue.labels as Json[]).push({ name })
      return { status: 200, etag: null, body: issue.labels, resetAt: null }
    }
    if (labels && method === 'DELETE') {
      const issue = repo.issues.get(Number(labels[1]))!
      issue.labels = (issue.labels as Json[]).filter(label => label.name !== decodeURIComponent(labels[2]!))
      return { status: 200, etag: null, body: issue.labels, resetAt: null }
    }
    if (said && method === 'POST') {
      const made = { id: repo.next++, html_url: `https://github.com/acme/app/issues/${said[1]}#issuecomment-${repo.next - 1}`, body: String((body as Json).body),
        created_at: new Date(NOW).toISOString(), user: { login: 'pips-person' } }
      repo.comments.set(Number(said[1]), [...repo.comments.get(Number(said[1])) ?? [], made])
      return { status: 201, etag: null, body: made, resetAt: null }
    }
    return { status: 404, etag: null, body: null, resetAt: null }
  }
  const record = vi.fn(async (_repository: string, _commentId: string) => {})
  const pip = { name: 'Pip', repositories: new Set(['acme/app']) }
  const take = (number = 34, agent = pip, repository = 'acme/app') => takeTask({ get, send, record, now: () => NOW }, agent, { repository, number })
  const labelsOf = (number: number) => names(repo.issues.get(number)!)
  return { repo, sent, record, take, pip, labelsOf }
}
const refusal = async (made: Promise<unknown>) => made.then(() => null, error => error instanceof SuperTabHostError ? { code: error.code, message: error.message } : { thrown: error })

describe('a task\'s claim, made by command', () => {
  it('marks the issue taken, says so in one comment under the agent\'s name, and records the comment as the agent\'s', async () => {
    const t = setup()
    expect(await t.take()).toEqual({ url: 'https://github.com/acme/app/issues/34#issuecomment-9001', taken: true })
    expect(t.labelsOf(34)).toEqual(['builder:pip', 'size:s', 'status:taken'])
    expect(t.sent.map(s => `${s.method} ${s.path}`)).toEqual(['POST /repos/acme/app/issues/34/labels', 'POST /repos/acme/app/issues/34/comments'])
    expect(t.sent[1]!.body).toEqual({ body: 'Pip, 14:05: taken by Pip' })
    expect(t.record).toHaveBeenCalledExactlyOnceWith('acme/app', '9001')
  })

  it('takes a task nobody holds by putting its own label on it, and does its work once when the command arrives twice', async () => {
    const t = setup()
    t.repo.issues.set(35, { number: 35, state: 'open', labels: [{ name: 'size:m' }], html_url: 'https://github.com/acme/app/issues/35' })
    expect((await t.take(35)).taken).toBe(true)
    expect(t.labelsOf(35)).toEqual(['size:m', 'status:taken', 'builder:pip'])
    const sent = t.sent.length
    expect(await t.take(35)).toEqual({ url: 'https://github.com/acme/app/issues/35', taken: false })
    expect(t.sent).toHaveLength(sent)
  })

  it('refuses another builder\'s task, one a person took, a closed one, a pull request, and one that is not there, and changes nothing', async () => {
    const t = setup()
    t.repo.issues.set(36, { number: 36, state: 'open', labels: [{ name: 'builder:atlas' }] })
    t.repo.issues.set(37, { number: 37, state: 'open', labels: [{ name: 'status:taken' }] })
    t.repo.issues.set(38, { number: 38, state: 'closed', labels: [{ name: 'builder:pip' }] })
    t.repo.issues.set(39, { number: 39, state: 'open', labels: [], pull_request: {} })
    expect(await refusal(t.take(36))).toEqual({ code: 'TASK_NOT_YOURS', message: 'acme/app#36 is given to atlas. Take a task that is yours, or one nobody holds.' })
    expect(await refusal(t.take(37))).toEqual({ code: 'TASK_TAKEN', message: 'acme/app#37 is taken already, by someone who is no builder here.' })
    expect(await refusal(t.take(38))).toEqual({ code: 'TASK_CLOSED', message: 'acme/app#38 is closed.' })
    expect(await refusal(t.take(39))).toEqual({ code: 'NOT_A_TASK', message: 'acme/app#39 is a pull request. A task is an issue.' })
    expect(await refusal(t.take(40))).toEqual({ code: 'TASK_NOT_FOUND', message: 'acme/app#40 is not an issue this computer\'s GitHub login can read.' })
    expect(await refusal(t.take(34, t.pip, 'other/thing'))).toEqual({ code: 'REPOSITORY_NOT_PROJECT', message: 'other/thing is not the repository of a project you are in.' })
    expect(await refusal(t.take(34, { ...t.pip, name: ' ' }))).toMatchObject({ code: 'AGENT_UNNAMED' })
    expect(t.sent).toEqual([])
  })

  // lampOS: at most four issues taken per builder, so work does not sit on a busy one (joining.md "Moving labelled work").
  it(`refuses a claim past ${CLAIM_LIMIT} tasks held, naming them`, async () => {
    const t = setup()
    for (const number of [1, 2, 3, 4]) t.repo.issues.set(number, { number, state: 'open', labels: [{ name: 'builder:pip' }, { name: 'status:taken' }] })
    expect(await refusal(t.take())).toEqual({ code: 'CLAIM_LIMIT', message: 'You hold 4 tasks already (#1, #2, #3, #4), and 4 is the most. Finish or release one first.' })
    expect(t.sent).toEqual([])
  })

  it('gives way when another builder took the task at the same moment: its own label comes off, and it says who has it', async () => {
    const t = setup()
    t.repo.issues.set(35, { number: 35, state: 'open', labels: [], html_url: 'https://github.com/acme/app/issues/35' })
    // Atlas's claim lands between Pip's look and Pip's label.
    const send = t.sent
    const first = vi.spyOn(send, 'push').mockImplementationOnce(function (this: unknown[], entry) {
      const issue = t.repo.issues.get(35)!
      ;(issue.labels as Json[]).push({ name: 'builder:atlas' }, { name: 'status:taken' })
      t.repo.comments.set(35, [{ id: 1, body: 'Atlas, 14:05: taken by Atlas', created_at: new Date(NOW - 1000).toISOString(), user: { login: 'atlas-person' } }])
      return Array.prototype.push.call(this, entry)
    })
    expect(await refusal(t.take(35))).toEqual({ code: 'TASK_TAKEN', message: 'acme/app#35 was taken by atlas at the same moment. It is theirs: take another.' })
    first.mockRestore()
    expect(t.labelsOf(35)).toEqual(['builder:atlas', 'status:taken'])
    expect(t.record).not.toHaveBeenCalled()
  })

  it('says what GitHub answered when it refuses, and gh\'s own words when it cannot be reached', async () => {
    const t = setup()
    t.repo.status = 403
    expect(await refusal(t.take())).toEqual({ code: 'GITHUB_REFUSED', message: 'GitHub answered 403 for acme/app#34. Nothing was changed.' })
    t.repo.status = 0
    t.repo.down = true
    expect(await refusal(t.take())).toEqual({ code: 'GITHUB_UNAVAILABLE', message: 'gh is not signed in on this computer: run `gh auth login`.' })
  })
})

describe('what the command asked for', () => {
  it('reads a claim from the daemon\'s request, and nothing else', () => {
    expect(claimAsked({ repository: 'acme/app', number: 34 })).toEqual({ repository: 'acme/app', number: 34 })
    for (const wrong of [{ repository: 'acme' }, { repository: 'acme/../x' }, { number: 0 }, { number: '34' }, { number: 1.5 }]) {
      expect(claimAsked({ repository: 'acme/app', number: 34, ...wrong })).toBeNull()
    }
  })
})
