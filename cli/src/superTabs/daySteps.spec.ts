import { describe, expect, it, vi } from 'vitest'
import type { Crew } from './assign/crew.js'
import { claimant, DaySteps, membersOf, readSteps, stepsOf, stepsText, type Landed, type Member } from './daySteps.js'
import type { GitHubGet } from './githubRest.js'

type Json = Record<string, unknown>
const PROJECT = { repo: 'acme/app', pm: 'Faye', tabId: 'tab', pmAgentId: 'faye', projectId: 'app' }
const MIN = 60_000
/** A time on 10 November 2026 on this computer's clock. */
const nov10 = (hour: number, minute = 0) => new Date(2026, 10, 10, hour, minute).getTime()
const iso = (at: number) => new Date(at).toISOString()
const crew = (names: string[], away: string[] = []): Crew => ({ builders: names.map(name => ({ id: name, name, label: `builder:${name.toLowerCase()}`, machineId: 'm', engine: 'claude' })),
  machines: [], away: away.map(name => ({ name, label: `builder:${name.toLowerCase()}`, why: 'down' as const })) })
const pull = (number: number, builder: string, opened: number, merged: number | null, extra: Json = {}): Json => ({ number, created_at: iso(opened),
  closed_at: iso(merged ?? opened + 30 * MIN), merged_at: merged === null ? null : iso(merged), head: { ref: `${builder.toLowerCase()}/${number}` },
  labels: [{ name: `builder:${builder}` }], user: { login: 'dee' }, ...extra })
const said = (at: number, body: string): Json => ({ created_at: iso(at), body, user: { login: 'dee' }, author_association: 'OWNER' })
/** The team by its builders' names, each by its label's name as Harness makes it. */
const members = (...names: string[]): Member[] => names.map(name => ({ slug: name.toLowerCase().replace(/\s+/g, '-'), name }))

