import { describe, expect, it, vi } from 'vitest'
import type { GitHubReply, GitHubSend } from './githubRest.js'
import { gatedWrites, SAME_TEXT_TIMES, TEXTS_PER_HOUR, TEXTS_PER_MINUTE } from './githubWrites.js'

const ASK = (at: string) => `Harness, ${at}, to **Uma**: please read this pull request, then run \`harness super-tab read ok acme/app#30 166f687 'what you found'\`.`
const HELD = 'Harness holds back this write to GitHub: it said this here twice today, or wrote too much in the last minute or hour.'
const DAY_MS = 24 * 60 * 60_000

function setup() {
  const clock = { now: Date.parse('2026-11-11T22:00:00Z') }
  const answer: { status: number; slow: Promise<void> | null } = { status: 201, slow: null }
  const sent: Array<{ method: string; path: string; body: unknown }> = []
  const send: GitHubSend = async (method, path, body) => {
    sent.push({ method, path, body })
    await answer.slow
    return { status: answer.status, etag: null, body: { id: sent.length }, resetAt: null }
  }
  const get = vi.fn(async (): Promise<GitHubReply> => ({ status: 200, etag: null, body: {}, resetAt: null }))
  const log = vi.fn()
  return { clock, answer, sent, get, log, gate: gatedWrites({ get, send }, { now: () => clock.now, log }) }
}

