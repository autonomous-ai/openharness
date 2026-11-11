import { describe, expect, it, vi } from 'vitest'
import { GitHubReads, type GitHubGet } from './githubRest.js'
import { boardOf, boardWords, CHANGES_MAX, type Board } from './scoreboard.js'

type Json = Record<string, unknown>
/** 09:00 UTC on Wednesday 11 November, as a day's post is made. */
const NOW = Date.parse('2026-11-11T09:00:00Z'), MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const TEAM = new Set(['builder:pip', 'builder:kai'])
const HEAD = 'f6edb44'

/** A pull request of the team's that landed: opened and merged so long ago. */
const landed = (number: number, opened: number, merged: number, more: Json = {}): Json =>
  ({ number, title: `Change ${number}`, labels: [{ name: 'builder:pip' }], created_at: ago(opened), closed_at: ago(merged), pull_request: { merged_at: ago(merged) }, ...more })
/** A comment of the team's, so long ago. */
const said = (at: number, body: string, more: Json = {}): Json => ({ created_at: ago(at), author_association: 'MEMBER', body, ...more })
const ok = (at: number) => said(at, `Kai, 14:20: READ-OK ${HEAD}\n\nReads well.`)
const hold = (at: number) => said(at, `Kai, 14:20: HOLD ${HEAD}\n\nsrc/a.ts:3 is off by one.`)
/** One of the merger's notes to a pull request's author (githubMerge.ts NOTES). */
const note = (at: number, what: string, more: Json = {}) => said(at, `Harness, 14:20, to **Pip**: not merged yet at ${HEAD}: ${what}`, more)
const BEHIND = 'it is behind main: update the branch and push.', CONFLICT = 'it conflicts with main: rebase it on main and push.'

/** GitHub as far as the scoreboard reads it: each pull request's comments and files, a hundred a page, and every path asked. */
function github(comments: Record<number, Json[]> = {}, files: Record<number, string[]> = {}) {
  const asked: string[] = [], failing = new Map<RegExp, number>()
  const get: GitHubGet = async (path, etag) => {
    asked.push(`${path}${etag ? ' (with an ETag)' : ''}`)
    const url = new URL(`https://api.github.com${path}`), page = Number(url.searchParams.get('page') ?? 1)
    for (const [pattern, status] of failing) if (pattern.test(url.pathname)) return { status, etag: null, body: null, resetAt: null }
    const talk = /^\/repos\/acme\/app\/issues\/(\d+)\/comments$/.exec(url.pathname), changed = /^\/repos\/acme\/app\/pulls\/(\d+)\/files$/.exec(url.pathname)
    const rows = talk ? comments[Number(talk[1])] ?? [] : changed ? (files[Number(changed[1])] ?? []).map(filename => filename ? { filename } : {}) : null
    return rows ? { status: 200, etag: '"kept"', body: rows.slice((page - 1) * 100, page * 100), resetAt: null } : { status: 404, etag: null, body: null, resetAt: null }
  }
  return { asked, failing, reads: new GitHubReads(get, () => NOW) }
}
const board = (closed: Json[], hub = github(), unread = vi.fn()) => boardOf(hub.reads, 'acme/app', { now: NOW, closed, team: TEAM }, unread)

