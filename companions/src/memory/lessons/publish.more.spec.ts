/**
 * TEACH, at its edges: links, folders and files that are not what they seem. Nothing is ever read from or
 * written through a symlink — a linked skill file or folder in the store, a linked runtime, a linked notes
 * file (dangling or not), a linked `.git/info/exclude` — and a project reached through a link is the same
 * project. Everything lives in temp folders.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LESSONS_BEGIN, LESSONS_END, LESSONS_MARK, NOTES_EXCLUDE, addExcludeEntry, excludeNotes, findProject, isLink, isPlainDir, isPlainFile, installLessons, notesPath, publishNote, runtimeLessons, unpublishNote, withdrawSkill } from './publish.js'
import { LessonStore, type LessonRecord } from './store.js'
import { projectHash } from './types.js'

let dir: string
let ws: string
let outside: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'learn-publish-more-')))
  ws = join(dir, 'code', 'api')
  outside = join(dir, 'outside')
  mkdirSync(ws, { recursive: true })
  mkdirSync(outside, { recursive: true })
})
afterEach(() => {
  // Undo any chmod a test made, so the folder can go.
  try { execFileSync('chmod', ['-R', 'u+rwx', dir]) } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true })
})

const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME: '/nonexistent' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnv })

const note = (id: string, lines: string[] | null = ['a note']): LessonRecord => ({
  id, kind: 'note', name: `note-${id}`, description: 'the description', body: '', ...(lines ? { lines } : {}), hash: id,
  signal: { kind: 'repeat-steps', key: id }, project: projectHash(ws), projectName: 'api', learnedBy: 'tim', from: [], evidence: [],
  source: 'template', created: 1, status: 'approved',
})

/** A folder of lessons as the store keeps them: skills/<name>/SKILL.md. */
function skillsDir(names: string[]): string {
  const d = join(dir, 'lessons', 'skills')
  for (const name of names) {
    mkdirSync(join(d, name), { recursive: true })
    writeFileSync(join(d, name, 'SKILL.md'), `---\nname: ${name}\n---\nDo ${name}.\n`)
  }
  mkdirSync(d, { recursive: true })
  return d
}

