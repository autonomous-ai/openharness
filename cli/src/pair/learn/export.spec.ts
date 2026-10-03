/**
 * L2 EXPORT (daemons/LEARNING.md): opt-in copies of approved skills in `~/.agents/skills` and
 * `~/.claude/skills`, marked `metadata.harness.managed: true`; only files Harness wrote are ever updated or
 * removed. Both destinations are temp folders.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExportDestination } from '../rules.js'
import { LessonExporter, renderExported } from './export.js'
import { LessonStore, type LessonRecord } from './store.js'
import type { Lesson, Signal } from './types.js'

let dir: string
let store: LessonStore
let dirs: { agents: string; claude: string }
let destinations: ExportDestination[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'learn-export-'))
  let n = 0
  store = new LessonStore({ root: join(dir, 'home', '.harness', 'lessons'), now: () => Date.UTC(2026, 9, 3), newId: () => `e0${(++n).toString(16).padStart(4, '0')}`, env: { PATH: process.env.PATH } })
  dirs = { agents: join(dir, 'home', '.agents', 'skills'), claude: join(dir, 'home', '.claude', 'skills') }
  destinations = ['agents', 'claude']
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const signal = (key: string): Signal => ({ kind: 'repeat-steps', key, project: null, projectName: null, at: 1, from: [{ engine: 'codex', machine: 'm', agentId: 'a', session: 's', turn: 1, project: null, at: 1 }], evidence: [] })
function approve(name: string): LessonRecord {
  const lesson: Lesson = { kind: 'skill', name, description: `${name}, when it fits.`, body: `Do ${name}.` }
  const added = store.add({ lesson, signal: signal(name), learnedBy: 'tim', source: 'model' })
  if (!added.ok) throw new Error(added.error)
  const approved = store.approve(added.record.id, 'key')
  if (!approved.ok) throw new Error(approved.error)
  return approved.record
}
const exporter = () => new LessonExporter({ store, dirs, destinations: () => destinations })
const actions = (steps: Array<{ dest: string; name: string; action: string; why?: string }>) => steps.map((s) => `${s.action} ${s.dest}/${s.name}${s.why ? ` (${s.why})` : ''}`)

describe('export', () => {
  it('writes each approved skill, marked managed, to each destination asked for', () => {
    const record = approve('run-migrations')
    expect(actions(exporter().sync().steps)).toEqual(['write agents/run-migrations', 'write claude/run-migrations'])
    for (const root of [dirs.agents, dirs.claude]) {
      const text = readFileSync(join(root, 'run-migrations', 'SKILL.md'), 'utf8')
      expect(text).toBe(renderExported(record))
      expect(text).toMatch(/^---\nname: run-migrations\ndescription: "run-migrations, when it fits\."\nmetadata:\n  harness:\n    managed: true\n    id: "e00001"\n/)
    }
    expect(actions(exporter().sync().steps)).toEqual(['keep agents/run-migrations', 'keep claude/run-migrations'])
  })

  it('a dry run says what it would do and touches nothing', () => {
    approve('run-migrations')
    const dry = exporter().sync({ dryRun: true })
    expect(dry.dryRun).toBe(true)
    expect(actions(dry.steps)).toEqual(['write agents/run-migrations', 'write claude/run-migrations'])
    expect(existsSync(dirs.agents)).toBe(false)
    expect(existsSync(join(store.root, 'export.json'))).toBe(false)
  })

  it('never touches what it did not write: a folder of that name, a symlink, a file the person edited', () => {
    approve('taken-skill')
    approve('linked-skill')
    approve('edited-skill')
    mkdirSync(join(dirs.claude, 'taken-skill'), { recursive: true })
    writeFileSync(join(dirs.claude, 'taken-skill', 'SKILL.md'), '---\nname: taken-skill\n---\nMine.\n')
    mkdirSync(join(dir, 'dotfiles', 'linked-skill'), { recursive: true })
    symlinkSync(join(dir, 'dotfiles', 'linked-skill'), join(dirs.claude, 'linked-skill'))
    destinations = ['claude']
    expect(actions(exporter().sync().steps)).toEqual(['skip claude/taken-skill (taken)', 'skip claude/linked-skill (symlink)', 'write claude/edited-skill'])
    expect(readFileSync(join(dirs.claude, 'taken-skill', 'SKILL.md'), 'utf8')).toBe('---\nname: taken-skill\n---\nMine.\n')
    expect(readdirSync(join(dir, 'dotfiles', 'linked-skill'))).toEqual([])
    // The person edits the copy Harness wrote: from then on it is theirs.
    writeFileSync(join(dirs.claude, 'edited-skill', 'SKILL.md'), 'my own words\n')
    expect(actions(exporter().sync().steps)).toContain('skip claude/edited-skill (edited)')
    destinations = []
    exporter().sync()
    expect(readFileSync(join(dirs.claude, 'edited-skill', 'SKILL.md'), 'utf8')).toBe('my own words\n')
  })

  it('removes exactly its own copies when a skill is reverted or a destination is turned off', () => {
    const a = approve('run-migrations')
    approve('lint-first')
    exporter().sync()
    writeFileSync(join(dirs.agents, 'lint-first', 'notes.txt'), 'the person\'s file\n')
    expect(store.revert(a.id).ok).toBe(true)
    expect(actions(exporter().sync().steps)).toEqual(['keep agents/lint-first', 'keep claude/lint-first', 'remove agents/run-migrations', 'remove claude/run-migrations'])
    expect(existsSync(join(dirs.agents, 'run-migrations'))).toBe(false)
    destinations = ['claude']
    expect(actions(exporter().sync().steps)).toEqual(['keep claude/lint-first', 'remove agents/lint-first'])
    // Its SKILL.md went; the folder stays, because the person put something else in it.
    expect(readdirSync(join(dirs.agents, 'lint-first'))).toEqual(['notes.txt'])
    destinations = []
    expect(actions(exporter().sync().steps)).toEqual(['remove claude/lint-first'])
    expect(exporter().active()).toBe(false)
  })

  it('updates its own copy when the lesson changes, and adopts an identical copy with no record', () => {
    const record = approve('run-migrations')
    destinations = ['agents']
    exporter().sync()
    rmSync(join(store.root, 'export.json'))
    expect(actions(exporter().sync().steps)).toEqual(['keep agents/run-migrations'])
    const manifest = JSON.parse(readFileSync(join(store.root, 'export.json'), 'utf8'))
    expect(manifest.entries).toEqual([expect.objectContaining({ dest: 'agents', name: 'run-migrations', id: record.id })])
    // The lesson's text changes (a hand edit in the lessons folder): Harness's own copy follows.
    const md = join(store.skillsDir, 'run-migrations', 'lesson.json')
    writeFileSync(md, readFileSync(md, 'utf8').replace('Do run-migrations.', 'Do run-migrations, with --dry-run.'))
    expect(actions(exporter().sync().steps)).toEqual(['update agents/run-migrations'])
    expect(readFileSync(join(dirs.agents, 'run-migrations', 'SKILL.md'), 'utf8')).toContain('with --dry-run')
  })
})
