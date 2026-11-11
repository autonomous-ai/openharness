import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Crew } from './assign/crew.js'
import { claimant, GitHubNumbers, NUMBERS_CHECK_MS, NUMBERS_HOUR, numbersText, stepsOf } from './githubNumbers.js'
import type { GitHubGet } from './githubRest.js'

type Json = Record<string, unknown>
const PROJECT = { repo: 'acme/app', pm: 'Faye', tabId: 'tab', pmAgentId: 'faye', projectId: 'app', channel: 'lead' }
const MIN = 60_000
/** A time on 10 November 2026 on this computer's clock, the day the numbers are of. */
const nov10 = (hour: number, minute = 0) => new Date(2026, 10, 10, hour, minute).getTime()
const iso = (at: number) => new Date(at).toISOString()
const crew = (names: string[], away: string[] = []): Crew => ({ builders: names.map(name => ({ id: name, name, label: `builder:${name.toLowerCase()}`, machineId: 'm', engine: 'claude' })),
  machines: [], away: away.map(name => ({ name, label: `builder:${name.toLowerCase()}`, why: 'down' as const })) })
const pull = (number: number, builder: string, opened: number, merged: number | null, extra: Json = {}): Json => ({ number, created_at: iso(opened),
  closed_at: iso(merged ?? opened + 30 * MIN), merged_at: merged === null ? null : iso(merged), head: { ref: `${builder.toLowerCase()}/${number}` },
  labels: [{ name: `builder:${builder}` }], user: { login: 'dee' }, ...extra })
const said = (at: number, body: string): Json => ({ created_at: iso(at), body, user: { login: 'dee' }, author_association: 'OWNER' })

describe('a landed pull request\'s steps, as the Swarm study measured lampOS\'s', () => {
  it('times ready to its first verdict, its last READ-OK to landed, ready to landed, and whether it landed within 3 h', () => {
    const opened = nov10(9), merged = nov10(10, 30)
    const steps = stepsOf(pull(7, 'Pip', opened, merged, { body: 'The menu.\n\nCloses #3' }), [
      said(nov10(9, 5), 'Harness, 09:05, to **Kai**: READ-OK please, at 1234567'),
      said(nov10(9, 20), 'Kai, 09:20: HOLD 1234567 the test is missing'),
      said(nov10(9, 50), 'Kai, 09:50: READ-OK 89abcde'),
      said(nov10(10, 40), 'Kai, 10:40: READ-OK fedcba9'),
    ], [], ['Pip', 'Kai'])
    expect(steps).toEqual({ builder: 'Pip', task: 3, mergedAt: merged, readyToLanded: 90, within3h: true, firstVerdict: 20, okToLanded: 40 })
  })

  it('is ready when it was last marked ready, a verdict talked about is none, and a builder is matched however its label is spelled', () => {
    const opened = nov10(8), ready = nov10(11), merged = nov10(15)
    const steps = stepsOf(pull(8, 'kai', opened, merged, { labels: [{ name: 'Builder:kai' }] }), [
      said(nov10(10), 'Pip, 10:00: READ-OK 1234567, before it was ready'),
      said(nov10(11, 30), '> Pip, 11:30: READ-OK 1234567'),
      said(nov10(12), 'Pip, 12:00: READ-OK 89abcde'),
    ], [{ event: 'ready_for_review', created_at: iso(nov10(9)) }, { event: 'ready_for_review', created_at: iso(ready) }, { event: 'labeled', created_at: iso(nov10(14)) }],
    ['Pip', 'Kai'])
    expect(steps).toMatchObject({ builder: 'Kai', firstVerdict: 60, okToLanded: 180, readyToLanded: 240, within3h: false })
  })

  it('has no verdict steps when nobody read it, no task when it closes none, and is no builder\'s when the team does not name it', () => {
    // Words with no verdict, and a comment or review with none at all, are no verdict.
    const talk = [said(nov10(9, 5), '\n\nlooks fine'), { created_at: iso(nov10(9, 6)), user: { login: 'dee' } }]
    expect(stepsOf(pull(9, 'Pip', nov10(9), nov10(9, 30), { body: 'See #4.' }), talk, [], ['Pip']))
      .toMatchObject({ builder: 'Pip', task: null, firstVerdict: null, okToLanded: null })
    // A branch of a person's own, or of Harness's: not a builder of the team.
    expect(stepsOf(pull(9, 'harness', nov10(9), nov10(9, 30)), [], [], ['Pip']).builder).toBeNull()
  })

  it('reads a take by its comment, the builder named twice, and nothing else', () => {
    expect(claimant({ body: 'Pip, 14:05: taken by Pip' })).toBe('Pip')
    expect(claimant({ body: 'Kai Lee, 14:05: taken by Kai Lee\nmore' })).toBe('Kai Lee')
    for (const body of ['Pip, 14:05: taken by Kai', 'taken by Pip', 'Pip, 14:05: READ-OK 1234567', '']) expect(claimant({ body })).toBeNull()
    expect(claimant({})).toBeNull()
  })
})