describe('installLessons: what reaches a runtime', () => {
  it('copies only plain skill files in plain folders; a linked SKILL.md or a linked skill folder is passed over', () => {
    const d = skillsDir(['plain-one'])
    writeFileSync(join(outside, 'id_rsa'), 'PRIVATE')
    mkdirSync(join(d, 'linked-file'))
    symlinkSync(join(outside, 'id_rsa'), join(d, 'linked-file', 'SKILL.md'))
    // A skill folder that is a link: SKILL.md inside it is a plain file, but it is not the store's.
    mkdirSync(join(outside, 'elsewhere'))
    writeFileSync(join(outside, 'elsewhere', 'SKILL.md'), 'planted')
    symlinkSync(join(outside, 'elsewhere'), join(d, 'linked-folder'))
    // A chain: a link to a link to a folder.
    symlinkSync(join(d, 'linked-folder'), join(d, 'chained'))
    mkdirSync(join(d, 'missing-file'))
    const runtime = join(dir, 'runtime')
    mkdirSync(runtime)
    const skills = ['plain-one', 'linked-file', 'linked-folder', 'chained', 'missing-file', 'not-there'].map((name) => ({ name, description: `${name}\n  spans\tlines` }))
    const lines = installLessons(runtime, { dir: d, skills })
    expect(readdirSync(join(runtime, 'lessons')).sort()).toEqual([LESSONS_MARK, 'plain-one'])
    expect(lines).toEqual([
      '## Lessons',
      'Approved by the person in Harness, from what their agents did. Read one when its description fits the task.',
      `- plain-one: plain-one spans lines ${JSON.stringify(join(runtime, 'lessons', 'plain-one', 'SKILL.md'))}`,
      '',
    ])
    expect(readFileSync(join(outside, 'id_rsa'), 'utf8')).toBe('PRIVATE')
  })

  it('a name that could leave the folder is never used, and nothing is written outside the runtime', () => {
    const d = skillsDir(['ok-name'])
    const runtime = join(dir, 'runtime')
    mkdirSync(runtime)
    const evil = ['../escape', '..', '.', 'a/b', 'UPPER', 'trailing-', '-leading', 'double--dash', '', 'with space', 'ok-name/../../x']
    const lines = installLessons(runtime, { dir: d, skills: [...evil, 'ok-name'].map((name) => ({ name, description: 'x' })) })
    expect(readdirSync(join(runtime, 'lessons')).sort()).toEqual([LESSONS_MARK, 'ok-name'])
    expect(readdirSync(dir).sort()).toEqual(['code', 'lessons', 'outside', 'runtime'])
    expect(lines.filter((l) => l.startsWith('- '))).toHaveLength(1)
  })

  it('with no skills copied there are no Lessons lines; a project notes file gets its own', () => {
    const runtime = join(dir, 'runtime')
    mkdirSync(runtime)
    expect(installLessons(runtime, { dir: skillsDir([]), skills: [{ name: 'gone-skill', description: 'x' }] })).toEqual([])
    expect(existsSync(join(runtime, 'lessons', LESSONS_MARK))).toBe(true)
    expect(installLessons(runtime, { dir: skillsDir([]), skills: [], notes: notesPath(ws) })).toEqual([
      '## Project notes', `Approved by the person in Harness for this project. Read ${JSON.stringify(notesPath(ws))} before you start.`, '',
    ])
    // With nothing to copy, the old copy goes.
    expect(existsSync(join(runtime, 'lessons'))).toBe(false)
    expect(installLessons(runtime, null)).toEqual([])
    expect(installLessons(runtime, undefined)).toEqual([])
  })

  it('a dangling link where the copy goes is removed, never followed', () => {
    const runtime = join(dir, 'runtime')
    mkdirSync(runtime)
    symlinkSync(join(outside, 'not-yet'), join(runtime, 'lessons'))
    installLessons(runtime, { dir: skillsDir(['one-skill']), skills: [{ name: 'one-skill', description: 'x' }] })
    expect(lstatSync(join(runtime, 'lessons')).isDirectory()).toBe(true)
    expect(existsSync(join(outside, 'not-yet'))).toBe(false)
  })
})

