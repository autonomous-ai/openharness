/**
 * EXPORT at its edges: what is in an engine's skills folder is the person's unless Harness wrote it, and a
 * link, a folder, a file that is too big or a failed write never costs the person a file. Both destinations
 * are temp folders; the manifest is the lessons folder's export.json.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'learn-export-more-')))
  let n = 0
  store = new LessonStore({ root: join(dir, 'home', '.harness', 'lessons'), now: () => Date.UTC(2026, 9, 3), newId: () => `e1${(++n).toString(16).padStart(4, '0')}`, git: null })
  dirs = { agents: join(dir, 'home', '.agents', 'skills'), claude: join(dir, 'home', '.claude', 'skills') }
  destinations = ['claude']
})
afterEach(() => {
  for (const d of [dirs.agents, dirs.claude]) { try { chmodSync(d, 0o755) } catch { /* not there */ } }
  rmSync(dir, { recursive: true, force: true })
})

const signal = (key: string): Signal => ({ kind: 'repeat-steps', key, project: null, projectName: null, at: 1, from: [], evidence: [] })
function approve(lesson: Lesson, key: string): LessonRecord {
  const added = store.add({ lesson, signal: signal(key), learnedBy: 'tim', source: 'model' })
  if (!added.ok) throw new Error(added.error)
  const approved = store.approve(added.record.id, 'key')
  if (!approved.ok) throw new Error(approved.error)
  return approved.record
}
const skill = (name: string): Lesson => ({ kind: 'skill', name, description: `${name}, when it fits.`, body: `Do ${name}.` })
const exporter = () => new LessonExporter({ store, dirs, destinations: () => destinations })
const actions = (steps: Array<{ dest: string; name: string; action: string; why?: string }>) => steps.map((s) => `${s.action} ${s.dest}/${s.name}${s.why ? ` (${s.why})` : ''}`)
const manifest = () => JSON.parse(readFileSync(join(store.root, 'export.json'), 'utf8')) as { v: 1; entries: Array<{ name: string; path: string; hash: string; dest: string }> }

describe('what is there already', () => {
  it('a note is never exported: only skills are', () => {
    approve({ kind: 'note', lines: ['Tests need the database.'] }, 'k1')
    approve(skill('only-skill'), 'k2')
    expect(actions(exporter().plan())).toEqual(['write claude/only-skill'])
  })

  it('an empty folder of that name is used; a non-empty one, or a file where the folder goes, is the person\'s', () => {
    approve(skill('empty-folder'), 'k1')
    approve(skill('busy-folder'), 'k2')
    approve(skill('file-in-the-way'), 'k3')
    mkdirSync(join(dirs.claude, 'empty-folder'), { recursive: true })
    mkdirSync(join(dirs.claude, 'busy-folder'))
    writeFileSync(join(dirs.claude, 'busy-folder', 'README.md'), 'mine')
    writeFileSync(join(dirs.claude, 'file-in-the-way'), 'mine too')
    expect(actions(exporter().sync().steps)).toEqual(['write claude/empty-folder', 'skip claude/busy-folder (taken)', 'skip claude/file-in-the-way (taken)'])
    expect(readdirSync(join(dirs.claude, 'busy-folder'))).toEqual(['README.md'])
    expect(readFileSync(join(dirs.claude, 'file-in-the-way'), 'utf8')).toBe('mine too')
    expect(manifest().entries.map((e) => e.name)).toEqual(['empty-folder'])
  })

  it('a SKILL.md that is a folder, a link, or bigger than 256 KB is never read as Harness\'s', () => {
    approve(skill('folder-skill'), 'k1')
    approve(skill('huge-skill'), 'k2')
    approve(skill('linked-file'), 'k3')
    mkdirSync(join(dirs.claude, 'folder-skill', 'SKILL.md'), { recursive: true })
    mkdirSync(join(dirs.claude, 'huge-skill'), { recursive: true })
    writeFileSync(join(dirs.claude, 'huge-skill', 'SKILL.md'), 'x'.repeat(256 * 1024 + 1))
    mkdirSync(join(dirs.claude, 'linked-file'), { recursive: true })
    writeFileSync(join(dir, 'secret.md'), 'theirs')
    symlinkSync(join(dir, 'secret.md'), join(dirs.claude, 'linked-file', 'SKILL.md'))
    expect(actions(exporter().sync().steps)).toEqual(['skip claude/folder-skill (taken)', 'skip claude/huge-skill (taken)', 'skip claude/linked-file (symlink)'])
    expect(readFileSync(join(dir, 'secret.md'), 'utf8')).toBe('theirs')
  })

  it('on a case-insensitive disk, the person\'s Deploy-Check folder is theirs; on a case-sensitive one it is another folder', () => {
    approve(skill('deploy-check'), 'k1')
    mkdirSync(join(dirs.claude, 'Deploy-Check'), { recursive: true })
    writeFileSync(join(dirs.claude, 'Deploy-Check', 'SKILL.md'), 'the person\'s own\n')
    const insensitive = existsSync(join(dirs.claude, 'deploy-check'))
    expect(actions(exporter().sync().steps)).toEqual([insensitive ? 'skip claude/deploy-check (taken)' : 'write claude/deploy-check'])
    expect(readFileSync(join(dirs.claude, 'Deploy-Check', 'SKILL.md'), 'utf8')).toBe('the person\'s own\n')
  })
})

