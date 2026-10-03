/**
 * pair/journal.ts — the ring a brain that was not watching reads afterwards. What must hold: 0600 on disk,
 * one epoch per file and a seq that never goes backwards within it, a torn or foreign line never becomes an
 * entry, the ring stays bounded on disk, a reader's cursor is told `reset` / `truncated` truthfully, a page
 * is bounded, and a disk that fails never takes the daemon down with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JOURNAL_PAGE_MAX, PairJournal, type JournalInput } from './journal.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pair-journal-')) })
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })

const entry = (at: number, extra: Partial<JournalInput> = {}): JournalInput =>
  ({ at, kind: 'done', agentId: 'a1', name: 'api', engine: 'claude', ...extra })
const lines = (path: string): string[] => readFileSync(path, 'utf8').split('\n').filter(Boolean)

describe('PairJournal on disk', () => {
  it('starts a new epoch, and writes each entry as one 0600 line', () => {
    const j = new PairJournal({ dir, newEpoch: () => 'e1' })
    expect([j.epoch, j.seq]).toEqual(['e1', 0])
    const first = j.append(entry(10))
    const second = j.append(entry(20, { kind: 'question', requestId: 'r1', text: 'Run tests?' }))
    expect([first.seq, second.seq]).toEqual([1, 2])
    expect(first.epoch).toBe('e1')
    expect(statSync(j.path).mode & 0o777).toBe(0o600)
    expect(lines(j.path).map((l) => JSON.parse(l).seq)).toEqual([1, 2])
  })

  it('defaults to a random 12-hex epoch', () => {
    const a = new PairJournal({ dir: join(dir, 'a') })
    const b = new PairJournal({ dir: join(dir, 'b') })
    expect(a.epoch).toMatch(/^[0-9a-f]{12}$/)
    expect(a.epoch).not.toBe(b.epoch)
  })

  it('reopens where it left off: same epoch, seq carries on', () => {
    const j = new PairJournal({ dir, newEpoch: () => 'e1' })
    j.append(entry(1)); j.append(entry(2)); j.append(entry(3))
    const again = new PairJournal({ dir, newEpoch: () => 'never' })
    expect([again.epoch, again.seq]).toEqual(['e1', 3])
    expect(again.append(entry(4)).seq).toBe(4)
    expect(again.since().entries.map((e) => e.seq)).toEqual([1, 2, 3, 4])
  })

  it('skips a torn line, a line that is not an entry, and lines of an earlier epoch', () => {
    const path = join(dir, 'journal.jsonl')
    const good = (epoch: string, seq: number) => JSON.stringify({ epoch, seq, at: seq, kind: 'done', agentId: 'a', name: 'n', engine: 'claude' })
    writeFileSync(path, [
      good('old', 7),                                     // an earlier epoch stitched in: not this journal's
      good('cur', 1),
      '{"epoch":"cur","seq":2,"at":2,"kind":"done"',      // torn by a crash
      JSON.stringify({ epoch: 'cur', seq: 1.5, at: 3, kind: 'done', agentId: 'a' }),   // seq not an integer
      JSON.stringify({ epoch: 'cur', seq: 3, at: '4', kind: 'done', agentId: 'a' }),   // at not a number
      JSON.stringify({ epoch: 'cur', seq: 3, at: 4, kind: 'done', agentId: 7 }),       // agentId not a string
      'null',
      '',
      good('cur', 2),
    ].join('\n'))
    const j = new PairJournal({ dir })
    expect(j.epoch).toBe('cur')
    expect(j.seq).toBe(2)
    expect(j.since().entries.map((e) => [e.epoch, e.seq])).toEqual([['cur', 1], ['cur', 2]])
  })

  it('starts over — a new epoch and an emptied file — when nothing in the file is readable', () => {
    const path = join(dir, 'journal.jsonl')
    writeFileSync(path, 'garbage\nmore garbage\n')
    const j = new PairJournal({ dir, newEpoch: () => 'fresh' })
    expect([j.epoch, j.seq]).toEqual(['fresh', 0])
    expect(readFileSync(path, 'utf8')).toBe('')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    j.append(entry(1))
    expect(lines(path)).toHaveLength(1)
  })

  it('is a ring: past max × 1.25 it keeps the newest max, on disk too, with seq still monotonic', () => {
    const j = new PairJournal({ dir, max: 10, newEpoch: () => 'e' })
    for (let i = 1; i <= 13; i++) j.append(entry(i))
    expect(lines(j.path).map((l) => JSON.parse(l).seq)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    expect(statSync(j.path).mode & 0o777).toBe(0o600)
    expect(j.append(entry(14)).seq).toBe(14)
    // A reopened ring keeps only its newest max.
    const reopened = new PairJournal({ dir, max: 10 })
    expect(reopened.since().entries.map((e) => e.seq)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
  })

  it('never keeps a ring smaller than 10', () => {
    const j = new PairJournal({ dir, max: 1, newEpoch: () => 'e' })
    for (let i = 1; i <= 12; i++) j.append(entry(i))
    expect(j.since().entries).toHaveLength(12)
  })

  it('keeps working in memory when the disk refuses, and says so', () => {
    // The journal's path is taken by a directory: every read, rewrite and append fails.
    mkdirSync(join(dir, 'journal.jsonl'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const j = new PairJournal({ dir, newEpoch: () => 'e' })
    // Inert until used (the daemons off switch): making one touches nothing.
    expect(warn).not.toHaveBeenCalled()
    const appended = j.append(entry(1, { kind: 'fail', text: 'boom' }))
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[pair\] journal rewrite failed: /))
    expect(appended.seq).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[pair\] journal append failed: /))
    expect(j.since().entries).toEqual([appended])
  })
})

describe('PairJournal.since — a reader\'s cursor', () => {
  function filled(n: number, max = 10): PairJournal {
    const j = new PairJournal({ dir, max, newEpoch: () => 'ep' })
    for (let i = 1; i <= n; i++) j.append(entry(i * 100))
    return j
  }

  it('with no cursor reads the ring from its start, and always reports where the ring is', () => {
    const page = filled(3).since()
    expect(page).toMatchObject({ epoch: 'ep', seq: 3 })
    expect(page.entries.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(page.reset).toBeUndefined()
    expect(page.truncated).toBeUndefined()
  })

  it('reads on from (epoch, seq)', () => {
    const j = filled(5)
    expect(j.since({ epoch: 'ep', seq: 3 }).entries.map((e) => e.seq)).toEqual([4, 5])
    expect(j.since({ epoch: 'ep', seq: 5 }).entries).toEqual([])
  })

  it('tells a cursor from another epoch to start again', () => {
    const page = filled(3).since({ epoch: 'gone', seq: 2 })
    expect(page.reset).toBe(true)
    expect(page.entries.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('says truncated when the ring dropped entries the cursor had not read', () => {
    const j = filled(13)   // ring now holds 4..13
    expect(j.since({ epoch: 'ep', seq: 1 })).toMatchObject({ truncated: true })
    expect(j.since({ epoch: 'ep', seq: 1 }).entries[0].seq).toBe(4)
    expect(j.since({ epoch: 'ep', seq: 3 }).truncated).toBeUndefined()   // 4 is next: nothing missed
  })

  it('is not truncated for a caught-up cursor on an empty ring', () => {
    const j = new PairJournal({ dir, newEpoch: () => 'ep' })
    expect(j.since({ epoch: 'ep', seq: 0 })).toEqual({ epoch: 'ep', seq: 0, entries: [] })
  })

  it('reads from a time (the brief asks "since you left")', () => {
    expect(filled(5).since({ at: 300 }).entries.map((e) => e.at)).toEqual([300, 400, 500])
  })

  it('bounds a page to [1, JOURNAL_PAGE_MAX]', () => {
    const j = filled(250, 1_000)
    expect(j.since().entries).toHaveLength(JOURNAL_PAGE_MAX)
    expect(j.since({ limit: 10_000 }).entries).toHaveLength(JOURNAL_PAGE_MAX)
    expect(j.since({ limit: 0 }).entries).toHaveLength(1)
    expect(j.since({ limit: -5 }).entries).toHaveLength(1)
    expect(j.since({ epoch: 'ep', seq: 245, limit: 3 }).entries.map((e) => e.seq)).toEqual([246, 247, 248])
  })
})

describe('PairJournal.openQuestions', () => {
  it('is every question journaled and never answered, by requestId', () => {
    const j = new PairJournal({ dir, newEpoch: () => 'e' })
    j.append(entry(1, { kind: 'question', requestId: 'r1', text: 'one?' }))
    j.append(entry(2, { kind: 'question', requestId: 'r2', text: 'two?' }))
    j.append(entry(3, { kind: 'answered', requestId: 'r1' }))
    j.append(entry(4, { kind: 'question', text: 'no id' }))          // nothing to pair it by: never open
    j.append(entry(5, { kind: 'act', requestId: 'r2' }))              // an act is not an answer
    const open = j.openQuestions()
    expect([...open.keys()]).toEqual(['r2'])
    expect(open.get('r2')?.text).toBe('two?')
  })
})