describe('withdrawSkill: only copies Harness made, never through a link', () => {
  function runtimeCopy(folder: string, key: string, name: string, mark = true): string {
    const lessons = join(folder, '.harness', 'runtime', key, 'lessons')
    mkdirSync(join(lessons, name), { recursive: true })
    writeFileSync(join(lessons, name, 'SKILL.md'), 'copy')
    if (mark) writeFileSync(join(lessons, LESSONS_MARK), 'mark')
    return join(lessons, name, 'SKILL.md')
  }

  it('removes marked copies in every runtime of every folder, once per folder', () => {
    const a = runtimeCopy(ws, 's1', 'deploy-check')
    const b = runtimeCopy(ws, 's2', 'deploy-check')
    const unmarked = runtimeCopy(ws, 's3', 'deploy-check', false)
    expect(withdrawSkill('deploy-check', [ws, ws, join(dir, 'no-such-folder')]).sort()).toEqual([a, b].sort())
    expect(existsSync(a) || existsSync(b)).toBe(false)
    expect(existsSync(unmarked)).toBe(true)
  })

  it('a linked runtime root, a linked lessons folder, a linked skill folder: each left alone, their targets intact', () => {
    // .harness/runtime is a link to a folder holding a marked copy.
    const realRuntimeHome = join(outside, 'rt')
    const target1 = runtimeCopy(realRuntimeHome, 'k', 'deploy-check')
    mkdirSync(join(ws, '.harness'), { recursive: true })
    symlinkSync(join(realRuntimeHome, '.harness', 'runtime'), join(ws, '.harness', 'runtime'))
    expect(withdrawSkill('deploy-check', [ws])).toEqual([])
    expect(existsSync(target1)).toBe(true)

    const other = join(dir, 'code', 'web')
    // lessons/ is a link to a marked folder elsewhere.
    const target2 = runtimeCopy(join(outside, 'l2'), 'k', 'deploy-check')
    mkdirSync(join(other, '.harness', 'runtime', 'k1'), { recursive: true })
    symlinkSync(join(target2, '..', '..'), join(other, '.harness', 'runtime', 'k1', 'lessons'))
    // lessons/ is Harness's, but the skill folder in it is a link.
    const target3 = join(outside, 'skill3')
    mkdirSync(target3)
    writeFileSync(join(target3, 'SKILL.md'), 'keep')
    const lessons = join(other, '.harness', 'runtime', 'k2', 'lessons')
    mkdirSync(lessons, { recursive: true })
    writeFileSync(join(lessons, LESSONS_MARK), 'mark')
    symlinkSync(target3, join(lessons, 'deploy-check'))
    // The mark itself is a link.
    const lessons4 = join(other, '.harness', 'runtime', 'k3', 'lessons')
    mkdirSync(join(lessons4, 'deploy-check'), { recursive: true })
    writeFileSync(join(outside, 'mark'), 'mark')
    symlinkSync(join(outside, 'mark'), join(lessons4, LESSONS_MARK))
    expect(withdrawSkill('deploy-check', [other])).toEqual([])
    expect(existsSync(target2)).toBe(true)
    expect(readFileSync(join(target3, 'SKILL.md'), 'utf8')).toBe('keep')
    expect(existsSync(join(lessons4, 'deploy-check'))).toBe(true)
  })

  it('a runtime folder it cannot read is passed over', () => {
    const copy = runtimeCopy(ws, 's1', 'deploy-check')
    const root = join(ws, '.harness', 'runtime')
    chmodSync(root, 0o000)
    try {
      expect(withdrawSkill('deploy-check', [ws])).toEqual([])
    } finally { chmodSync(root, 0o755) }
    expect(existsSync(copy)).toBe(true)
  })

  it('never takes a name that could leave the folder', () => {
    runtimeCopy(ws, 's1', 'deploy-check')
    for (const name of ['..', '../deploy-check', 'deploy-check/..', '.', '']) expect(withdrawSkill(name, [ws])).toEqual([])
    expect(readdirSync(join(ws, '.harness', 'runtime', 's1', 'lessons')).sort()).toEqual([LESSONS_MARK, 'deploy-check'])
  })
})

