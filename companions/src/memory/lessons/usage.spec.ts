/**
 * L2 CHECK (daemons/LEARNING.md): a session reading a lesson is its use; the daily curator marks a lesson
 * unused for 30 days stale (an empty commit) and archives a skill unused for 90 (one commit), not counting
 * a week or more with nothing running at all. A real lessons folder with real git in a temp dir, a fake clock.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ARCHIVE_AFTER_MS, CURATE_EVERY_MS, LessonCurator, STALE_AFTER_MS } from './curate.js'
import { LessonStore, type LessonRecord } from './store.js'
import { projectHash, type Lesson, type Signal } from './types.js'
import { LessonUsage, USAGE_GAP_MS, lessonReads } from './usage.js'

const DAY = 24 * 60 * 60_000
let dir: string
let clock: number
let store: LessonStore
let usage: LessonUsage
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'learn-usage-'))
  clock = Date.UTC(2026, 9, 3, 15, 0)
  let n = 0
  store = new LessonStore({ root: join(dir, 'lessons'), now: () => clock, newId: () => `c0${(++n).toString(16).padStart(4, '0')}`, env: { PATH: process.env.PATH } })
  usage = new LessonUsage({ store, now: () => clock })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const ws = '/work/api'
const signal = (key: string, project: string | null = projectHash(ws)): Signal => ({
  kind: 'repeat-steps', key, project, projectName: 'api', at: clock,
  from: [{ engine: 'codex', machine: 'm', agentId: 'a', session: 's', turn: 1, project, at: clock }], evidence: [],
})
function approve(lesson: Lesson, key: string, project: string | null = projectHash(ws)): LessonRecord {
  const added = store.add({ lesson, signal: signal(key, project), learnedBy: 'tim', source: 'model' })
  if (!added.ok) throw new Error(added.error)
  const approved = store.approve(added.record.id, 'key')
  if (!approved.ok) throw new Error(approved.error)
  return approved.record
}
const skill = (name: string): Lesson => ({ kind: 'skill', name, description: `${name}.`, body: `Do ${name}.` })
const git = (...args: string[]) => execFileSync('git', args, { cwd: store.root, encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
const read = (path: string) => ({ type: 'tool_start', payload: { id: 't', tool: 'Read', input: { file_path: path } } })
const shell = (command: string) => ({ type: 'tool_start', payload: { id: 't', tool: 'exec_command', input: { cmd: command } } })

describe('what counts as a use', () => {
  it('a read of a lesson\'s SKILL.md by any engine, or Claude\'s Skill tool naming it', () => {
    expect(lessonReads('Read', { file_path: '/p/.harness/runtime/k/lessons/run-migrations/SKILL.md' })).toEqual(['run-migrations'])
    expect(lessonReads('exec_command', { cmd: 'sed -n 1,80p "/p/.harness/runtime/k/lessons/deploy-api/SKILL.md"' })).toEqual(['deploy-api'])
    expect(lessonReads('Bash', { command: 'cat ~/.claude/skills/deploy-api/SKILL.md ~/.agents/skills/lint-first/SKILL.md' })).toEqual(['deploy-api', 'lint-first'])
    expect(lessonReads('Skill', { skill: 'deploy-api' })).toEqual(['deploy-api'])
    expect(lessonReads('Read', { file_path: '/p/src/lessons.ts' })).toEqual([])
    expect(lessonReads('Read', { file_path: '/p/lessons/Not A Name/SKILL.md' })).toEqual([])
    expect(lessonReads('Read', '/p/lessons/x/SKILL.md')).toEqual(['x'])
  })

  it('records a read of an approved skill, a turn in a note\'s project, and nothing from a replay', () => {
    const migrations = approve(skill('run-migrations'), 'k1')
    const note = approve({ kind: 'note', lines: ['Tag releases from main.'] }, 'k2')
    const other = approve(skill('unrelated'), 'k3')
    usage.ingest({ cwd: '/work/web' }, [read('/p/.harness/runtime/k/lessons/run-migrations/SKILL.md')], { replay: true })
    expect(usage.entry(migrations.id)).toBeNull()
    clock += 1_000
    usage.ingest({ cwd: '/work/web' }, [read('/p/.harness/runtime/k/lessons/run-migrations/SKILL.md'), shell('cat lessons/not-approved/SKILL.md')])
    expect(usage.entry(migrations.id)).toMatchObject({ lastUsed: clock, uses: 1 })
    expect(usage.entry(note.id)).toBeNull()
    usage.ingest({ cwd: ws }, [{ type: 'turn_started', payload: {} }])
    expect(usage.entry(note.id)).toMatchObject({ lastUsed: clock, uses: 1 })
    expect(usage.entry(other.id)).toBeNull()
    const file = join(store.root, 'usage.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8')).lessons[migrations.id].uses).toBe(1)
    // Not committed.
    expect(git('status', '--porcelain')).toBe('')
  })

  it('never makes the lessons folder just to record activity', () => {
    usage.ingest({ cwd: ws }, [{ type: 'turn_started', payload: {} }])
    expect(existsSync(store.root)).toBe(false)
  })
})

describe('the curator', () => {
  const curator = (busy = false) => new LessonCurator({ store, usage, now: () => clock, busy: () => busy })
  const working = () => usage.ingest({ cwd: '/work/web' }, [{ type: 'turn_started', payload: {} }])
  /** Days pass with a turn on this machine every day. */
  const days = (n: number): void => { for (let i = 0; i < n; i++) { clock += DAY; working() } }

  it('marks a lesson unused for 30 days stale (an empty commit), and a use clears the mark', () => {
    const lesson = approve(skill('run-migrations'), 'k1')
    days(29)
    expect(curator().maybeRun()).toEqual({ stale: [], archived: [], failed: [] })
    clock += CURATE_EVERY_MS / 2
    working()
    expect(curator().maybeRun()).toBeNull()                                  // once a day
    clock += CURATE_EVERY_MS / 2
    working()
    expect(curator().maybeRun()).toMatchObject({ stale: ['run-migrations'] })
    expect(git('log', '-1', '--format=%s')).toBe('stale: run-migrations\n')
    expect(usage.entry(lesson.id)?.stale).toBe(clock)
    expect(store.approved().map((r) => r.id)).toEqual([lesson.id])        // still loaded
    usage.ingest({ cwd: '/w' }, [read('/p/lessons/run-migrations/SKILL.md')])
    expect(usage.entry(lesson.id)?.stale).toBeNull()
    expect(usage.unusedMs(lesson)).toBe(0)
  })

  it('archives a skill unused for 90 days (one commit), never a note, and waits while something works', () => {
    const skillLesson = approve(skill('run-migrations'), 'k1')
    const note = approve({ kind: 'note', lines: ['Tag releases from main.'] }, 'k2', projectHash('/work/elsewhere'))
    days(91)
    expect(curator(true).maybeRun()).toBeNull()
    const pass = curator().maybeRun()
    expect(pass).toMatchObject({ archived: ['run-migrations'], stale: ['note-c00002'] })
    expect(store.get(skillLesson.id)?.status).toBe('archived')
    expect(store.get(note.id)?.status).toBe('approved')
    expect(git('log', '--format=%s').split('\n')).toContain('archive: run-migrations')
    expect(git('status', '--porcelain')).toBe('')
  })

  it('a week or more with nothing running does not count toward unused', () => {
    const lesson = approve(skill('run-migrations'), 'k1')
    days(20)
    clock += 60 * DAY                                                       // a laptop in a drawer
    working()
    expect(usage.unusedMs(lesson)).toBe(20 * DAY)
    days(15)
    expect(curator().maybeRun()).toMatchObject({ stale: ['run-migrations'], archived: [] })
    // The absence still going on counts for nothing either.
    clock += 200 * DAY
    expect(usage.unusedMs(lesson)).toBeLessThan(STALE_AFTER_MS + 6 * DAY)
    expect(usage.unusedMs(lesson)).toBeLessThan(ARCHIVE_AFTER_MS)
    expect(USAGE_GAP_MS).toBe(7 * DAY)
  })

  it('a lesson approved before tracking began is unused from when tracking began; a restore starts the clock again', () => {
    const lesson = approve(skill('run-migrations'), 'k1')
    clock += 100 * DAY
    const fresh = new LessonUsage({ store, now: () => clock })               // tracking starts now
    expect(fresh.unusedMs(lesson)).toBe(0)
    usage = fresh
    days(95)
    expect(curator().run().archived).toEqual(['run-migrations'])
    expect(store.restore(lesson.id).ok).toBe(true)
    usage.restored(lesson.id)
    expect(usage.unusedMs(store.approved()[0]!)).toBe(0)
  })
})