describe('where the day\'s landed changes waited', () => {
  it('says how long one waited for its first verdict, and from its last READ-OK to landing, as medians', async () => {
    const closed = [landed(1, 120 * MINUTE, 40 * MINUTE), landed(2, 300 * MINUTE, 250 * MINUTE), landed(3, 100 * MINUTE, 10 * MINUTE)]
    const talk = {
      // Asked at once, held 10 minutes after it opened, read OK twice (its second head), landed 10 minutes after the last.
      1: [said(119 * MINUTE, 'Harness, 14:01, to **Kai**: please read this pull request, then run `harness super-tab read ok acme/app#1 f6edb44 \'what you found\'`. '
        + 'For a HOLD, read hold in place of read ok, with the file, line and fix.'), hold(110 * MINUTE), ok(60 * MINUTE), ok(50 * MINUTE),
      said(40 * MINUTE, `Harness, 15:20: merged. READ-OK on ${HEAD} by Kai, checks green.`)],
      2: [ok(280 * MINUTE)],
      3: [ok(70 * MINUTE)],
    }
    expect((await board(closed, github(talk))).waits).toEqual({ landed: 3, read: 3, toVerdict: 20, toLanded: 30, behind: 0, conflict: 0 })
    // Of an even count, half way between the middle two.
    expect((await board([...closed, landed(4, 200 * MINUTE, 60 * MINUTE)], github({ ...talk, 4: [ok(160 * MINUTE)] }))).waits).toMatchObject({ landed: 4, toVerdict: 25, toLanded: 45 })
  })

  it('counts a verdict as the merger reads one: a comment\'s own, in its first line, from the team, and a READ-OK only before the landing', async () => {
    const one = [landed(1, 120 * MINUTE, 40 * MINUTE)]
    // Quoted, a stranger's, or talked about, it is none; a READ-OK made after it landed did not land it.
    const talk = [said(119 * MINUTE, `> READ-OK ${HEAD}`), said(118 * MINUTE, `Kai, 14:02: READ-OK ${HEAD}`, { author_association: 'NONE' }),
      said(117 * MINUTE, `Pip, 14:03: as Kai said, the READ-OK ${HEAD} stands`), ok(90 * MINUTE), ok(30 * MINUTE)]
    expect((await board(one, github({ 1: talk }))).waits).toMatchObject({ toVerdict: 30, toLanded: 50 })
    // Never read, no wait is known. Held and never read OK (landed by hand), its first verdict alone.
    expect((await board(one)).waits).toEqual({ landed: 1, read: 1, toVerdict: null, toLanded: null, behind: 0, conflict: 0 })
    expect((await board(one, github({ 1: [hold(100 * MINUTE)] }))).waits).toMatchObject({ toVerdict: 20, toLanded: null })
    // A comment GitHub gave no time, and a pull request it gave none for its opening, measure nothing.
    expect((await board(one, github({ 1: [{ author_association: 'MEMBER', body: `Kai, 14:20: READ-OK ${HEAD}` }] }))).waits).toMatchObject({ toVerdict: null, toLanded: null })
    expect((await board([landed(1, 0, 40 * MINUTE, { created_at: null })], github({ 1: [ok(50 * MINUTE)] }))).waits).toMatchObject({ toVerdict: null, toLanded: 10 })
  })

  it('counts the landed changes told they were behind or in conflict, each once however often it was told', async () => {
    const closed = [landed(1, 3 * HOUR, HOUR), landed(2, 3 * HOUR, HOUR), landed(3, 3 * HOUR, HOUR)]
    const hub = github({
      1: [note(170 * MINUTE, BEHIND), note(150 * MINUTE, BEHIND), note(120 * MINUTE, CONFLICT)],
      2: [note(170 * MINUTE, BEHIND), note(160 * MINUTE, 'checks failed: unit. Fix them and push.')],
      // The same words from outside the team are nobody's note.
      3: [note(170 * MINUTE, BEHIND, { author_association: 'CONTRIBUTOR' }), note(160 * MINUTE, CONFLICT, { author_association: 'NONE' })],
    })
    expect((await board(closed, hub)).waits).toMatchObject({ read: 3, behind: 2, conflict: 1 })
  })

  it('reads only the team\'s own: merged, or closed by a train that landed squashed, and nobody else\'s', async () => {
    const closed = [landed(1, 3 * HOUR, HOUR), landed(2, 3 * HOUR, HOUR, { labels: [{ name: 'bug' }] }), landed(3, 3 * HOUR, HOUR, { labels: [] }),
      // A train that landed squashed merged itself and closed what it carried (githubTrain.ts): #4 landed as it closed.
      { number: 900, title: 'Train: #4', labels: [], closed_at: ago(HOUR), pull_request: { merged_at: ago(HOUR) } },
      landed(4, 3 * HOUR, HOUR, { labels: [{ name: 'Builder:Kai' }], pull_request: { merged_at: null } }),
      // Closed, and never landed; an issue; and one GitHub gave no number for, which nothing can be asked of.
      landed(5, 3 * HOUR, HOUR, { pull_request: { merged_at: null } }), { number: 6, labels: [{ name: 'builder:pip' }], closed_at: ago(HOUR) },
      { ...landed(7, 3 * HOUR, HOUR), number: '7/../8' }]
    const hub = github({ 1: [ok(2 * HOUR)], 4: [ok(90 * MINUTE)] })
    expect((await board(closed, hub)).waits).toMatchObject({ landed: 2, read: 2, toVerdict: 75, toLanded: 45 })
    expect(hub.asked).toEqual(['/repos/acme/app/issues/1/comments?per_page=100', '/repos/acme/app/issues/4/comments?per_page=100',
      '/repos/acme/app/pulls/1/files?per_page=100', '/repos/acme/app/pulls/4/files?per_page=100'])
  })

  it('reads the newest fifty of the day\'s, up to three pages of comments each, and keeps nothing of them', async () => {
    // Sixty landed in the day, #1 the last; one a minute over a day ago.
    const closed = [...Array.from({ length: 60 }, (_, at) => landed(at + 1, 20 * HOUR, (at + 1) * MINUTE)), landed(99, 30 * HOUR, DAY + MINUTE)]
    const hub = github({ 1: Array.from({ length: 250 }, (_, at) => said((1000 - at) * MINUTE, 'Still on it.')) })
    expect((await board(closed, hub)).waits).toMatchObject({ landed: 60, read: CHANGES_MAX })
    const talk = hub.asked.filter(path => path.includes('/comments'))
    expect(talk).toHaveLength(52)
    expect(talk.slice(0, 4)).toEqual(['/repos/acme/app/issues/1/comments?per_page=100', '/repos/acme/app/issues/1/comments?per_page=100&page=2',
      '/repos/acme/app/issues/1/comments?per_page=100&page=3', '/repos/acme/app/issues/2/comments?per_page=100'])
    expect(talk.at(-1)).toBe('/repos/acme/app/issues/50/comments?per_page=100')
    // Asked again the next day, each is asked outright: no answer was kept, and none sits in memory between two posts.
    await board(closed, hub)
    expect(hub.asked.filter(path => path.includes('/comments'))).toHaveLength(104)
    expect(hub.asked.some(path => path.endsWith('(with an ETag)'))).toBe(false)
    // A READ-OK on the third page is read; one past it is not.
    const long = (verdictAt: number) => Array.from({ length: 350 }, (_, at) => at === verdictAt ? ok(700 * MINUTE) : said((1000 - at) * MINUTE, 'Still on it.'))
    expect((await board([landed(1, 20 * HOUR, MINUTE)], github({ 1: long(299) }))).waits).toMatchObject({ toVerdict: 500, toLanded: 699 })
    expect((await board([landed(1, 20 * HOUR, MINUTE)], github({ 1: long(300) }))).waits).toMatchObject({ toVerdict: null, toLanded: null })
  })
})