describe('a landed pull request\'s steps, as the Swarm study measured lampOS\'s', () => {
  it('times ready to its first verdict, its last READ-OK to landed, ready to landed, and whether it landed within 3 h', () => {
    const opened = nov10(9), merged = nov10(10, 30)
    const steps = stepsOf(pull(7, 'Pip', opened, merged, { body: 'The menu.\n\nCloses #3' }), [
      said(nov10(9, 5), 'Harness, 09:05, to **Kai**: READ-OK please, at 1234567'),
      said(nov10(9, 20), 'Kai, 09:20: HOLD 1234567 the test is missing'),
      said(nov10(9, 50), 'Kai, 09:50: READ-OK 89abcde'),
      said(nov10(10, 40), 'Kai, 10:40: READ-OK fedcba9'),
    ], [], members('Pip', 'Kai'))
    expect(steps).toEqual({ builder: 'pip', task: 3, mergedAt: merged, readyToLanded: 90, within3h: true, firstVerdict: 20, okToLanded: 40 })
  })

  it('is ready when it was last marked ready, a verdict talked about is none, and a builder is matched however its label is spelled', () => {
    const ready = nov10(11), merged = nov10(15)
    const steps = stepsOf(pull(8, 'kai', nov10(8), merged, { labels: [{ name: 'Builder:kai' }] }), [
      said(nov10(10), 'Pip, 10:00: READ-OK 1234567, before it was ready'),
      said(nov10(11, 30), '> Pip, 11:30: READ-OK 1234567'),
      said(nov10(12), 'Pip, 12:00: READ-OK 89abcde'),
    ], [{ event: 'ready_for_review', created_at: iso(nov10(9)) }, { event: 'ready_for_review', created_at: iso(ready) }, { event: 'labeled', created_at: iso(nov10(14)) }],
    members('Pip', 'Kai'))
    expect(steps).toMatchObject({ builder: 'kai', firstVerdict: 60, okToLanded: 180, readyToLanded: 240, within3h: false })
  })

  it('has no verdict steps when nobody read it, no task when it closes none, and is no member\'s when the team does not name it', () => {
    // Words with no verdict, and a comment or review with none at all, are no verdict.
    const talk = [said(nov10(9, 5), '\n\nlooks fine'), { created_at: iso(nov10(9, 6)), user: { login: 'dee' } }]
    expect(stepsOf(pull(9, 'Pip', nov10(9), nov10(9, 30), { body: 'See #4.' }), talk, [], members('Pip')))
      .toMatchObject({ builder: 'pip', task: null, firstVerdict: null, okToLanded: null })
    expect(stepsOf(pull(9, 'harness', nov10(9), nov10(9, 30)), [], [], members('Pip')).builder).toBeNull()
    // A builder whose name has a space is its label's name, as its pull requests carry it.
    expect(stepsOf(pull(10, 'juno-ray', nov10(9), nov10(9, 30)), [], [], members('Juno Ray')).builder).toBe('juno-ray')
  })

  // Code review of #4051: as the merger reads verdicts, from the team's logins only, and never the pull request's own builder's.
  it('counts no verdict from outside the team, nor its own builder\'s', () => {
    const outsider = { ...said(nov10(9, 5), 'Kai, 09:05: READ-OK 1234567'), author_association: 'NONE' }
    const own = said(nov10(9, 10), 'Pip, 09:10: READ-OK 1234567')
    expect(stepsOf(pull(7, 'Pip', nov10(9), nov10(10)), [outsider, own], [], members('Pip', 'Kai'))).toMatchObject({ firstVerdict: null, okToLanded: null })
    expect(stepsOf(pull(7, 'Pip', nov10(9), nov10(10)), [own, said(nov10(9, 20), '**Kai**, 09:20: READ-OK 1234567')], [], members('Pip', 'Kai')))
      .toMatchObject({ firstVerdict: 20, okToLanded: 40 })
  })

  it('reads a take by its comment, the builder named twice, and nothing else', () => {
    expect(claimant({ body: 'Pip, 14:05: taken by Pip' })).toBe('Pip')
    expect(claimant({ body: 'Kai Lee, 14:05: taken by Kai Lee\nmore' })).toBe('Kai Lee')
    for (const body of ['Pip, 14:05: taken by Kai', 'taken by Pip', 'Pip, 14:05: READ-OK 1234567', '']) expect(claimant({ body })).toBeNull()
    expect(claimant({})).toBeNull()
  })

  it('names the team by its labels, says each name by its letters alone, and has its PM once', () => {
    const team: Crew = { builders: [{ id: 'a', name: '@everyone', label: 'builder:@everyone', machineId: 'm', engine: 'claude' },
      { id: 'b', name: 'evil.example.com', label: 'builder:evil.example.com', machineId: 'm', engine: 'claude' }], machines: [],
    away: [{ name: 'Juno Ray', label: 'builder:juno-ray', why: 'down' }] }
    expect(membersOf(team, 'Faye')).toEqual([{ slug: '@everyone', name: 'everyone' }, { slug: 'evil.example.com', name: 'evilexamplecom' },
      { slug: 'juno-ray', name: 'Juno Ray' }, { slug: 'faye', name: 'Faye', pm: true }])
    // A PM that builds too is one of the team, once.
    expect(membersOf(team, 'Juno Ray').filter(m => m.slug === 'juno-ray')).toEqual([{ slug: 'juno-ray', name: 'Juno Ray' }])
    expect(membersOf({ builders: [], machines: [] }, 'Faye')).toEqual([{ slug: 'faye', name: 'Faye', pm: true }])
  })
})

describe('the steps as the day\'s post says them', () => {
  const landed = (builder: string | null, task: number | null, firstVerdict: number | null, okToLanded: number | null, readyToLanded: number,
    within3h: boolean, mergedAt: number): Landed => ({ builder, task, firstVerdict, okToLanded, readyToLanded, within3h, mergedAt })
  const take = (slug: string, issue: number, at: number) => ({ slug, issue, at })

  it('gives the team\'s steps first, then every builder\'s, one with nothing landed too, and its PM only on a day it landed', () => {
    const text = stepsText([...members('Pip', 'Kai', 'Lee', 'Juno'), { slug: 'faye', name: 'Faye', pm: true }], [
      landed('pip', 1, 4, 20, 50, true, nov10(10)), landed('pip', 2, 8, 30, 70, true, nov10(14)), landed('kai', 3, 30, 25, 200, false, nov10(16)),
      landed('lee', null, 10, 5, 40, true, nov10(17)),
    ], 1, [
      // Pip took its next task 3 and 7 minutes after each landed; Kai had taken its next before its #3 landed; Lee took none since.
      take('pip', 1, nov10(9)), take('pip', 2, nov10(10, 3)), take('pip', 4, nov10(14, 7)),
      take('kai', 3, nov10(11)), take('kai', 5, nov10(15)), take('lee', 6, nov10(12)),
    ], false)
    expect(text.split('\n')).toEqual([
      'Steps · ready → first verdict 9 min (p90 30 min) · last READ-OK → landed 23 min · ready → landed 1 h · 75% landed within 3 h of opening'
        + ' · free → next task 3 min · 1 closed without landing',
      'Pip: 2 landed · ready → first verdict 6 min · last READ-OK → landed 25 min · free → next task 5 min',
      'Kai: 1 landed · ready → first verdict 30 min · last READ-OK → landed 25 min · free → next task 0 min',
      'Lee: 1 landed · ready → first verdict 10 min · last READ-OK → landed 5 min · no task taken since its last landed',
      'Juno: nothing landed',
    ])
  })

  it('says when the day was cut, has no steps it cannot tell, and gives its PM a line on a day it landed', () => {
    expect(stepsText([{ slug: 'faye', name: 'Faye', pm: true }], [landed('faye', null, null, null, 90, true, nov10(9))], 0, [], true).split('\n')).toEqual([
      'Steps of the first 200 landed · ready → landed 1.5 h · 100% landed within 3 h of opening',
      'Faye: 1 landed · no task taken since its last landed',
    ])
    expect(stepsText(members('Pip'), [], 2, [], false).split('\n')).toEqual(['Steps · 2 closed without landing', 'Pip: nothing landed'])
  })
})

