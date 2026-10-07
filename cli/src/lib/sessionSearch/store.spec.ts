import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { MARK_CLOSE, MARK_OPEN, SessionSearchStore, makeSnippet, queryTerms, type IndexedSession } from './store.js'
import type { IndexedTurn } from './turns.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-09-26T12:00:00Z')
const stores: SessionSearchStore[] = []
const dirs: string[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function open(path = ':memory:'): SessionSearchStore {
  const store = SessionSearchStore.open(path)
  if (!store) throw new Error('node:sqlite is required for these tests')
  stores.push(store)
  return store
}

function session(sessionId: string, header: string, lastAt: number, agentId = `agent-${sessionId}`): IndexedSession {
  return { sessionId, agentId, engine: 'claude', path: `/t/${sessionId}.jsonl`, header, size: 1, mtime: 1, resumeOffset: 0, resumeTurn: 0, lastAt, turns: 0 }
}

function turn(index: number, ask: string, answer = '', tools = '', at: number | null = null): IndexedTurn {
  return { turn: index, offset: index * 100, at, ask, answer, tools }
}

const plain = (snippet: string) => snippet.replaceAll(MARK_OPEN, '[').replaceAll(MARK_CLOSE, ']')

describe('fuzzy picker catalog', () => {
  it('pages every session by stable identity, including old and empty conversations', () => {
    const store = open()
    for (let i = 0; i < 207; i++) {
      const sid = `s-${String(i).padStart(3, '0')}`
      store.writeSession({ ...session(sid, `Task ${i} /work/project`, i, ''), title: `Task ${i}`, cwd: '/work/project', origin: 'cli' }, 0, [])
    }
    const first = store.search('', { catalogAfter:'', limit:1000 })
    const second = store.search('', { catalogAfter:first.at(-1)!.sessionId, limit:100 })
    const third = store.search('', { catalogAfter:second.at(-1)!.sessionId, limit:100 })
    expect([first.length,second.length,third.length]).toEqual([100,100,7])
    expect(new Set([...first,...second,...third].map(h=>h.sessionId)).size).toBe(207)
    expect(first[0]).toMatchObject({turn:-1, external:{title:'Task 0',cwd:'/work/project'}})
    expect(store.search('',{catalogAfter:third.at(-1)!.sessionId})).toEqual([])
    expect(store.search('',{catalogAfter:"' OR 1=1 --"})).toHaveLength(100)
    expect(store.search('')).toEqual([])
  })
})

describe('queryTerms', () => {
  it('makes each word a prefix phrase of its parts and drops what cannot mean anything alone', () => {
    expect(queryTerms('swarm_search.dart OH-14')).toEqual(['"swarm search dart"*', '"oh 14"*'])
    expect(queryTerms('a fix  FIX x')).toEqual(['"fix"*'])
    expect(queryTerms('  ')).toEqual([])
  })

  it('never passes FTS5 syntax through', () => {
    const store = open()
    store.writeSession(session('s1', 'Dial', NOW), 0, [turn(0, 'fix the dial')])
    for (const query of ['"dial', 'dial" OR "x', 'NEAR(dial', 'dial*', '-dial', 'dial:', '^dial', '(', '"']) {
      expect(() => store.search(query, { now: NOW })).not.toThrow()
    }
    expect(store.search('NEAR(dial', { now: NOW })).toEqual([])
    expect(store.search('dial"', { now: NOW }).map((hit) => hit.sessionId)).toEqual(['s1'])
  })
})

describe('makeSnippet', () => {
  const words = (...parts: string[][]) => parts.map((part) => new RegExp(`(?<![\\p{L}\\p{N}])${part.join('[^\\p{L}\\p{N}]+')}[\\p{L}\\p{N}]*`, 'giu'))

  it('quotes the words around the first match and marks every match there', () => {
    const text = `${'lorem '.repeat(40)}we halved the Scroll delta so scrolling feels right ${'ipsum '.repeat(40)}`
    expect(plain(makeSnippet(text, words(['scroll']))!)).toBe('…lorem we halved the [Scroll] delta so [scrolling] feels right ipsum ipsum…')
    expect(makeSnippet('nothing here', words(['scroll']))).toBeNull()
  })

  it('is one line, though the text it quotes keeps its line breaks', () => {
    expect(plain(makeSnippet('Plan:\n\n- halve the scroll\n  delta\n- flash', words(['scroll']))!)).toBe('Plan: - halve the [scroll] delta - flash')
  })

  it('survives a match inside one long unbroken run', () => {
    const run = '東'.repeat(700)
    expect(() => makeSnippet(run, words(['東東']))).not.toThrow()
    const token = `eyJ${'a'.repeat(900)} and more`
    expect(makeSnippet(token, words(['eyj']))).toContain(MARK_OPEN)
  })

  it('matches a word of parts as the index does, and keeps short text whole', () => {
    expect(plain(makeSnippet('edit desktop/lib/swarm_search.dart now', words(['swarm', 'search', 'dart']))!))
      .toBe('edit desktop/lib/[swarm_search.dart] now')
    expect(plain(makeSnippet('research is not search', words(['search']))!)).toBe('research is not [search]')
  })
})

describe('SessionSearchStore', () => {
  it('reviews only timestamped person turns within the window, without tool data or session-time fallbacks', () => {
    const store = open()
    store.writeSession(session('recent', 'Layout discussion', NOW), 0, [
      turn(0, 'old words', 'old answer', '', NOW - DAY - 1),
      turn(1, 'viewer on the left', 'understood', 'secret tool data', NOW - DAY),
      turn(2, '', 'continuation only', '', NOW - 10),
      turn(3, 'unknown date', '', '', null),
      turn(4, 'current words', '', '', NOW),
      turn(5, 'future words', '', '', NOW + 1),
    ])
    const result = store.recentConversations(NOW - DAY, NOW)
    expect(result.rows.map(r => r.turn)).toEqual([4, 1])
    expect(result.rows[1]).toMatchObject({ ask: 'viewer on the left', answer: 'understood', tools: '', title: 'Layout discussion' })
    expect(store.recentConversations(NOW - DAY, NOW, 1)).toMatchObject({ more: true, rows: [{ turn: 4 }] })
    expect(store.recentConversations(NaN, NOW).rows).toEqual([])
  })

  it('finds a session by a word from any turn, as a prefix, with its own snippet', () => {
    const store = open()
    store.writeSession(session('dial', 'Deploy firmware', NOW - DAY), 0, [
      turn(0, 'flash the latest firmware'),
      turn(1, 'the dial scroll jumps two rows', 'Halved the scroll delta in ui.c.', 'Edit devices/dial/src/ui.c'),
    ])
    store.writeSession(session('web', 'Landing page', NOW - DAY), 0, [turn(0, 'make the hero scroll smoothly')])
    const hits = store.search('scrol', { now: NOW })
    expect(hits.map((hit) => hit.sessionId).sort()).toEqual(['dial', 'web'])
    // Each hit's snippet comes from its own turn — see the CAST in search().
    expect(hits.map((hit) => plain(hit.snippet)).sort()).toEqual([
      'make the hero [scroll] smoothly',
      'the dial [scroll] jumps two rows',
    ])
    expect(hits.find((hit) => hit.sessionId === 'dial')).toMatchObject({ turn: 1, field: 'ask', agentId: 'agent-dial', engine: 'claude' })
  })

  it('ranks a turn holding every word above a session that has them only in different turns', () => {
    const store = open()
    store.writeSession(session('together', 'A', NOW - 20 * DAY), 0, [turn(0, 'port the daemon to windows')])
    store.writeSession(session('spread', 'B', NOW), 0, [turn(0, 'port scan'), turn(1, 'resize the windows')])
    store.writeSession(session('half', 'C', NOW), 0, [turn(0, 'port only')])
    const hits = store.search('windows port', { now: NOW })
    expect(hits.map((hit) => [hit.sessionId, hit.together])).toEqual([['together', true], ['spread', false]])
  })

  it('keeps a session with every word even when common words fill the ranked window', () => {
    const store = open()
    const filler = Array.from({ length: 3_100 }, (_, index) => turn(index, 'alpha beta'))
    store.writeSession(session('filler', 'F', NOW), 0, filler)
    store.writeSession(session('spread', 'S', NOW), 0, [
      turn(0, `alpha ${'padding '.repeat(80)}`),
      turn(1, `beta ${'padding '.repeat(80)}`),
    ])
    const hits = store.search('alpha beta', { now: NOW })
    expect(hits.map((hit) => [hit.sessionId, hit.together])).toEqual([['filler', true], ['spread', false]])
    expect(plain(hits[1].snippet)).toMatch(/\[(alpha|beta)\]/)
  })

  it('ranks a word in nearly every turn by recency: the newest sessions that say it', () => {
    const store = open()
    store.commonMatches = 3
    for (let index = 0; index < 6; index++) {
      store.writeSession(session(`s${index}`, 'x', NOW - index * DAY), 0, [turn(0, `harness ${'word '.repeat(index * 5)}`, '', '', NOW - index * DAY)])
    }
    expect(store.search('harness', { now: NOW, limit: 3 }).map((hit) => hit.sessionId)).toEqual(['s0', 's1', 's2'])
    expect(store.search('harness', { now: NOW, from: NOW - 4.5 * DAY, to: NOW - 2.5 * DAY }).map((hit) => hit.sessionId)).toEqual(['s3', 's4'])
  })

  it('matches words split between the session name and what was said in it', () => {
    const store = open()
    store.writeSession(session('mobile', 'Mobile app build', NOW), 0, [turn(0, 'swipe right opens Find')])
    const [hit] = store.search('mobile swipe', { now: NOW })
    expect(hit).toMatchObject({ sessionId: 'mobile', together: false, field: 'ask' })
    expect(plain(hit.snippet)).toBe('[swipe] right opens Find')
    expect(store.search('mobile', { now: NOW })[0]).toMatchObject({ field: 'name', turn: -1 })
  })

  it('reports the field that matched: the ask first, then the name, the answer, the tools', () => {
    const store = open()
    store.writeSession(session('s', 'Session', NOW), 0, [turn(0, 'why', 'because of keystone hashing', 'Bash rg keystone')])
    expect(store.search('keystone', { now: NOW })[0].field).toBe('answer')
    store.writeSession(session('t', 'Tools', NOW), 0, [turn(0, 'look', '', 'Read cli/src/lib/e2ee/core.ts')])
    expect(store.search('core.ts', { now: NOW }).map((hit) => [hit.sessionId, hit.field])).toEqual([['t', 'tools']])
  })

  it('prefers the recent of two equally good matches, but not over a much better old one', () => {
    const store = open()
    store.writeSession(session('old', 'x', NOW - 60 * DAY), 0, [turn(0, 'cohort retention')])
    store.writeSession(session('new', 'y', NOW - DAY), 0, [turn(0, 'cohort retention')])
    expect(store.search('retention', { now: NOW }).map((hit) => hit.sessionId)).toEqual(['new', 'old'])
    // One passing mention in a long tool log, yesterday, does not outrank a session about it.
    store.writeSession(session('mention', 'z', NOW - DAY), 0, [turn(0, 'check the logs', '', `Bash ${'grep -n x file.txt '.repeat(60)} retention`)])
    expect(store.search('retention', { now: NOW }).map((hit) => hit.sessionId)).toEqual(['new', 'old', 'mention'])
  })

  it('ranks the session started for something above one that mentions it on the way', () => {
    const store = open()
    store.writeSession(session('started', 'Claude harness 9-25 7:25', NOW - 2 * DAY), 0, [
      turn(0, 'build a phone stand at 60 degrees with a cable slot'),
      turn(1, 'make the base heavier'),
      turn(2, 'export the STL'),
    ])
    store.writeSession(session('hub', 'Harness list', NOW - 2 * DAY), 0, [
      turn(0, 'what harnesses are running'),
      turn(1, 'tidy the list'),
      turn(2, 'the phone stand harness and the cup engraving harness'),
    ])
    expect(store.search('phone stand', { now: NOW }).map((hit) => hit.sessionId)).toEqual(['started', 'hub'])
  })

  it('narrows to sessions worked on in a window: any turn then, not only the matching one', () => {
    const store = open()
    const lastWeek = { from: NOW - 10 * DAY, to: NOW - 4 * DAY }
    store.writeSession(session('then', 'A', NOW - 5 * DAY), 0, [turn(0, 'fix the dial scroll', '', '', NOW - 6 * DAY)])
    store.writeSession(session('now', 'B', NOW - 1 * DAY), 0, [turn(0, 'dial firmware', '', '', NOW - 1 * DAY)])
    // Mentioned the dial three weeks ago, and worked on again last week: still the dial one then.
    store.writeSession(session('long', 'C', NOW - 5 * DAY), 0, [
      turn(0, 'the dial keeps rebooting', '', '', NOW - 21 * DAY),
      turn(1, 'ship it', '', '', NOW - 5 * DAY),
    ])
    // A database-backed session: no turn times, only when it was last worked on.
    store.writeSession(session('untimed', 'D', NOW - 7 * DAY), 0, [turn(0, 'dial menu')])
    expect(store.search('dial', { now: NOW, ...lastWeek }).map((hit) => hit.sessionId).sort()).toEqual(['long', 'then', 'untimed'])
    expect(store.search('dial', { now: NOW }).map((hit) => hit.sessionId)).toContain('now')
    expect(store.search('dial', { now: NOW, from: NOW - 2 * DAY, to: NOW })).toMatchObject([{ sessionId: 'now' }])
    expect(store.search('keyboard', { now: NOW, ...lastWeek })).toEqual([])
  })

  it('lists what was worked on in a window when there are no words, latest first', () => {
    const store = open()
    store.writeSession(session('a', 'A', NOW - 2 * DAY), 0, [
      turn(0, 'first thing', '', '', NOW - 3 * DAY),
      turn(1, 'what I asked last in the window', '', '', NOW - 2 * DAY),
    ])
    store.writeSession(session('b', 'B', NOW - 1 * DAY), 0, [turn(0, 'yesterday work', '', '', NOW - 1 * DAY)])
    store.writeSession(session('c', 'C', NOW - 9 * DAY), 0, [turn(0, 'long ago', '', '', NOW - 9 * DAY)])
    // A later turn opened by an agent's report does not hide what the person asked.
    store.writeSession(session('a', 'A', NOW - 2 * DAY), 2, [turn(2, '', 'Another session reported back', '', NOW - 2 * DAY + 60_000)])
    const hits = store.search('', { now: NOW, from: NOW - 4 * DAY, to: NOW })
    expect(hits.map((hit) => [hit.sessionId, hit.snippet, hit.field])).toEqual([
      ['b', 'yesterday work', 'ask'],
      ['a', 'what I asked last in the window', 'ask'],
    ])
    expect(store.search('', { now: NOW })).toEqual([])

    // A database-backed session (turns without times) worked on in the window is listed too, and
    // a session whose last turns share a time is listed once.
    store.writeSession(session('untimed', 'D', NOW - 2.5 * DAY), 0, [turn(0, 'from a database')])
    store.writeSession(session('twice', 'E', NOW - 3 * DAY), 0, [
      turn(0, 'first', '', '', NOW - 3 * DAY),
      turn(1, 'second, same minute', '', '', NOW - 3 * DAY),
    ])
    expect(store.search('', { now: NOW, from: NOW - 4 * DAY, to: NOW }).map((hit) => [hit.sessionId, hit.snippet])).toEqual([
      ['b', 'yesterday work'],
      ['a', 'what I asked last in the window'],
      ['untimed', 'from a database'],
      ['twice', 'second, same minute'],
    ])
  })

  it('tells a reader a file it cannot read from one written by another version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-search-'))
    dirs.push(dir)
    const path = join(dir, 'index.db')
    writeFileSync(path, 'this is not a database, it is a sentence long enough to be read as a header')
    expect(SessionSearchStore.openReader(path)).toBe('unreadable')
    expect(SessionSearchStore.openReader(join(dir, 'none.db'))).toBe('missing')
  })

  it('replaces turns from a point on, keeps earlier ones, and counts them', () => {
    const store = open()
    store.writeSession(session('s', 'S', NOW), 0, [turn(0, 'alpha'), turn(1, 'beta draft')])
    store.writeSession({ ...session('s', 'S renamed', NOW), resumeOffset: 100, resumeTurn: 1 }, 1, [turn(1, 'beta final'), turn(2, 'gamma')])
    expect(store.session('s')).toMatchObject({ header: 'S renamed', resumeOffset: 100, resumeTurn: 1, turns: 3 })
    expect(store.search('draft', { now: NOW })).toEqual([])
    expect(store.search('alpha', { now: NOW })).toHaveLength(1)
    expect(store.search('renamed', { now: NOW })).toHaveLength(1)
    expect(store.counts()).toEqual({ sessions: 1, turns: 3 })
    store.removeSession('s')
    expect(store.counts()).toEqual({ sessions: 0, turns: 0 })
    expect(store.search('alpha', { now: NOW })).toEqual([])
  })

  it('starts over from a file that is not a database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-search-'))
    dirs.push(dir)
    const path = join(dir, 'index.db')
    writeFileSync(path, 'this is not a database, it is a sentence long enough to be read as a header')
    const store = open(path)
    store.writeSession(session('s', 'S', NOW), 0, [turn(0, 'alpha')])
    expect(store.search('alpha', { now: NOW })).toHaveLength(1)
  })

  it.each(['0', '8', '9', '10'])('rebuilds an index written by schema %s', (version) => {
    const dir = mkdtempSync(join(tmpdir(), 'session-search-'))
    dirs.push(dir)
    const path = join(dir, 'index.db')
    const first = open(path)
    first.writeSession(session('s', 'S', NOW), 0, [turn(0, 'alpha')])
    ;(first as unknown as { db: { exec(sql: string): void } }).db.exec(`UPDATE meta SET value = '${version}' WHERE key = 'schema'`)
    first.close()
    stores.splice(stores.indexOf(first), 1)
    expect(SessionSearchStore.openReader(path)).toBe('outdated')
    const second = open(path)
    expect(second.counts()).toEqual({ sessions: 0, turns: 0 })
    second.writeSession(session('s', 'S', NOW), 0, [turn(0, 'rebuilt conversation')])
    expect(second.search('alpha', { now: NOW })).toEqual([])
    expect(second.search('rebuilt', { now: NOW })).toHaveLength(1)
  })
})

