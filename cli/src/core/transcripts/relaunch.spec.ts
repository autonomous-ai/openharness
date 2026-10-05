import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRelaunchMarks, transcriptSize } from './relaunch.js'

describe('relaunch marks', () => {
  it('gives the attach the byte the relaunched engine began at, once', () => {
    const marks = createRelaunchMarks()
    marks.note('conversation', 1457)
    expect(marks.size).toBe(1)
    expect(marks.take('conversation')).toEqual({ offset: 1457, engineStarted: false })
    expect(marks.take('conversation')).toBeUndefined()
    expect(marks.size).toBe(0)
  })

  it('has nothing for a conversation that was not relaunched', () => {
    expect(createRelaunchMarks().take('never')).toBeUndefined()
  })

  it('keeps the latest relaunch of a conversation', () => {
    const marks = createRelaunchMarks()
    marks.note('conversation', 10)
    marks.note('conversation', 20)
    expect(marks.take('conversation')).toEqual({ offset: 20, engineStarted: false })
  })

  it('says whether a new engine was started on the conversation: by a resume, or by a restore that rebuilt its pane', () => {
    const marks = createRelaunchMarks()
    marks.note('resumed', 3, true)
    marks.note('restored', 5)
    marks.engineStarted('restored')
    marks.note('survived', 8)
    // Nothing to mark for a conversation the daemon's start did not note.
    marks.engineStarted('never')
    expect(marks.take('resumed')).toEqual({ offset: 3, engineStarted: true })
    expect(marks.take('restored')).toEqual({ offset: 5, engineStarted: true })
    expect(marks.take('survived')).toEqual({ offset: 8, engineStarted: false })
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

  it('drops a mark older than a resume can wait for', () => {
    let clock = 0
    const marks = createRelaunchMarks({ now: () => clock, maxAgeMs: 1_000 })
    marks.note('stale', 5)
    marks.note('fresh', 7)
    clock = 1_000
    expect(marks.take('fresh')).toEqual({ offset: 7, engineStarted: false })
    clock = 1_001
    expect(marks.take('stale')).toBeUndefined()
    expect(marks.size).toBe(0)
  })
})