describe('taking copies back', () => {
  it('a copy whose folder became a link, or that is gone, is skipped and forgotten; its target is never touched', () => {
    const a = approve(skill('became-link'), 'k1')
    const b = approve(skill('went-away'), 'k2')
    exporter().sync()
    // The person moves Harness's copy into their dotfiles and links it back.
    mkdirSync(join(dir, 'dotfiles'))
    const moved = join(dir, 'dotfiles', 'became-link')
    mkdirSync(moved)
    writeFileSync(join(moved, 'SKILL.md'), readFileSync(join(dirs.claude, 'became-link', 'SKILL.md')))
    rmSync(join(dirs.claude, 'became-link'), { recursive: true })
    symlinkSync(moved, join(dirs.claude, 'became-link'))
    rmSync(join(dirs.claude, 'went-away'), { recursive: true })
    store.revert(a.id)
    store.revert(b.id)
    expect(actions(exporter().sync().steps)).toEqual(['skip claude/became-link (symlink)', 'skip claude/went-away (gone)'])
    expect(readFileSync(join(moved, 'SKILL.md'), 'utf8')).toBe(renderExported({ ...a, status: 'approved' }))
    expect(manifest().entries).toEqual([])
    expect(exporter().active()).toBe(true)
    destinations = []
    expect(exporter().active()).toBe(false)
  })

  it('a copy the person edited after a revert is left, and forgotten', () => {
    const a = approve(skill('edited-later'), 'k1')
    exporter().sync()
    writeFileSync(join(dirs.claude, 'edited-later', 'SKILL.md'), 'now mine\n')
    store.revert(a.id)
    expect(actions(exporter().sync().steps)).toEqual(['skip claude/edited-later (edited)'])
    expect(readFileSync(join(dirs.claude, 'edited-later', 'SKILL.md'), 'utf8')).toBe('now mine\n')
    expect(manifest().entries).toEqual([])
  })
})

describe('a write that fails', () => {
  it('costs nothing: the step is skipped, Harness\'s record of an earlier copy is kept, and the next sync catches up', () => {
    approve(skill('first-skill'), 'k1')
    exporter().sync()
    const before = manifest().entries
    // The lesson changes, and the destination folder cannot be written.
    const json = join(store.skillsDir, 'first-skill', 'lesson.json')
    writeFileSync(json, readFileSync(json, 'utf8').replace('Do first-skill.', 'Do first-skill, twice.'))
    approve(skill('second-skill'), 'k2')
    chmodSync(join(dirs.claude, 'first-skill'), 0o555)
    chmodSync(dirs.claude, 0o555)
    const failed = exporter().sync()
    expect(actions(failed.steps)).toEqual(['skip claude/first-skill (taken)', 'skip claude/second-skill (taken)'])
    expect(manifest().entries).toEqual(before)
    chmodSync(dirs.claude, 0o755)
    chmodSync(join(dirs.claude, 'first-skill'), 0o755)
    expect(actions(exporter().sync().steps)).toEqual(['update claude/first-skill', 'write claude/second-skill'])
    expect(readFileSync(join(dirs.claude, 'first-skill', 'SKILL.md'), 'utf8')).toContain('twice')
    expect(readdirSync(join(dirs.claude, 'first-skill'))).toEqual(['SKILL.md'])
  })
})

describe('the manifest', () => {
  it('one of another version, or not JSON, is no manifest; entries of the wrong shape are dropped', () => {
    approve(skill('a-skill'), 'k1')
    mkdirSync(store.root, { recursive: true })
    for (const text of ['{', JSON.stringify({ v: 2, entries: [] }), JSON.stringify({ v: 1, entries: 'x' }), 'null']) {
      writeFileSync(join(store.root, 'export.json'), text)
      destinations = []
      expect(exporter().plan()).toEqual([])
      expect(exporter().active()).toBe(false)
    }
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'keep')
    writeFileSync(join(store.root, 'export.json'), JSON.stringify({ v: 1, entries: [
      null, { dest: 'elsewhere', name: 'x', id: 'e1', path: victim, hash: 'h' }, { dest: 'claude', name: 7, path: victim, hash: 'h' },
      { dest: 'claude', name: 'x', path: 5, hash: 'h' }, { dest: 'claude', name: 'x', path: victim },
    ] }))
    expect(exporter().plan()).toEqual([])
    exporter().sync()
    expect(readFileSync(victim, 'utf8')).toBe('keep')
  })

  it('a dry run with nothing wanted and nothing recorded writes no manifest', () => {
    destinations = []
    expect(exporter().sync()).toEqual({ steps: [], dryRun: false })
    expect(existsSync(join(store.root, 'export.json'))).toBe(false)
  })
})