describe('the day\'s numbers as the channel reads them', () => {
  const day = new Date(2026, 10, 10)
  const landed = (builder: string | null, task: number | null, firstVerdict: number | null, okToLanded: number | null, readyToLanded: number,
    within3h: boolean, mergedAt: number) => ({ builder, task, firstVerdict, okToLanded, readyToLanded, within3h, mergedAt })
  const take = (name: string, issue: number, at: number) => ({ name, issue, at })

  it('gives the team\'s line first, then every builder\'s, one with nothing landed too, and what no builder of the team wrote', () => {
    const text = numbersText(day, ['Pip', 'Kai', 'Lee', 'Juno'], [
      landed('Pip', 1, 4, 20, 50, true, nov10(10)), landed('Pip', 2, 8, 30, 70, true, nov10(14)), landed('Kai', 3, 30, 25, 200, false, nov10(16)),
      landed('Lee', null, 10, 5, 40, true, nov10(17)), landed(null, null, null, null, 15, true, nov10(18)),
    ], 1, [
      // Pip took its next task 3 and 7 minutes after each landed; Kai had taken its next before its #3 landed; Lee took none since.
      take('Pip', 1, nov10(9)), take('Pip', 2, nov10(10, 3)), take('Pip', 4, nov10(14, 7)),
      take('kai', 3, nov10(11)), take('Kai', 5, nov10(15)), take('Lee', 6, nov10(12)),
    ], false)
    expect(text.split('\n')).toEqual([
      'Numbers for Tue 10 Nov, from GitHub:',
      'Team · 5 landed · ready → first verdict 9 min (p90 30 min) · last READ-OK → landed 23 min · ready → landed 50 min · 80% landed within 3 h of opening'
        + ' · free → next task 3 min · 1 closed without landing',
      'Pip: 2 landed · ready → first verdict 6 min · last READ-OK → landed 25 min · free → next task 5 min',
      'Kai: 1 landed · ready → first verdict 30 min · last READ-OK → landed 25 min · free → next task 0 min',
      'Lee: 1 landed · ready → first verdict 10 min · last READ-OK → landed 5 min · no task taken since its last landed',
      'Juno: nothing landed',
      'Others, no builder of the team: 1 landed',
    ])
  })

  it('says when the day was cut, and has no steps it cannot tell', () => {
    expect(numbersText(day, [], [landed(null, null, null, null, 90, true, nov10(9))], 0, [], true).split('\n')).toEqual([
      'Numbers for Tue 10 Nov, from GitHub (the first 200 landed):',
      'Team · 1 landed · ready → landed 1.5 h · 100% landed within 3 h of opening',
      'Others, no builder of the team: 1 landed',
    ])
    expect(numbersText(day, ['Pip'], [], 0, [], false).split('\n')).toEqual(['Numbers for Tue 10 Nov, from GitHub:', 'Team · 0 landed', 'Pip: nothing landed'])
  })
})

