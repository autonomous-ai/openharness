import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRelaunchMarks, transcriptSize } from './relaunch.js'

describe('relaunch marks', () => {
  afterEach(() => vi.restoreAllMocks())
  it('keeps the byte the relaunched engine began at until its attach commits', () => {
    const marks = createRelaunchMarks()
    marks.note('conversation', 1457)
    expect(marks.size).toBe(1)
    expect(marks.read('conversation')).toEqual({ offset: 1457, engineStarted: false })
    const mark = marks.read('conversation')!
    expect(mark).toEqual({ offset: 1457, engineStarted: false })
    marks.complete('conversation', mark)
    expect(marks.read('conversation')).toBeUndefined()
    expect(marks.size).toBe(0)
  })

  it('has nothing for a conversation that was not relaunched', () => {
    expect(createRelaunchMarks().read('never')).toBeUndefined()
  })

  it('keeps the latest relaunch of a conversation', () => {
    const marks = createRelaunchMarks()
    marks.note('conversation', 10)
    marks.note('conversation', 20)
    expect(marks.read('conversation')).toEqual({ offset: 20, engineStarted: false })
  })

  it('says whether a new engine was started on the conversation: by a resume, or by a restore that rebuilt its pane', () => {
    const marks = createRelaunchMarks()
    marks.note('resumed', 3, true)
    marks.note('restored', 5)
    marks.engineStarted('restored')
    marks.note('survived', 8)
    // Nothing to mark for a conversation the daemon's start did not note.
    marks.engineStarted('never')
    expect(marks.read('resumed')).toEqual({ offset: 3, engineStarted: true })
    expect(marks.read('restored')).toEqual({ offset: 5, engineStarted: true })
    expect(marks.read('survived')).toEqual({ offset: 8, engineStarted: false })
    expect(marks.size).toBe(3)
  })

  it('never lets an older attach consume a newer resume, and forgets stopped conversations', () => {
    const marks = createRelaunchMarks()
    marks.note('conversation', 10, true)
    const before = marks.read('conversation')!
    marks.note('conversation', 20, true)
    marks.complete('conversation', before)
    expect(marks.read('conversation')).toEqual({ offset: 20, engineStarted: true })
    marks.forget('conversation')
    marks.complete('conversation', before)
    expect(marks.read('conversation')).toBeUndefined()
    expect(marks.size).toBe(0)
  })

  it('reads a transcript\'s size, or nothing when there is no file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relaunch-'))
    try {
      writeFileSync(join(dir, 'session.jsonl'), '{"a":1}\n')
      expect(transcriptSize(join(dir, 'session.jsonl'))).toBe(8)
      expect(transcriptSize(join(dir, 'missing.jsonl'))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps a boundary when its first attach waits beyond the resume deadline', () => {
    let clock = 0
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const marks = createRelaunchMarks()
    marks.note('queued', 5, true)
    marks.note('restoring', 7)
    clock = 60 * 60_000
    marks.engineStarted('restoring')
    expect(marks.read('queued')).toEqual({ offset: 5, engineStarted: true })
    expect(marks.read('restoring')).toEqual({ offset: 7, engineStarted: true })
    expect(marks.size).toBe(2)
  })
})
