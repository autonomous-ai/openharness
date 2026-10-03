/**
 * The curator when the store says no: a failed archive or stale mark is counted as failed, never as done,
 * the pass still finishes (and is not run again that day), and the log line says what happened. A stub
 * store records what was asked of it; usage is the real tracker.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ARCHIVE_AFTER_MS, CURATE_EVERY_MS, LessonCurator, STALE_AFTER_MS } from './curate.js'
import type { LessonRecord, LessonStore } from './store.js'
import { LessonUsage } from './usage.js'

const T0 = Date.UTC(2026, 0, 1)
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'learn-curate-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const record = (id: string, kind: 'skill' | 'note', name = `${kind}-${id}`): LessonRecord => ({
  id, kind, name, description: name, body: '', hash: id, signal: { kind: 'repeat-steps', key: id }, project: 'p', projectName: 'api',
  learnedBy: 'tim', from: [], evidence: [], source: 'template', created: T0, status: 'approved', approved: '2026-01-01',
})

function setup(records: LessonRecord[], answers: { archive?: boolean; stale?: boolean } = {}) {
  let curatedAt: number | null = null
  const calls: string[] = []
  const store = {
    root: dir, exists: true,
    approved: () => records,
    archive: (id: string, why: string) => { calls.push(`archive ${id} (${why})`); return answers.archive === false ? { ok: false as const, error: 'COMMIT_FAILED' } : { ok: true as const, record: records.find((r) => r.id === id)!, commit: null } },
    markStale: (id: string, why: string) => { calls.push(`stale ${id} (${why})`); return answers.stale === false ? { ok: false as const, error: 'COMMIT_FAILED' } : { ok: true as const, record: records.find((r) => r.id === id)!, commit: null } },
    curatedAt: () => curatedAt,
    markCurated: (at: number) => { curatedAt = at },
  } as unknown as LessonStore
  let now = T0
  const usage = new LessonUsage({ store, now: () => now })
  const logs: string[] = []
  const archived: string[] = []
  const curator = new LessonCurator({ store, usage, now: () => now, log: (l) => logs.push(l), archived: (r) => archived.push(r.id) })
  return { curator, usage, calls, logs, archived, setNow: (t: number) => { now = t }, curatedAt: () => curatedAt }
}

describe('LessonCurator', () => {
  it('a failed archive and a failed stale mark are failures: nothing marked, nothing withdrawn, the day still counted', () => {
    const skill = record('a1', 'skill')
    const note = record('b2', 'note')
    const t = setup([skill, note], { archive: false, stale: false })
    t.setNow(T0 + ARCHIVE_AFTER_MS + 1)
    expect(t.curator.maybeRun()).toEqual({ stale: [], archived: [], failed: ['a1', 'b2'] })
    expect(t.calls).toEqual(['archive a1 (unused for 90 days)', 'stale b2 (unused for 30 days)'])
    expect(t.archived).toEqual([])
    expect(t.usage.entry('b2')).toBeNull()
    expect(t.logs).toEqual(['[learn] curator · stale - · archived - · failed a1, b2'])
    expect(t.curatedAt()).toBe(T0 + ARCHIVE_AFTER_MS + 1)
    expect(t.curator.maybeRun()).toBeNull()
    t.setNow(T0 + ARCHIVE_AFTER_MS + 1 + CURATE_EVERY_MS)
    expect(t.curator.due()).toBe(true)
  })

  it('a note past 90 days is only stale; a lesson already stale is not marked again; a quiet pass logs nothing', () => {
    const note = record('b2', 'note')
    const skill = record('c3', 'skill')
    const t = setup([note, skill])
    t.setNow(T0 + STALE_AFTER_MS)
    expect(t.curator.run()).toEqual({ stale: ['note-b2', 'skill-c3'], archived: [], failed: [] })
    expect(t.logs).toEqual(['[learn] curator · stale note-b2, skill-c3 · archived -'])
    t.setNow(T0 + ARCHIVE_AFTER_MS)
    expect(t.curator.run()).toEqual({ stale: [], archived: ['skill-c3'], failed: [] })
    expect(t.archived).toEqual(['c3'])
    expect(t.calls).toEqual(['stale b2 (unused for 30 days)', 'stale c3 (unused for 30 days)', 'archive c3 (unused for 90 days)'])
    t.logs.length = 0
    expect(t.curator.run()).toEqual({ stale: [], archived: ['skill-c3'], failed: [] })
    const quiet = setup([])
    expect(quiet.curator.run()).toEqual({ stale: [], archived: [], failed: [] })
    expect(quiet.logs).toEqual([])
  })

  it('never runs before the lessons folder exists', () => {
    const t = setup([record('a1', 'skill')])
    const empty = new LessonCurator({ store: { exists: false, curatedAt: () => null } as unknown as LessonStore, usage: t.usage, now: () => T0 + ARCHIVE_AFTER_MS })
    expect(empty.maybeRun()).toBeNull()
  })
})