describe('Harness\'s writes to GitHub in its person\'s name (githubWrites.ts)', () => {
  // #4055: Uma was asked to read three times in an hour, a comment in its person's name each time (anh Dee, 2026-11-11: "never spam
  // github as user accounts could be banned"). A task given back to the same builder twice in a day is said twice, as it happened.
  it('writes the same line of Harness\'s on an issue twice in a day at most, whatever its clock says, and says the hold once', async () => {
    const f = setup()
    const start = f.clock.now
    for (const at of ['21:34', '22:05', '22:35', '23:05']) {
      const reply = await f.gate.send('POST', '/repos/acme/app/issues/30/comments', { body: ASK(at) })
      f.clock.now += 30 * 60_000
      if (f.sent.length > SAME_TEXT_TIMES) throw new Error(`written ${f.sent.length} times`)
      if (at >= '22:35') expect(reply).toEqual({ status: 429, etag: null, body: { message: HELD }, resetAt: start + DAY_MS })
    }
    expect(f.sent).toHaveLength(SAME_TEXT_TIMES)
    expect(f.log.mock.calls).toEqual([[expect.stringMatching(/^\[super-tab\] GitHub writes: SAME_TEXT \/repos\/acme\/app\/issues\/30\/comments \w+: Harness wrote it there 2 times in the last day$/)]])
    // On another pull request it is another line; a day after the first, it goes again.
    expect((await f.gate.send('POST', '/repos/acme/app/issues/31/comments', { body: ASK('23:30') })).status).toBe(201)
    f.clock.now = start + DAY_MS
    expect((await f.gate.send('POST', '/repos/acme/app/issues/30/comments', { body: ASK('22:00') })).status).toBe(201)
    expect(f.sent).toHaveLength(4)
  })

  it('leaves out only the clock that signs a line: another time inside it is another line', async () => {
    const f = setup()
    for (const until of ['14:00', '15:00', '16:00']) {
      await f.gate.send('POST', '/repos/acme/app/issues/30/comments', { body: `Harness, 05:00, to **Pip**: the train waits until ${until}.` })
    }
    expect(f.sent).toHaveLength(3)
  })

  it('writes an agent\'s own words made by command each time: its command says them once', async () => {
    const f = setup()
    for (let i = 0; i < 3; i++) await f.gate.send('POST', '/repos/acme/app/issues/14/comments', { body: 'Pip, 05:00: taken by Pip' })
    expect(f.sent).toHaveLength(3)
  })

  it('holds back texts past 75 a minute and 200 an hour, with when to try again; labels, merges and edits pass', async () => {
    const f = setup()
    const start = f.clock.now
    for (let i = 0; i < TEXTS_PER_MINUTE; i++) await f.gate.send('POST', '/repos/acme/app/issues', { title: `Task ${i}`, body: 'Do it.' })
    expect(await f.gate.send('POST', '/repos/acme/app/issues/30/comments', { body: 'Pip, 05:00: cut #31' }))
      .toEqual({ status: 429, etag: null, body: { message: HELD }, resetAt: start + 60_000 })
    expect(f.log).toHaveBeenCalledWith('[super-tab] GitHub writes: LIMIT 75 a minute reached; the rest wait until 22:01 UTC')
    expect((await f.gate.send('POST', '/repos/acme/app/issues/30/labels', { labels: ['status:taken'] })).status).toBe(201)
    expect((await f.gate.send('PUT', '/repos/acme/app/pulls/30/merge', { merge_method: 'squash' })).status).toBe(201)
    expect((await f.gate.send('PATCH', '/repos/acme/app/pulls/30', { state: 'closed' })).status).toBe(201)
    // A minute on, more go; the hour's limit holds the rest until the first of the hour is an hour old.
    for (let i = 0; f.sent.length < TEXTS_PER_HOUR + 3; i++) {
      f.clock.now += 60_000
      for (let j = 0; j < 40; j++) await f.gate.send('POST', `/repos/acme/app/issues/${i}/comments`, { body: `Pip, 05:00: note ${j}` })
    }
    expect(f.sent.filter(write => write.method === 'POST' && !write.path.endsWith('/labels'))).toHaveLength(TEXTS_PER_HOUR)
    expect((await f.gate.send('POST', '/repos/acme/app/issues/30/comments', { body: 'one more' })).resetAt).toBe(start + 60 * 60_000)
    expect(f.log).toHaveBeenCalledWith('[super-tab] GitHub writes: LIMIT 200 an hour reached; the rest wait until 23:00 UTC')
  })

  it('counts writes running at once before they go, and gives back what GitHub did not take', async () => {
    const f = setup()
    let release!: () => void
    f.answer.slow = new Promise(resolve => { release = resolve })
    const all = Array.from({ length: TEXTS_PER_MINUTE + 1 }, (_, i) => f.gate.send('POST', `/repos/acme/app/issues/${i}/comments`, { body: `Pip, 05:00: note ${i}` }))
    release()
    expect((await Promise.all(all)).map(reply => reply.status).filter(status => status === 429)).toHaveLength(1)
    // A minute on: one GitHub refused, and one that failed outright, are not counted, and the line goes again.
    f.clock.now += 60_000
    f.answer.slow = null
    f.answer.status = 502
    await f.gate.send('POST', '/repos/acme/app/issues/30/comments', { body: ASK('21:34') })
    f.answer.status = 201
    const failing = gatedWrites({ get: f.get, send: async () => { throw new Error('GitHub did not answer.') } }, { now: () => f.clock.now, log: f.log })
    await expect(failing.send('POST', '/repos/acme/app/issues/30/comments', { body: ASK('21:34') })).rejects.toThrow('GitHub did not answer.')
    await expect(failing.send('POST', '/repos/acme/app/issues/30/comments', { body: ASK('21:34') })).rejects.toThrow('GitHub did not answer.')
    await expect(failing.send('POST', '/repos/acme/app/issues/30/comments', { body: ASK('21:34') })).rejects.toThrow('GitHub did not answer.')
    for (const at of ['21:35', '21:36']) expect((await f.gate.send('POST', '/repos/acme/app/issues/30/comments', { body: ASK(at) })).status).toBe(201)
  })

  it('reads its clock and writes its log as the daemon does when given none', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const gate = gatedWrites({ get: async () => ({ status: 200, etag: null, body: {}, resetAt: null }), send: async () => ({ status: 201, etag: null, body: {}, resetAt: null }) })
    for (const at of ['21:34', '21:35', '21:36']) await gate.send('POST', '/repos/acme/app/issues/30/comments', { body: ASK(at) })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/GitHub writes: SAME_TEXT \/repos\/acme\/app\/issues\/30\/comments/))
    warn.mockRestore()
  })
})