describe('the steps of a project\'s last 24 hours, read from its GitHub', () => {
  /** acme/app on GitHub on 11 November at 09:00: since 09:00 the day before, Pip's #7 landed after Kai's READ-OK and Pip took its
   *  next task; Kai's #5 landed, listed first as GitHub lists the last changed first, and Kai took none since; Kai's #8 was closed;
   *  Pip's #6 landed the day before that. */
  function setup(pulls?: Json[]) {
    const get = vi.fn<GitHubGet>(async path => {
      const url = new URL(`https://api.github.com${path}`)
      const body = url.pathname === '/repos/acme/app/pulls' ? pulls ?? [pull(5, 'Kai', nov10(10, 30), nov10(11, 30)), pull(7, 'Pip', nov10(9), nov10(10)),
        pull(8, 'Kai', nov10(11), null), pull(6, 'Pip', nov10(9) - 24 * 60 * MIN, nov10(9) - 23 * 60 * MIN)]
        : url.pathname === '/repos/acme/app/issues/7/comments' ? [said(nov10(9, 6), 'Kai, 09:06: READ-OK 1234567')]
        // Pip's take of its next task; a take with no issue to it is none.
        // Pip's take of its next task, the newest first as asked; a take with no issue to it, or from outside the team, is none.
        : url.pathname === '/repos/acme/app/issues/comments' ? [{ ...said(nov10(10, 3), 'Kai, 10:03: taken by Kai'), author_association: 'NONE',
          issue_url: 'https://api.github.com/repos/acme/app/issues/10' }, { ...said(nov10(10, 4), 'Pip, 10:04: taken by Pip'), issue_url: 'https://api.github.com/repos/acme/app/issues/9' },
          said(nov10(10, 2), 'Kai, 10:02: on it'), said(nov10(10, 1), 'Pip, 10:01: taken by Pip')]
        : []
      return { status: 200, etag: null, body, resetAt: null }
    })
    // Kai's machine is down: still on the team, and still in its numbers.
    const steps = readSteps({ get, crew: async () => crew(['Pip'], ['Kai']), now: () => nov10(24 + 9) })
    return { get, steps }
  }

  it('reads each landed pull request of the team, and the takes around them', async () => {
    const t = setup()
    expect((await t.steps(PROJECT))!.split('\n')).toEqual([
      'Steps · ready → first verdict 6 min (p90 6 min) · last READ-OK → landed 54 min · ready → landed 1 h · 100% landed within 3 h of opening'
        + ' · free → next task 4 min · 1 closed without landing',
      'Pip: 1 landed · ready → first verdict 6 min · last READ-OK → landed 54 min · free → next task 4 min',
      'Kai: 1 landed · no task taken since its last landed',
    ])
    // The takes since the day before the window began, the newest first; each pull request's last ready within three pages of events.
    const paths = t.get.mock.calls.map(([path]) => path)
    expect(paths).toContain(`/repos/acme/app/issues/comments?since=${iso(nov10(9) - 24 * 60 * MIN)}&sort=created&direction=desc&per_page=100`)
    expect(paths).toContain('/repos/acme/app/issues/7/events?per_page=100')
  })

  it('counts what a train carried as landed when the train merged, and no train as anyone\'s', async () => {
    const train = (number: number, title: string, opened: number, merged: number | null) =>
      pull(number, 'harness', opened, merged, { title, head: { ref: `harness-train/${number}` }, labels: [] })
    // Pip's #11 and Kai's #12 rode a train that landed squashed at 12:00, which closed them; Pip's #13 rode one merged as a merge
    // commit at 15:00, which GitHub marks merged, after a red one at 13:00. #14 was named by no train, and #15 by a red one.
    const t = setup([train(20, 'Train: #11 #12 #14x', nov10(11, 40), nov10(12)), pull(11, 'Pip', nov10(10), null, { closed_at: iso(nov10(12, 1)) }),
      pull(12, 'Kai', nov10(10, 30), null, { closed_at: iso(nov10(12, 1)) }), pull(14, 'Kai', nov10(10, 30), null, { closed_at: iso(nov10(12, 2)) }),
      train(21, 'Train, red: #13 #15', nov10(12, 30), null), pull(15, 'Pip', nov10(10), null, { closed_at: iso(nov10(13, 30)) }),
      train(22, 'Train: #13', nov10(14, 30), nov10(15)), pull(13, 'Pip', nov10(12), nov10(15))])
    expect((await t.steps(PROJECT))!.split('\n')).toEqual([
      'Steps · ready → landed 2 h · 100% landed within 3 h of opening · 2 closed without landing',
      'Pip: 2 landed · no task taken since its last landed',
      'Kai: 1 landed · no task taken since its last landed',
    ])
  })

  it('counts only the team\'s own pull requests, and has none for a day the team landed and closed nothing', async () => {
    // A shared repository's people land and close their own; they are not the team's steps.
    const person = (number: number, merged: number | null) => pull(number, 'Pip', nov10(9), merged, { labels: [], head: { ref: `dee/fix-${number}` } })
    expect((await setup([pull(7, 'Pip', nov10(9), nov10(10)), person(20, nov10(11)), person(21, null)]).steps(PROJECT))!.split('\n')).toEqual([
      'Steps · ready → first verdict 6 min (p90 6 min) · last READ-OK → landed 54 min · ready → landed 1 h · 100% landed within 3 h of opening'
        + ' · free → next task 4 min',
      'Pip: 1 landed · ready → first verdict 6 min · last READ-OK → landed 54 min · free → next task 4 min',
      'Kai: nothing landed',
    ])
    expect(await setup([person(20, nov10(11)), person(21, null)]).steps(PROJECT)).toBeNull()
  })

  it('reads this computer\'s clock when given none', async () => {
    vi.useFakeTimers({ now: nov10(24 + 9), toFake: ['Date'] })
    try {
      const get = vi.fn<GitHubGet>(async () => ({ status: 200, etag: null, body: [], resetAt: null }))
      expect(await readSteps({ get, crew: async () => crew(['Pip']) })(PROJECT)).toBeNull()
    } finally { vi.useRealTimers() }
  })
})