describe('what the day\'s trains did', () => {
  it('counts the ones that landed, and the ones closed without landing by why, as each was titled', async () => {
    const train = (title: string, closedAgo: number, merged = false): Json => ({ number: 900, title, labels: [], closed_at: ago(closedAgo), pull_request: { merged_at: merged ? ago(closedAgo) : null } })
    const closed = [train('Train: #1 #2', HOUR, true), train('Train: #3', 2 * HOUR, true), train('Train, red: #4 #5', HOUR), train('Train, base moved: #4', HOUR), train('Train, base moved: #4 #5', 3 * HOUR),
      train('Train, rider changed: #6', HOUR), train('Train, out of time: #7', HOUR), train('Train: #8', HOUR),
      // Over a day ago, landed or not; a title that is no train's; one landed under a closed train's title; and an issue so titled.
      train('Train: #9', 25 * HOUR, true), train('Train, red: #9', 25 * HOUR), train('Train: improve the docs', HOUR), train('Trains run on time', HOUR), train('Train, late: #1', HOUR),
      train('Train, red: #4', HOUR, true), { number: 7, title: 'Train: #1', closed_at: ago(HOUR), labels: [] }, { number: 8, pull_request: {}, closed_at: ago(HOUR) }]
    expect((await board(closed)).trains).toEqual({ landed: 2, closed: { red: 1, moved: 2, changed: 1, late: 1, other: 1 } })
    expect((await board([])).trains).toEqual({ landed: 0, closed: {} })
  })
})