describe('notes: never through a link, never into what is not a plain file', () => {
  it('refuses a linked or dangling .harness/lessons.md, a folder of that name, and a .harness that is a file', () => {
    mkdirSync(join(ws, '.harness'))
    writeFileSync(join(outside, 'victim.md'), 'victim\n')
    symlinkSync(join(outside, 'victim.md'), notesPath(ws))
    expect(publishNote(ws, note('abc1'))).toMatchObject({ ok: false, error: 'NOT_A_FILE', detail: `${notesPath(ws)} is not a plain file` })
    expect(readFileSync(join(outside, 'victim.md'), 'utf8')).toBe('victim\n')
    rmSync(notesPath(ws))
    // Dangling: writing would create the target outside the project.
    symlinkSync(join(outside, 'created-through-link.md'), notesPath(ws))
    expect(publishNote(ws, note('abc1'))).toMatchObject({ ok: false, error: 'NOT_A_FILE' })
    expect(existsSync(join(outside, 'created-through-link.md'))).toBe(false)
    rmSync(notesPath(ws))
    mkdirSync(notesPath(ws))
    expect(publishNote(ws, note('abc1'))).toMatchObject({ ok: false, error: 'NOT_A_FILE' })
    rmSync(join(ws, '.harness'), { recursive: true })
    writeFileSync(join(ws, '.harness'), 'a file')
    expect(publishNote(ws, note('abc1'))).toMatchObject({ ok: false, error: 'NOT_A_FILE', detail: `${join(ws, '.harness')} is not a plain folder` })
    rmSync(join(ws, '.harness'))
    // Dangling link as the folder.
    symlinkSync(join(outside, 'no-dir'), join(ws, '.harness'))
    expect(publishNote(ws, note('abc1'))).toMatchObject({ ok: false, error: 'NOT_A_FILE' })
    expect(existsSync(join(outside, 'no-dir'))).toBe(false)
  })

  it('opted in: a dangling AGENTS.md link blocks creating one; a linked CLAUDE.md is never written', () => {
    symlinkSync(join(outside, 'AGENTS.md'), join(ws, 'AGENTS.md'))
    expect(publishNote(ws, note('abc1'), { agentsMd: true, create: true })).toMatchObject({ ok: false, error: 'NOT_A_FILE', detail: `${join(ws, 'AGENTS.md')} is not a plain file` })
    expect(existsSync(join(outside, 'AGENTS.md'))).toBe(false)
    rmSync(join(ws, 'AGENTS.md'))
    writeFileSync(join(outside, 'CLAUDE.md'), 'theirs\n')
    symlinkSync(join(outside, 'CLAUDE.md'), join(ws, 'CLAUDE.md'))
    expect(publishNote(ws, note('abc1'), { agentsMd: true, create: true })).toMatchObject({ ok: false, error: 'NOT_A_FILE' })
    expect(readFileSync(join(outside, 'CLAUDE.md'), 'utf8')).toBe('theirs\n')
  })

  it('unpublish never edits through a link, even one holding the note', () => {
    writeFileSync(join(ws, 'AGENTS.md'), '# API\n')
    expect(publishNote(ws, note('abc1'), { agentsMd: true })).toMatchObject({ ok: true })
    const held = readFileSync(join(ws, 'AGENTS.md'), 'utf8')
    writeFileSync(join(outside, 'AGENTS.md'), held)
    rmSync(join(ws, 'AGENTS.md'))
    symlinkSync(join(outside, 'AGENTS.md'), join(ws, 'AGENTS.md'))
    expect(unpublishNote(ws, 'abc1')).toEqual({ ok: true, file: null })
    expect(readFileSync(join(outside, 'AGENTS.md'), 'utf8')).toBe(held)
  })

  it('a non-note is refused', () => {
    expect(publishNote(ws, { ...note('abc1'), kind: 'skill' })).toEqual({ ok: false, error: 'NOT_A_NOTE' })
  })

  it('a note without lines is its description; a file ending in a blank line gets no extra one', () => {
    writeFileSync(join(ws, 'AGENTS.md'), '# API\n\n')
    expect(publishNote(ws, note('abc1', null), { agentsMd: true })).toMatchObject({ ok: true })
    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toBe(`# API\n\n${LESSONS_BEGIN}\n## Lessons\n\nApproved in Harness from what agents did in this project. \`harness pair lessons revert <id>\` takes one back.\n\n<!-- lesson:abc1 -->\n- the description\n<!-- /lesson:abc1 -->\n${LESSONS_END}\n`)
  })

  it('markers out of order, a section with no block, or a section whose end was removed are left for the person', () => {
    writeFileSync(join(ws, 'AGENTS.md'), `x\n${LESSONS_END}\n${LESSONS_BEGIN}\n`)
    expect(publishNote(ws, note('abc1'), { agentsMd: true })).toMatchObject({ ok: false, error: 'EDITED' })
    writeFileSync(join(ws, 'AGENTS.md'), 'x\n<!-- lesson:abc1 -->\n- orphan\n')
    expect(unpublishNote(ws, 'abc1')).toMatchObject({ ok: false, error: 'EDITED', detail: expect.stringContaining('remove lesson abc1 by hand') })
    const cut = `x\n${LESSONS_BEGIN}\n<!-- lesson:abc1 -->\n- no end marker\n${LESSONS_END}`
    writeFileSync(join(ws, 'AGENTS.md'), cut)
    expect(unpublishNote(ws, 'abc1')).toEqual({ ok: true, file: join(ws, 'AGENTS.md') })
    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toBe(cut)
    // A section whose end marker ends the file (no newline after it) comes out whole.
    writeFileSync(join(ws, 'AGENTS.md'), `x\n${LESSONS_BEGIN}\n<!-- lesson:abc1 -->\n- one\n<!-- /lesson:abc1 --><!-- lesson:abc2 -->\n- two\n<!-- /lesson:abc2 -->\n${LESSONS_END}\n`)
    expect(unpublishNote(ws, 'abc1')).toMatchObject({ ok: true })
    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toBe(`x\n${LESSONS_BEGIN}\n<!-- lesson:abc2 -->\n- two\n<!-- /lesson:abc2 -->\n${LESSONS_END}\n`)
  })
})

