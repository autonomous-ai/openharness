import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { GitHubReply, GitHubSend } from './githubRest.js'
import { gatedWrites, SAME_TEXT_MS, TEXTS_PER_HOUR, TEXTS_PER_MINUTE } from './githubWrites.js'

const dirs: string[] = []
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

const ASK = (at: string) => `Harness, ${at}, to **Uma**: please read this pull request, then run \`harness super-tab read ok acme/app#30 166f687 'what you found'\`.`

function setup(file?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'github-writes-'))
  dirs.push(dir)
  const clock = { now: Date.parse('2026-11-11T22:00:00Z') }
  const answer = { status: 201 }
  const sent: Array<{ method: string; path: string; body: unknown }> = []
  const send: GitHubSend = async (method, path, body) => { sent.push({ method, path, body }); return { status: answer.status, etag: null, body: { id: sent.length }, resetAt: null } }
  const get = vi.fn(async (): Promise<GitHubReply> => ({ status: 200, etag: null, body: {}, resetAt: null }))
  const log = vi.fn()
  const path = file ?? join(dir, 'writes.json')
  const make = () => gatedWrites({ get, send }, { file: path, now: () => clock.now, log })
  return { clock, answer, sent, get, log, make, path, gate: make() }
}

describe('Harness\'s writes to GitHub in its person\'s name (githubWrites.ts)', () => {
  // #4055: Uma was asked to read three times in an hour, a comment in its person's name each time (anh Dee, 2026-11-11: "never spam
  // github as user accounts could be banned").
  it('writes a line of Harness\'s once on an issue in a day, whatever its clock says, and says so once', async () => {
    const f = setup()
    expect((await f.gate.send('POST', '/repos/acme/app/issues/30/comments', { body: ASK('21:34') })).status).toBe(201)
    for (const at of ['22:05', '22:35']) {
      f.clock.now += 30 * 60_000
      expect(await f.gate.send('POST', '/repos/acme/app/issues/30/comments', { body: ASK(at) })).toEqual({ status: 201, etag: null, body: {}, resetAt: null })
    }
    expect(f.sent).toHaveLength(1)
    expect(f.log.mock.calls).toEqual([['[super-tab] GitHub writes: SAME_TEXT /repos/acme/app/issues/30/comments: Harness wrote it there in the last day']])
    // On another pull request it is another line; a day on, it is written again.
    await f.gate.send('POST', '/repos/acme/app/issues/31/comments', { body: ASK('22:35') })
    f.clock.now += SAME_TEXT_MS
    await f.gate.send('POST', '/repos/acme/app/issues/30/comments', { body: ASK('22:35') })
    expect(f.sent.map(write => write.path)).toEqual(['/repos/acme/app/issues/30/comments', '/repos/acme/app/issues/31/comments', '/repos/acme/app/issues/30/comments'])
  })

  it('writes an agent\'s own words made by command each time: its command says them once', async () => {
    const f = setup()
    for (let i = 0; i < 2; i++) await f.gate.send('POST', '/repos/acme/app/issues/14/comments', { body: 'Pip, 05:00: taken by Pip' })
    expect(f.sent).toHaveLength(2)
  })

  it('holds back texts past 75 a minute and 200 an hour, answered as a limit with when to try again; labels and merges pass', async () => {
    const f = setup()
    const start = f.clock.now
    for (let i = 0; i < TEXTS_PER_MINUTE; i++) await f.gate.send('POST', '/repos/acme/app/issues', { title: `Task ${i}`, body: 'Do it.' })
    expect(await f.gate.send('POST', '/repos/acme/app/issues/30/comments', { body: 'Pip, 05:00: cut #31' }))
      .toEqual({ status: 429, etag: null, body: { message: 'Harness holds back its writes to GitHub: too many in the last minute or hour.' }, resetAt: start + 60_000 })
    expect(f.log).toHaveBeenCalledWith('[super-tab] GitHub writes: LIMIT 75 a minute reached; the rest wait until 22:01 UTC')
    // What writes no text passes, limit or none: the work needs it.
    expect((await f.gate.send('POST', '/repos/acme/app/issues/30/labels', { labels: ['status:taken'] })).status).toBe(201)
    expect((await f.gate.send('PUT', '/repos/acme/app/pulls/30/merge', { merge_method: 'squash' })).status).toBe(201)
    expect((await f.gate.send('PATCH', '/repos/acme/app/pulls/30', { state: 'closed' })).status).toBe(201)
    // A minute on, more go; the hour's limit holds the rest until the first of the hour is an hour old.
    for (let i = 0; f.sent.length < TEXTS_PER_HOUR + 3; i++) {
      f.clock.now += 60_000
      for (let j = 0; j < 20; j++) await f.gate.send('POST', `/repos/acme/app/issues/${i}/comments`, { body: `Pip, 05:00: note ${j}` })
    }
    expect(f.sent.filter(write => write.method === 'POST' && !write.path.endsWith('/labels'))).toHaveLength(TEXTS_PER_HOUR)
    expect((await f.gate.send('POST', '/repos/acme/app/issues/30/comments', { body: 'one more' })).resetAt).toBe(start + 60 * 60_000)
    expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/^\[super-tab\] GitHub writes: LIMIT 200 an hour reached; the rest wait until 23:00 UTC$/))
  })

  it('counts and keeps only what GitHub took', async () => {
    const f = setup()
    f.answer.status = 502
    await f.gate.send('POST', '/repos/acme/app/issues/30/comments', { body: ASK('21:34') })
    f.answer.status = 201
    await f.gate.send('POST', '/repos/acme/app/issues/30/comments', { body: ASK('21:35') })
    expect(f.sent).toHaveLength(2)
  })

  it('knows what it wrote over a restart, and starts afresh from a file it cannot read', async () => {
    const f = setup()
    await f.gate.send('POST', '/repos/acme/app/issues/30/comments', { body: ASK('21:34') })
    await f.make().send('POST', '/repos/acme/app/issues/30/comments', { body: ASK('21:40') })
    expect(f.sent).toHaveLength(1)
    writeFileSync(f.path, JSON.stringify({ lines: 'nothing', texts: 7 }))
    await f.make().send('POST', '/repos/acme/app/issues/30/comments', { body: ASK('21:45') })
    writeFileSync(f.path, '{')
    await f.make().send('POST', '/repos/acme/app/issues/30/comments', { body: ASK('21:50') })
    expect(f.sent).toHaveLength(3)
  })

  it('keeps what it wrote in memory when it cannot save it, and says so once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'github-writes-locked-'))
    dirs.push(dir)
    chmodSync(dir, 0o500)
    try {
      const f = setup(join(dir, 'writes.json'))
      await f.gate.send('POST', '/repos/acme/app/issues/30/comments', { body: ASK('21:34') })
      await f.gate.send('POST', '/repos/acme/app/issues/31/comments', { body: ASK('21:34') })
      await f.gate.send('POST', '/repos/acme/app/issues/30/comments', { body: ASK('21:40') })
      expect(f.sent).toHaveLength(2)
      expect(f.log.mock.calls.filter(([line]) => String(line).includes('NOT_SAVED'))).toEqual([['[super-tab] GitHub writes: NOT_SAVED EACCES']])
    } finally {
      chmodSync(dir, 0o700)
    }
  })

  it('reads its clock and writes its log as the daemon does when given none', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = mkdtempSync(join(tmpdir(), 'github-writes-'))
    dirs.push(dir)
    const send: GitHubSend = async () => ({ status: 201, etag: null, body: {}, resetAt: null })
    const gate = gatedWrites({ get: async () => ({ status: 200, etag: null, body: {}, resetAt: null }), send }, { file: join(dir, 'writes.json') })
    await gate.send('POST', '/repos/acme/app/issues/30/comments', { body: ASK('21:34') })
    await gate.send('POST', '/repos/acme/app/issues/30/comments', { body: ASK('21:35') })
    expect(warn).toHaveBeenCalledWith('[super-tab] GitHub writes: SAME_TEXT /repos/acme/app/issues/30/comments: Harness wrote it there in the last day')
    warn.mockRestore()
  })
})