describe('the files most landings touch', () => {
  /** [count] landed in the week, #1 the last, eight hours apart or [apart]; and #99, eight days ago. */
  const week = (count: number, apart = 8 * HOUR) => [...Array.from({ length: count }, (_, at) => landed(at + 1, 8 * DAY, (at + 1) * apart)), landed(99, 9 * DAY, 8 * DAY)]
  const own = (count: number): Record<number, string[]> => Object.fromEntries(Array.from({ length: count }, (_, at) => [at + 1, [`src/own${at}.ts`]]))

  it('names a file in more than a tenth of the week\'s landings, and in three at least, the most touched first', async () => {
    const files = own(20)
    for (const number of [1, 2, 3, 4, 5, 6]) files[number]!.push('src/hub.ts')
    // Listed twice in one landing (GitHub's list of a rename), it is touched once.
    for (const number of [1, 2, 3]) files[number]!.push('src/store.ts', 'src/store.ts')
    for (const number of [4, 5]) files[number]!.push('src/twice.ts')
    // A file GitHub names nothing is none.
    for (const number of [1, 2, 3, 4]) files[number]!.push('')
    files[99] = ['src/hub.ts']
    const hub = github({}, files)
    expect((await board(week(20), hub)).hot).toEqual({ landings: 20, files: [['src/hub.ts', 6], ['src/store.ts', 3]] })
    // A page of each landing's files, the last landed first, and none of one that landed over a week ago.
    const asked = hub.asked.filter(path => path.includes('/files'))
    expect(asked).toHaveLength(20)
    expect(asked.slice(0, 2)).toEqual(['/repos/acme/app/pulls/1/files?per_page=100', '/repos/acme/app/pulls/2/files?per_page=100'])
    // Three of thirty is a tenth, not more; four of thirty is.
    const edge = own(30)
    for (const number of [1, 2, 3]) edge[number]!.push('src/edge.ts')
    expect((await board(week(30, 5 * HOUR), github({}, edge))).hot).toEqual({ landings: 30, files: [] })
    edge[4]!.push('src/edge.ts')
    expect((await board(week(30, 5 * HOUR), github({}, edge))).hot).toEqual({ landings: 30, files: [['src/edge.ts', 4]] })
  })

  it('names three files at most, of the newest fifty landings of the week', async () => {
    const files = own(60)
    for (const number of [1, 2, 3, 4, 5, 6, 7]) files[number]!.push('src/b.ts', 'src/a.ts')
    for (const number of [1, 2, 3, 4, 5, 6, 7, 8]) files[number]!.push('src/c.ts')
    for (const number of [1, 2, 3, 4, 5, 6]) files[number]!.push('src/d.ts')
    // Touched by ten of the oldest ten, which are not read.
    for (let number = 51; number <= 60; number++) files[number]!.push('src/old.ts')
    const hub = github({}, files)
    expect((await board(week(60, 2 * HOUR), hub)).hot).toEqual({ landings: CHANGES_MAX, files: [['src/c.ts', 8], ['src/a.ts', 7], ['src/b.ts', 7]] })
    expect(hub.asked.filter(path => path.includes('/files'))).toHaveLength(CHANGES_MAX)
    // No landing in the week: nothing is asked, and no file is named.
    const none = github()
    expect((await board([landed(99, 9 * DAY, 8 * DAY)], none)).hot).toEqual({ landings: 0, files: [] })
    expect(none.asked).toEqual([])
  })
})

describe('a part GitHub does not give', () => {
  it('is left out and said, with why, and no more of it is asked', async () => {
    const closed = [landed(1, 3 * HOUR, HOUR), landed(2, 3 * HOUR, 2 * HOUR)]
    const talk = { 1: [ok(2 * HOUR)], 2: [ok(150 * MINUTE)] }, files = { 1: ['src/a.ts'], 2: ['src/a.ts'] }
    const hub = github(talk, files), unread = vi.fn()
    hub.failing.set(/\/comments$/, 403)
    expect(await board(closed, hub, unread)).toEqual({ waits: null, trains: { landed: 0, closed: {} }, hot: { landings: 2, files: [] } })
    expect(unread.mock.calls).toEqual([['waits', 'this computer\'s gh login cannot read acme/app.']])
    expect(hub.asked.filter(path => path.includes('/comments'))).toHaveLength(1)
    // The files alone: the waits are said all the same.
    const other = github(talk, files), missed = vi.fn()
    other.failing.set(/\/files$/, 500)
    expect(await board(closed, other, missed)).toMatchObject({ waits: { read: 2, toVerdict: 45, toLanded: 45 }, hot: null })
    expect(missed.mock.calls).toEqual([['files', 'GitHub answered 500.']])
    expect(other.asked.filter(path => path.includes('/files'))).toHaveLength(1)
    // A failure with no words of its own is said as it is.
    const wordless = { freshPages: async () => { throw 'no answer' } } as unknown as GitHubReads, both = vi.fn()
    expect(await boardOf(wordless, 'acme/app', { now: NOW, closed, team: TEAM }, both)).toMatchObject({ waits: null, hot: null })
    expect(both.mock.calls).toEqual([['waits', 'no answer'], ['files', 'no answer']])
  })
})

