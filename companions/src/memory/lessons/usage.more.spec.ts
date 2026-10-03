/**
 * Usage, at its edges: what counts as a read of a lesson (and what never does), a usage.json of the wrong
 * shape, a store that is not there yet, and a save that fails. The store is a stub; the files are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LessonRecord, LessonStore } from './store.js'
import { projectHash } from './types.js'
import { LessonUsage, USAGE_GAP_MS, lessonReads } from './usage.js'

const DAY = 24 * 60 * 60_000
const T0 = Date.UTC(2026, 0, 10)
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'learn-usage-more-')) })
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })

const record = (id: string, kind: 'skill' | 'note', name: string, project: string | null = null, approved: string | null = '2026-01-10'): LessonRecord => ({
  id, kind, name, description: name, body: '', hash: id, signal: { kind: 'repeat-steps', key: id }, project, projectName: null,
  learnedBy: 'tim', from: [], evidence: [], source: 'template', created: T0 - 5 * DAY, status: 'approved', approved,
})
function stub(records: LessonRecord[], exists = true) {
  return { root: dir, exists, approved: () => records } as unknown as Pick<LessonStore, 'root' | 'approved' | 'exists'>
}

describe('lessonReads', () => {
  it('Claude\'s Skill tool by skill, name or command; functions.skill too; only a lesson-shaped name', () => {
    expect(lessonReads('Skill', { skill: 'deploy-check' })).toEqual(['deploy-check'])
    expect(lessonReads('skill', { name: ' deploy-check ' })).toEqual(['deploy-check'])
    expect(lessonReads('functions.Skill', { command: 'deploy-check' })).toEqual(['deploy-check'])
    for (const bad of [{ skill: '../x' }, { skill: 'Deploy' }, { name: 42 }, { command: 'rm -rf /' }, {}]) expect(lessonReads('Skill', bad)).toEqual([])
    // Another tool naming a skill is not a read of it.
    expect(lessonReads('Bash', { skill: 'deploy-check' })).toEqual([])
  })

  it('a SKILL.md path in any string, JSON-escaped slashes too; nothing from input that cannot be read', () => {
    expect(lessonReads('exec', 'cat ~/.claude/skills/a-b/SKILL.md && sed -n 1p "/r/lessons/c/SKILL.md"')).toEqual(['a-b', 'c'])
    // An engine that hands its arguments over as a JSON string, slashes escaped.
    expect(lessonReads('Read', '{"file_path":"\\/p\\/.agents\\/skills\\/x1\\/SKILL.md"}')).toEqual(['x1'])
    expect(lessonReads('Read', { file_path: '/p/lessons/UPPER/SKILL.md' })).toEqual([])
    expect(lessonReads('Read', { file_path: '/p/mylessons/x/SKILL.md' })).toEqual([])
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(lessonReads('Read', circular)).toEqual([])
    expect(lessonReads('Read', undefined)).toEqual([])
    expect(lessonReads('Read', 10n as unknown)).toEqual([])
    // Only the first 8,000 characters are read.
    expect(lessonReads('Read', `${' '.repeat(8_000)} /p/lessons/late/SKILL.md`)).toEqual([])
  })
})

describe('LessonUsage', () => {
  it('ingests only turn starts and tool starts; odd payloads are passed over', () => {
    const skill = record('s1', 'skill', 'deploy-check')
    let now = T0
    const u = new LessonUsage({ store: stub([skill]), now: () => now })
    now += DAY
    u.ingest({ cwd: null }, [
      { type: 'tool_start', payload: null as unknown as Record<string, unknown> },
      { type: 'tool_start', payload: { tool: 7, input: '/p/lessons/deploy-check/SKILL.md' } },
      { type: 'tool_result', payload: { tool: 'Read', input: '/p/lessons/deploy-check/SKILL.md' } },
      { type: 'turn_started', payload: 'text' as unknown as Record<string, unknown> },
    ])
    expect(u.entry('s1')).toBeNull()
    u.ingest({ cwd: null }, [{ type: 'tool_start', payload: { tool: 'Read', input: { file_path: '/p/lessons/deploy-check/SKILL.md' } } }])
    expect(u.entry('s1')).toMatchObject({ lastUsed: now, uses: 1, stale: null })
  })

  it('a turn in a note\'s project is its use; a note with no project never is', () => {
    const note = record('n1', 'note', 'note-n1', projectHash('/work/api'))
    const orphan = record('n2', 'note', 'note-n2', null)
    const u = new LessonUsage({ store: stub([note, orphan]), now: () => T0 })
    u.ingest({ cwd: '/work/api' }, [{ type: 'turn_started', payload: {} }])
    u.ingest({ cwd: null }, [{ type: 'turn_started', payload: {} }])
    expect(u.entry('n1')?.uses).toBe(1)
    expect(u.entry('n2')).toBeNull()
  })

  it('a usage.json of another version or shape starts fresh; wrong fields are dropped', () => {
    const skill = record('s1', 'skill', 'deploy-check')
    for (const text of ['{', JSON.stringify({ v: 2, since: 1 }), JSON.stringify({ v: 1, since: 'x' }), 'null']) {
      writeFileSync(join(dir, 'usage.json'), text)
      const u = new LessonUsage({ store: stub([skill]), now: () => T0 })
      expect(u.entry('s1')).toBeNull()
      expect(u.unusedMs(skill)).toBe(0)
    }
    writeFileSync(join(dir, 'usage.json'), JSON.stringify({ v: 1, since: T0 - 60 * DAY, lastActivity: 'x', gaps: [{ from: 1 }, null, { from: T0 - 50 * DAY, to: T0 - 40 * DAY }], lessons: 'x' }))
    const u = new LessonUsage({ store: stub([skill]), now: () => T0 + 20 * DAY })
    expect(u.entry('s1')).toBeNull()
    // Approved on T0, 20 days ago; the old gap is before it and does not count.
    expect(u.unusedMs(skill)).toBe(20 * DAY)
    writeFileSync(join(dir, 'usage.json'), JSON.stringify({ v: 1, since: T0, lastActivity: T0, gaps: 'x', lessons: { s1: { lastUsed: T0, uses: 3 } } }))
    expect(new LessonUsage({ store: stub([skill]), now: () => T0 }).entry('s1')).toEqual({ lastUsed: T0, uses: 3 })
  })

  it('a lesson with no approval date counts from when it was made', () => {
    const skill = record('s1', 'skill', 'deploy-check', null, null)
    const bad = record('s2', 'skill', 'other', null, 'yesterday')
    writeFileSync(join(dir, 'usage.json'), JSON.stringify({ v: 1, since: T0 - 30 * DAY, lastActivity: null, gaps: [], lessons: {} }))
    const u = new LessonUsage({ store: stub([skill, bad]), now: () => T0 + DAY })
    expect(u.unusedMs(skill)).toBe(6 * DAY)
    expect(u.unusedMs(bad)).toBe(6 * DAY)
    expect(u.unusedDays(skill)).toBe(6)
  })

  it('the current absence counts too, and a gap of a week or more is remembered once activity comes back', () => {
    const skill = record('s1', 'skill', 'deploy-check')
    let now = T0
    const u = new LessonUsage({ store: stub([skill]), now: () => now })
    u.activity()
    now += 20 * DAY
    // Twenty days since the last turn: all of it is an absence.
    expect(u.unusedMs(skill)).toBe(0)
    u.activity()
    expect(u.unusedMs(skill)).toBe(0)
    now += 2 * DAY
    expect(u.unusedMs(skill)).toBe(2 * DAY)
    expect(USAGE_GAP_MS).toBe(7 * DAY)
  })

  it('never writes before the lessons folder exists, and a save that fails only warns', () => {
    const skill = record('s1', 'skill', 'deploy-check')
    const missing = new LessonUsage({ store: stub([skill], false), now: () => T0 })
    missing.used('s1')
    missing.markStale('s1')
    missing.restored('s1')
    expect(() => readFileSync(join(dir, 'usage.json'))).toThrow()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mkdirSync(join(dir, 'usage.json.tmp'))
    const u = new LessonUsage({ store: stub([skill]), now: () => T0 })
    u.used('s1')
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[learn\] could not save usage: /))
    expect(u.entry('s1')?.uses).toBe(1)
    rmSync(join(dir, 'usage.json.tmp'), { recursive: true })
    u.markStale('s1')
    expect(statSync(join(dir, 'usage.json')).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8')).lessons.s1).toMatchObject({ uses: 1, stale: T0 })
    u.restored('s1')
    expect(u.entry('s1')).toMatchObject({ restored: T0, stale: null })
  })

  it('a stale mark or restore of a lesson never used starts its entry', () => {
    const u = new LessonUsage({ store: stub([]), now: () => T0 })
    u.markStale('x1')
    expect(u.entry('x1')).toEqual({ lastUsed: null, uses: 0, stale: T0 })
    u.restored('x2')
    expect(u.entry('x2')).toEqual({ lastUsed: null, uses: 0, restored: T0, stale: null })
  })
})