describe('SessionSearchStore.tail', () => {
  const answer = (index: number) => `answer ${index}\n${'x'.repeat(900)}`

  it('returns the last rows newest last, within the budget, and pages up from the first one', () => {
    const store = open()
    store.writeSession(session('s1', 'Dial firmware', NOW), 0, Array.from({ length: 40 }, (_, index) =>
      turn(index, index % 5 === 0 ? `ask ${index}` : '', answer(index), index % 2 ? `Bash make ${index}` : '', NOW - (40 - index) * 60_000)))
    const last = store.tail('s1', { maxChars: 5_000 })!
    expect(last.rows.map((row) => row.turn)).toEqual([35, 36, 37, 38, 39])
    // The latest ask comes with the last page, however far up it is.
    expect(last.lastAsk).toMatchObject({ turn: 35, ask: 'ask 35' })
    expect(store.tail('s1', { maxChars: 1_000 })!.lastAsk).toMatchObject({ turn: 35, ask: 'ask 35' })
    expect(last).toMatchObject({ hasMore: true, total: 40, lastAt: NOW })
    expect(last.rows[0]).toMatchObject({ turn: 35, ask: 'ask 35', answer: answer(35), tools: 'Bash make 35', at: NOW - 5 * 60_000 })

    const older = store.tail('s1', { beforeTurn: 35, maxChars: 5_000 })!
    expect(older.rows.map((row) => row.turn)).toEqual([30, 31, 32, 33, 34])
    expect(older.lastAsk).toBeUndefined()
    const first = store.tail('s1', { beforeTurn: 3, maxChars: 5_000 })!
    expect(first.rows.map((row) => row.turn)).toEqual([0, 1, 2])
    expect(first.hasMore).toBe(false)
    // More than 16 rows at once: the reader pages its batches.
    expect(store.tail('s1', { maxChars: 64_000 })!.rows).toHaveLength(40)
  })

  it('always returns the newest row, however long, and never the header row', () => {
    const store = open()
    store.writeSession(session('s1', 'Dial firmware', NOW), 0, [turn(0, 'first', 'short'), turn(1, 'second', 'y'.repeat(20_000))])
    const tail = store.tail('s1', { maxChars: 1_000 })!
    expect(tail.rows.map((row) => row.turn)).toEqual([1])
    expect(tail.hasMore).toBe(true)
    expect(JSON.stringify(tail)).not.toContain('Dial firmware')
  })

  it('knows a session with nothing to read, and not one it never indexed', () => {
    const store = open()
    store.writeSession(session('t1', 'Terminal', NOW), 0, [])
    expect(store.tail('t1')).toEqual({ sessionId: 't1', rows: [], hasMore: false, total: 0, lastAt: NOW })
    expect(store.tail('nope')).toBeNull()
  })
})