describe('what the day\'s post says of it', () => {
  const waits: NonNullable<Board['waits']> = { landed: 12, read: 12, toVerdict: 7.4, toLanded: 34, behind: 5, conflict: 2 }
  const quiet: Board = { waits: null, trains: { landed: 0, closed: {} }, hot: null }

  it('says the waits, the rework, the trains and the files, a sentence each', () => {
    expect(boardWords({ waits, trains: { landed: 4, closed: { moved: 2, red: 1 } },
      hot: { landings: 43, files: [['backend/src/superTabs/commands.ts', 12], ['backend/src/superTabs/store.ts', 9]] } }))
      .toBe('A landed change waited 7 min for its first verdict and 34 min from its last READ-OK to landing (medians). Told to rework: 5 behind, 2 in conflict. '
        + 'Trains: 4 landed, 3 closed without landing (base moved 2, checks failed 1). '
        + 'Files touched most in 7 days (43 landings): `backend/src/superTabs/commands.ts` 28%, `backend/src/superTabs/store.ts` 21%.')
  })

  it('says a wait in minutes, or in hours from two, and only the waits that are known', () => {
    const of = (over: Partial<NonNullable<Board['waits']>>) => boardWords({ ...quiet, waits: { ...waits, ...over } })
    expect(of({ toVerdict: 0.2, toLanded: 119 })).toContain('waited 0 min for its first verdict and 119 min from its last READ-OK to landing (medians).')
    expect(of({ toVerdict: 120, toLanded: 1575 })).toContain('waited 2 h for its first verdict and 26.3 h from its last READ-OK to landing (medians).')
    expect(of({ toLanded: null })).toBe('A landed change waited 7 min for its first verdict (median). Told to rework: 5 behind, 2 in conflict.')
    expect(of({ toVerdict: null })).toBe('A landed change waited 34 min from its last READ-OK to landing (median). Told to rework: 5 behind, 2 in conflict.')
    expect(of({ toVerdict: null, toLanded: null })).toBe('Told to rework: 5 behind, 2 in conflict.')
    // More landed than were read: said of the ones read.
    expect(of({ landed: 74, read: 50 })).toBe('Of the newest 50: a landed change waited 7 min for its first verdict and 34 min from its last READ-OK to landing (medians). Told to rework: 5 behind, 2 in conflict.')
    expect(of({ landed: 74, read: 50, toVerdict: null, toLanded: null, behind: 0 })).toBe('Of the newest 50: told to rework: 0 behind, 2 in conflict.')
    // None told is said too: a count that went to none is what a change to the merger is judged by.
    expect(of({ behind: 0, conflict: 0 })).toBe('A landed change waited 7 min for its first verdict and 34 min from its last READ-OK to landing (medians). None was told to rework.')
    // Nothing landed in the day, or their comments could not be read: nothing is said of them.
    expect(of({ landed: 0, read: 0, toVerdict: null, toLanded: null, behind: 0, conflict: 0 })).toBe('')
    expect(boardWords(quiet)).toBe('')
  })

  it('says the trains that landed and why the others closed, the most first, and nothing on a day with none', () => {
    const of = (trains: Board['trains']) => boardWords({ ...quiet, trains })
    expect(of({ landed: 4, closed: {} })).toBe('Trains: 4 landed.')
    expect(of({ landed: 0, closed: { late: 1 } })).toBe('Trains: 0 landed, 1 closed without landing (out of time 1).')
    expect(of({ landed: 1, closed: { other: 1, late: 2, changed: 3, moved: 3, red: 5 } }))
      .toBe('Trains: 1 landed, 14 closed without landing (checks failed 5, base moved 3, rider changed 3, out of time 2, other 1).')
  })

  it('says each file as plain text in a code span, by its end when it is long, and its share of the landings', () => {
    const of = (files: Array<[string, number]>, landings = 10) => boardWords({ ...quiet, hot: { landings, files } })
    expect(of([['src/a.ts', 3]])).toBe('Files touched most in 7 days (10 landings): `src/a.ts` 30%.')
    expect(of([])).toBe('')
    // A path is anyone's text who landed a file: nothing of it tags, links, or ends the code span, and a long one is cut.
    expect(of([['docs/`@everyone` [x](http://evil.io) <b>.md', 4]])).toBe('Files touched most in 7 days (10 landings): `docs/everyone xhttp//evil.io b.md` 40%.')
    expect(of([[`src/${'𠮷'.repeat(120)}/store.ts`, 5]])).toBe(`Files touched most in 7 days (10 landings): \`…${'𠮷'.repeat(90)}/store.ts\` 50%.`)
  })
})
