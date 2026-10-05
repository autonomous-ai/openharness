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
    expect(marks.take('conversation')).toBe(1457)
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
    expect(marks.take('conversation')).toBe(20)
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
    expect(marks.take('fresh')).toBe(7)
    clock = 1_001
    expect(marks.take('stale')).toBeUndefined()
    expect(marks.size).toBe(0)
  })
})