describe('.git/info/exclude', () => {
  it('a worktree uses its repository\'s shared exclude, by the absolute path git gives', () => {
    const main = join(dir, 'main')
    mkdirSync(main)
    git(main, 'init', '-q')
    git(main, '-c', 'user.name=x', '-c', 'user.email=x@x.invalid', 'commit', '-q', '--allow-empty', '-m', 'start')
    const wt = join(dir, 'wt')
    git(main, 'worktree', 'add', '-q', wt)
    expect(publishNote(wt, note('abc1'))).toMatchObject({ ok: true, untracked: true })
    const shared = join(main, '.git', 'info', 'exclude')
    expect(readFileSync(shared, 'utf8')).toContain(NOTES_EXCLUDE)
    expect(git(wt, 'status', '--porcelain', '--untracked-files=all')).toBe('')
  })

  it('made when missing; a line added after text with no final newline starts on its own line', () => {
    git(ws, 'init', '-q')
    rmSync(join(ws, '.git', 'info'), { recursive: true, force: true })
    expect(excludeNotes(ws)).toBe(join(ws, '.git', 'info', 'exclude'))
    expect(readFileSync(join(ws, '.git', 'info', 'exclude'), 'utf8')).toBe(`# Harness lessons (untracked notes)\n${NOTES_EXCLUDE}\n`)
    writeFileSync(join(ws, '.git', 'info', 'exclude'), '*.log')
    excludeNotes(ws)
    expect(readFileSync(join(ws, '.git', 'info', 'exclude'), 'utf8')).toBe(`*.log\n# Harness lessons (untracked notes)\n${NOTES_EXCLUDE}\n`)
  })

  it('a linked exclude file or a linked info folder is never written through', () => {
    git(ws, 'init', '-q')
    const exclude = join(ws, '.git', 'info', 'exclude')
    writeFileSync(join(outside, 'exclude'), 'theirs\n')
    rmSync(exclude, { force: true })
    symlinkSync(join(outside, 'exclude'), exclude)
    expect(excludeNotes(ws)).toBeNull()
    expect(readFileSync(join(outside, 'exclude'), 'utf8')).toBe('theirs\n')
    rmSync(join(ws, '.git', 'info'), { recursive: true, force: true })
    mkdirSync(join(outside, 'info'))
    symlinkSync(join(outside, 'info'), join(ws, '.git', 'info'))
    expect(excludeNotes(ws)).toBeNull()
    expect(readdirSync(join(outside, 'info'))).toEqual([])
    // The note itself is still written: untracked by intent, if not by git.
    expect(publishNote(ws, note('abc1'))).toMatchObject({ ok: true })
  })

  it('outside a repository, or with no git at all, there is nothing to exclude', () => {
    expect(excludeNotes(ws)).toBeNull()
    expect(excludeNotes(ws, join(dir, 'no-such-git'))).toBeNull()
  })
})