describe('the steps, read beside the assigner\'s pass', () => {
  it('starts the read at the first ask of a day, answers it once read, and reads a project once a day', async () => {
    let finish!: (text: string | null) => void
    const read = vi.fn((_project: unknown) => new Promise<string | null>(resolve => { finish = resolve }))
    const steps = new DaySteps(read)
    expect(steps.of(PROJECT, '2026-11-11')).toBeUndefined()
    expect(steps.of(PROJECT, '2026-11-11')).toBeUndefined()
    finish('Steps · 1 closed without landing')
    await Promise.resolve()
    expect(steps.of(PROJECT, '2026-11-11')).toBe('Steps · 1 closed without landing')
    expect(read).toHaveBeenCalledTimes(1)
    // The next day, read again.
    expect(steps.of(PROJECT, '2026-11-12')).toBeUndefined()
    finish(null)
    await Promise.resolve()
    expect(steps.of(PROJECT, '2026-11-12')).toBeNull()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('answers none for steps it could not read, and says why once, on this computer\'s log when given none', async () => {
    const log = vi.fn()
    const steps = new DaySteps(async () => { throw new Error('GitHub did not answer.') }, log)
    steps.of(PROJECT, '2026-11-11')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(steps.of(PROJECT, '2026-11-11')).toBeNull()
    expect(log).toHaveBeenCalledExactlyOnceWith('[super-tab] numbers: STEPS_UNREAD acme/app: GitHub did not answer.')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const quiet = new DaySteps(async () => { throw 'no words' })
      quiet.of(PROJECT, '2026-11-11')
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(warn).toHaveBeenCalledWith('[super-tab] numbers: STEPS_UNREAD acme/app: no words')
    } finally { warn.mockRestore() }
  })
})