describe('posted once a day in the project\'s channel, as its PM', () => {
  const folders: string[] = []
  afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })

  /** acme/app on GitHub on 11 November: on the 10th Pip's #7 landed after Kai's READ-OK and Pip took its next task; Kai's #5 landed,
   *  listed first as GitHub lists the last changed first, and Kai took none since; Kai's #8 was closed. */
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'super-tab-numbers-')); folders.push(dir)
    let clock = nov10(23)
    const reads: string[] = []
    const fail = { get: null as Error | null, post: null as Error | null }
    const get = vi.fn<GitHubGet>(async path => {
      reads.push(path)
      if (fail.get) throw fail.get
      const url = new URL(`https://api.github.com${path}`)
      const body = url.pathname === '/repos/acme/app/pulls' ? [pull(5, 'Kai', nov10(10, 30), nov10(11, 30)), pull(7, 'Pip', nov10(9), nov10(10)),
        pull(8, 'Kai', nov10(11), null),
        pull(6, 'Pip', nov10(9) - 24 * 60 * MIN, nov10(9) - 23 * 60 * MIN)]
        : url.pathname === '/repos/acme/app/issues/7/comments' ? [said(nov10(9, 6), 'Kai, 09:06: READ-OK 1234567')]
        // Pip's take of its next task; a take with no issue to it is none.
        : url.pathname === '/repos/acme/app/issues/comments' ? [said(nov10(10, 1), 'Pip, 10:01: taken by Pip'), said(nov10(10, 2), 'Kai, 10:02: on it'),
          { ...said(nov10(10, 4), 'Pip, 10:04: taken by Pip'), issue_url: 'https://api.github.com/repos/acme/app/issues/9' }]
        : []
      return { status: 200, etag: null, body, resetAt: null }
    })
    const post = vi.fn(async (_project: unknown, _operation: string, _text: string) => { if (fail.post) throw fail.post })
    const log = vi.fn()
    // Kai's machine is down: still on the team, and still in its numbers.
    const open = (file = join(dir, 'numbers.json')) => new GitHubNumbers({ projects: async () => [PROJECT], crew: async () => crew(['Pip'], ['Kai']), get, post, log,
      now: () => clock, file })
    return { open, post, get, log, reads, fail, dir, at: (time: number) => { clock = time } }
  }

  it('posts the day before\'s numbers from the morning, once, and again the next day', async () => {
    const t = setup(), numbers = t.open()
    // From midnight to the morning: nothing read, nothing posted.
    for (const at of [nov10(24), nov10(24 + NUMBERS_HOUR) - MIN]) { t.at(at); await numbers.tick() }
    expect(t.get).not.toHaveBeenCalled()
    expect(t.post).not.toHaveBeenCalled()
    t.at(nov10(24 + NUMBERS_HOUR, 5)); await numbers.tick()
    expect(t.post).toHaveBeenCalledOnce()
    const [project, operation, text] = t.post.mock.calls[0]!
    expect(project).toBe(PROJECT)
    expect(operation).toBe('numbers-acme-app-2026-11-11')
    expect(text.split('\n')).toEqual([
      'Numbers for Tue 10 Nov, from GitHub:',
      'Team · 2 landed · ready → first verdict 6 min (p90 6 min) · last READ-OK → landed 54 min · ready → landed 1 h · 100% landed within 3 h of opening'
        + ' · free → next task 4 min · 1 closed without landing',
      'Pip: 1 landed · ready → first verdict 6 min · last READ-OK → landed 54 min · free → next task 4 min',
      'Kai: 1 landed · no task taken since its last landed',
    ])
    // Every ten minutes of the day after: nothing more, and nothing read.
    const read = t.get.mock.calls.length
    for (let at = nov10(24 + NUMBERS_HOUR, 15); at < nov10(48); at += 10 * MIN) { t.at(at); await numbers.tick() }
    expect(t.post).toHaveBeenCalledOnce()
    expect(t.get).toHaveBeenCalledTimes(read)
    t.at(nov10(48 + NUMBERS_HOUR)); await numbers.tick()
    expect(t.post).toHaveBeenCalledTimes(2)
    expect(t.post.mock.calls[1]![1]).toBe('numbers-acme-app-2026-11-12')
  })

  it('posts once across a restart, from the day it kept, and reads a kept file it cannot use as none', async () => {
    const t = setup()
    t.at(nov10(24 + NUMBERS_HOUR)); await t.open().tick()
    await t.open().tick()
    expect(t.post).toHaveBeenCalledOnce()
    writeFileSync(join(t.dir, 'numbers.json'), 'not json')
    await t.open().tick()
    expect(t.post).toHaveBeenCalledTimes(2)
    // Posted again under the same operation, which the server answers with the first post.
    expect(t.post.mock.calls[1]![1]).toBe(t.post.mock.calls[0]![1])
  })

  it('tries again at the next look when GitHub or the post fails, and says each failure once a day', async () => {
    const t = setup(), numbers = t.open()
    t.fail.get = Object.assign(new Error('GitHub did not answer.'), { code: 'UNREACHABLE' })
    for (const minute of [0, 10, 20]) { t.at(nov10(24 + NUMBERS_HOUR, minute)); await numbers.tick() }
    expect(t.post).not.toHaveBeenCalled()
    expect(t.log.mock.calls.filter(([line]) => String(line).startsWith('[super-tab] Daily numbers:'))).toHaveLength(1)
    t.fail.get = null
    t.fail.post = new Error('BACKEND_UNREACHABLE')
    t.at(nov10(24 + NUMBERS_HOUR, 30)); await numbers.tick()
    t.at(nov10(24 + NUMBERS_HOUR, 40)); await numbers.tick()
    expect(t.post).toHaveBeenCalledTimes(2)
    t.fail.post = null
    t.at(nov10(24 + NUMBERS_HOUR, 50)); await numbers.tick()
    t.at(nov10(24 + NUMBERS_HOUR, 60)); await numbers.tick()
    expect(t.post).toHaveBeenCalledTimes(3)
    expect(t.log).toHaveBeenCalledWith('[super-tab] posted acme/app\'s numbers for the day before 2026-11-11')
  })

  it('says a post the server refused in its own words, for a team with nobody away', async () => {
    const t = setup()
    const numbers = new GitHubNumbers({ projects: async () => [PROJECT], crew: async () => ({ builders: crew(['Pip']).builders, machines: [] }), get: t.get,
      post: async () => { throw 'FORBIDDEN' }, log: t.log, now: () => nov10(24 + NUMBERS_HOUR), file: join(t.dir, 'numbers.json') })
    await numbers.tick()
    expect(t.log).toHaveBeenCalledWith('[super-tab] Daily numbers: NUMBERS_FAILED acme/app: FORBIDDEN')
  })

  it('reads nothing while every repository of its gh is stopped, and says so once', async () => {
    const t = setup(), numbers = t.open()
    // Signed out: GitHub is not asked again for five minutes (githubRest.ts).
    t.fail.get = Object.assign(new Error('gh is not signed in on this computer.'), { code: 'GH_SIGNED_OUT' })
    t.at(nov10(24 + NUMBERS_HOUR)); await numbers.tick()
    const read = t.get.mock.calls.length
    t.at(nov10(24 + NUMBERS_HOUR, 4)); await numbers.tick()
    expect(t.get).toHaveBeenCalledTimes(read)
    expect(t.log).toHaveBeenCalledExactlyOnceWith('[super-tab] Daily numbers: GH_SIGNED_OUT acme/app: gh is not signed in on this computer.')
    t.fail.get = null
    t.at(nov10(24 + NUMBERS_HOUR, 10)); await numbers.tick()
    expect(t.post).toHaveBeenCalledOnce()
  })

  it('says once a day when the day it posted cannot be kept, and the server takes the same post again as the first', async () => {
    const t = setup(), numbers = t.open(join(t.dir, 'no-such-folder', 'numbers.json'))
    t.at(nov10(24 + NUMBERS_HOUR)); await numbers.tick()
    t.at(nov10(24 + NUMBERS_HOUR, 10)); await numbers.tick()
    expect(t.post).toHaveBeenCalledOnce()
    expect(t.log.mock.calls.filter(([line]) => String(line).includes('NOT_SAVED'))).toHaveLength(1)
  })

  it('runs on its own timer once started, a look at a time, and stops', async () => {
    vi.useFakeTimers()
    try {
      const t = setup()
      t.at(nov10(24 + NUMBERS_HOUR))
      const numbers = t.open()
      numbers.start(); numbers.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(t.post).toHaveBeenCalledOnce()
      // The next day's look, from the timer.
      t.at(nov10(48 + NUMBERS_HOUR))
      await vi.advanceTimersByTimeAsync(NUMBERS_CHECK_MS)
      expect(t.post).toHaveBeenCalledTimes(2)
      expect(numbers.tick()).toBe(numbers.tick())
      numbers.stop(); numbers.stop()
    } finally { vi.useRealTimers() }
  })

  it('keeps this computer\'s clock and its log by default, and says a roster it cannot read', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(nov10(24 + NUMBERS_HOUR))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const dir = mkdtempSync(join(tmpdir(), 'super-tab-numbers-')); folders.push(dir)
      const numbers = new GitHubNumbers({ projects: async () => { throw new Error('the roster cannot be read') }, crew: async () => crew([]),
        get: async () => ({ status: 200, etag: null, body: [], resetAt: null }), post: async () => {}, file: join(dir, 'numbers.json') })
      await numbers.tick()
      expect(warn).toHaveBeenCalledWith('[super-tab] Daily numbers: FAILED the roster cannot be read')
    } finally { warn.mockRestore(); vi.useRealTimers() }
  })
})