describe('a project reached through a link is the same project', () => {
  it('its skills, its notes file and its hash are found through the link and through the real path', () => {
    const link = join(dir, 'link-to-api')
    symlinkSync(ws, link)
    const store = new LessonStore({ root: join(dir, 'lessons-store'), now: () => Date.UTC(2026, 9, 3), git: null, newId: (() => { let n = 0; return () => `abc${++n}` })() })
    const add = (name: string, project: string | null, key: string) => {
      const added = store.add({ lesson: { kind: 'skill', name, description: `${name}.`, body: 'Do it.' }, signal: { kind: 'repeat-steps', key, project, projectName: 'api', at: 1, from: [], evidence: [] }, learnedBy: 'tim', source: 'template' })
      if (!added.ok) throw new Error(added.error)
      store.approve(added.record.id, 'key')
    }
    add('made-through-link', projectHash(link), 'k1')
    add('made-in-real-path', projectHash(ws), 'k2')
    expect(runtimeLessons(store, ws)?.skills.map((s) => s.name)).toContain('made-in-real-path')
    expect(runtimeLessons(store, link)?.skills.map((s) => s.name)).toEqual(['made-in-real-path', 'made-through-link'])
    expect(findProject(projectHash(ws), [link])).toBe(link)
    expect(publishNote(link, note('abc1'))).toMatchObject({ ok: true })
    expect(existsSync(notesPath(ws))).toBe(true)
    expect(runtimeLessons(store, link)?.notes).toBe(notesPath(link))
    // A folder that is gone is still hashed by its path.
    expect(findProject(projectHash(join(dir, 'gone')), [join(dir, 'gone')])).toBe(join(dir, 'gone'))
  })
})

describe('addExcludeEntry (the handoff folder reuses the notes exclude)', () => {
  const entry = { pattern: '**/.harness/handoff/', comment: 'X' }

  it('appends the entry once, with its comment, to a missing or an existing file', () => {
    git(ws, 'init', '-q')
    const file = join(ws, '.git', 'info', 'exclude')
    expect(addExcludeEntry(file, entry)).toBe(file)
    expect(addExcludeEntry(file, entry)).toBe(file)
    const text = readFileSync(file, 'utf8')
    expect(text.split('**/.harness/handoff/\n').length - 1).toBe(1)
    expect(text.endsWith('# X\n**/.harness/handoff/\n')).toBe(true)
  })

  it('creates the file and its folder when they are missing', () => {
    git(ws, 'init', '-q')
    rmSync(join(ws, '.git', 'info'), { recursive: true, force: true })
    const file = join(ws, '.git', 'info', 'exclude')
    expect(addExcludeEntry(file, entry)).toBe(file)
    expect(readFileSync(file, 'utf8')).toBe('# X\n**/.harness/handoff/\n')
  })

  it('refuses a linked file or a linked folder', () => {
    git(ws, 'init', '-q')
    const exclude = join(ws, '.git', 'info', 'exclude')
    writeFileSync(join(outside, 'exclude'), 'theirs\n')
    rmSync(exclude, { force: true })
    symlinkSync(join(outside, 'exclude'), exclude)
    expect(addExcludeEntry(exclude, entry)).toBeNull()
    expect(readFileSync(join(outside, 'exclude'), 'utf8')).toBe('theirs\n')
    rmSync(join(ws, '.git', 'info'), { recursive: true, force: true })
    mkdirSync(join(outside, 'info'))
    symlinkSync(join(outside, 'info'), join(ws, '.git', 'info'))
    expect(addExcludeEntry(exclude, entry)).toBeNull()
    expect(readdirSync(join(outside, 'info'))).toEqual([])
  })

  it('keeps the notes line and the handoff line side by side, each once', () => {
    git(ws, 'init', '-q')
    const file = excludeNotes(ws)!
    expect(addExcludeEntry(file, entry)).toBe(file)
    excludeNotes(ws)
    addExcludeEntry(file, entry)
    const lines = readFileSync(file, 'utf8').split('\n')
    expect(lines.filter((line) => line === NOTES_EXCLUDE)).toHaveLength(1)
    expect(lines.filter((line) => line === entry.pattern)).toHaveLength(1)
  })

  it('exports the plain-file checks the handoff writer relies on', () => {
    writeFileSync(join(outside, 'f'), 'x')
    symlinkSync(join(outside, 'f'), join(dir, 'link-f'))
    symlinkSync(outside, join(dir, 'link-d'))
    expect(isPlainFile(join(outside, 'f'))).toBe(true)
    expect(isPlainFile(join(dir, 'link-f'))).toBe(false)
    expect(isPlainDir(outside)).toBe(true)
    expect(isPlainDir(join(dir, 'link-d'))).toBe(false)
    expect(isLink(join(dir, 'link-d'))).toBe(true)
    expect(isLink(outside)).toBe(false)
  })
})
