/**
 * The lessons folder when things go wrong: a git that fails half way (every move is put back as it was, the
 * index left clean), records a person or an older version left behind, and the rules that keep ids, names
 * and the skipped list honest. Real git in a temp folder, through a wrapper that can fail one subcommand.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LessonStore, NO_GIT_NOTE, renderNote, renderSkill, type LessonRecord } from './store.js'
import type { Lesson, Signal } from './types.js'

let dir: string
let root: string
let failDir: string
let wrapper: string
let clock: number
let ids: string[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'learn-store-more-'))
  root = join(dir, 'lessons')
  failDir = join(dir, 'fail')
  mkdirSync(failDir)
  wrapper = join(dir, 'git-wrap')
  // A git that fails the subcommand named by a file in failDir (`fail-commit`, `fail-revert`, …).
  writeFileSync(wrapper, [
    '#!/bin/sh',
    'sub=""; skip=0',
    'for a in "$@"; do',
    '  if [ "$skip" = 1 ]; then skip=0; continue; fi',
    '  if [ "$a" = "-c" ]; then skip=1; continue; fi',
    '  sub="$a"; break',
    'done',
    'if [ -f "$LESSONS_FAIL_DIR/fail-$sub" ]; then echo "fatal: $sub refused on purpose" >&2; echo "second line" >&2; exit 1; fi',
    'exec git "$@"',
    '',
  ].join('\n'))
  chmodSync(wrapper, 0o755)
  clock = Date.UTC(2026, 9, 3, 15, 2)
  ids = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

let counter = 0
const store = (opts: { git?: string | null; newId?: (() => string) | null } = {}) => new LessonStore({
  root, now: () => clock,
  ...(opts.newId === null ? {} : { newId: opts.newId ?? (() => { const id = `${(++counter).toString(16).padStart(6, 'b')}`; ids.push(id); return id }) }),
  ...(opts.git === undefined ? { git: wrapper } : { git: opts.git }),
  env: { PATH: process.env.PATH, HOME: dir, LESSONS_FAIL_DIR: failDir },
})
const fail = (sub: string) => writeFileSync(join(failDir, `fail-${sub}`), '')
const heal = (sub: string) => rmSync(join(failDir, `fail-${sub}`), { force: true })
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })

const signal = (key: string, project: string | null = 'abc'): Signal => ({
  kind: 'repeat-steps', key, project, projectName: 'api', at: clock,
  from: [{ engine: 'codex', machine: 'office', agentId: 'b1', session: 's1', turn: 14, project, at: clock }],
  evidence: ['npm test'],
})
const skill = (name = 'run-migrations-safely', body = 'Run the dry run first.'): Lesson => ({ kind: 'skill', name, description: `${name}, when it fits.`, body })
const note: Lesson = { kind: 'note', lines: ['Tests need the local database up.'] }

function approved(s: LessonStore, lesson: Lesson, key: string): LessonRecord {
  const added = s.add({ lesson, signal: signal(key), learnedBy: 'tim', source: 'model' })
  if (!added.ok) throw new Error(added.error)
  const done = s.approve(added.record.id, 'key')
  if (!done.ok) throw new Error(`${done.error} ${done.detail ?? ''}`)
  return done.record
}

describe('a git that fails half way leaves everything as it was', () => {
  it('approve: a failed commit puts the lesson back in pending, nothing staged, and a retry works', () => {
    const s = store()
    const added = s.add({ lesson: skill(), signal: signal('k1'), learnedBy: 'tim', source: 'model' })
    if (!added.ok) throw new Error(added.error)
    fail('commit')
    const failed = s.approve(added.record.id, 'key')
    expect(failed).toEqual({ ok: false, error: 'COMMIT_FAILED', detail: 'fatal: commit refused on purpose second line' })
    expect(s.pending().map((r) => r.id)).toEqual([added.record.id])
    expect(existsSync(join(root, 'skills', 'run-migrations-safely'))).toBe(false)
    expect(git('status', '--porcelain')).toBe('')
    expect(git('log', '--format=%s')).toBe('lessons: start\n')
    heal('commit')
    expect(s.approve(added.record.id, 'key')).toMatchObject({ ok: true, commit: expect.stringMatching(/^[0-9a-f]{40}$/) })
  })

  it('revert: a failed `git revert` is aborted (reset --merge when abort fails too); the lesson stays approved', () => {
    const s = store()
    const record = approved(s, skill(), 'k1')
    const head = git('rev-parse', 'HEAD')
    fail('revert')
    expect(s.revert(record.id)).toMatchObject({ ok: false, error: 'REVERT_FAILED', detail: expect.stringContaining('revert refused on purpose') })
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(git('status', '--porcelain')).toBe('')
    expect(s.approved().map((r) => r.id)).toEqual([record.id])
    heal('revert')
    fail('commit')
    // The revert is staged, its commit fails: `git revert --abort` puts the tree back.
    expect(s.revert(record.id)).toMatchObject({ ok: false, error: 'REVERT_FAILED' })
    expect(git('status', '--porcelain')).toBe('')
    expect(existsSync(join(root, 'skills', record.name, 'SKILL.md'))).toBe(true)
    heal('commit')
    expect(s.revert(record.id)).toMatchObject({ ok: true, record: { status: 'reverted' } })
  })

  it('archive and restore: a failed commit moves the folder back', () => {
    const s = store()
    const record = approved(s, skill(), 'k1')
    fail('commit')
    expect(s.archive(record.id)).toMatchObject({ ok: false, error: 'COMMIT_FAILED' })
    expect(existsSync(join(root, 'skills', record.name, 'SKILL.md'))).toBe(true)
    expect(readdirSync(join(root, 'archive'))).toEqual([])
    expect(git('status', '--porcelain')).toBe('')
    heal('commit')
    expect(s.archive(record.id)).toMatchObject({ ok: true })
    fail('commit')
    expect(s.restore(record.id)).toMatchObject({ ok: false, error: 'COMMIT_FAILED' })
    expect(existsSync(join(root, 'archive', record.name, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(root, 'skills', record.name))).toBe(false)
    expect(git('status', '--porcelain')).toBe('')
    heal('commit')
    expect(s.restore(record.id)).toMatchObject({ ok: true, record: { status: 'approved' } })
  })

  it('stale: a failed empty commit is an error, and nothing is journaled', () => {
    const s = store()
    const record = approved(s, skill(), 'k1')
    const before = readFileSync(join(root, 'journal.jsonl'), 'utf8')
    fail('commit')
    expect(s.markStale(record.id)).toMatchObject({ ok: false, error: 'COMMIT_FAILED' })
    expect(readFileSync(join(root, 'journal.jsonl'), 'utf8')).toBe(before)
  })

  it('a failure with nothing on stderr still says why', () => {
    const s = store()
    const added = s.add({ lesson: skill(), signal: signal('k1'), learnedBy: 'tim', source: 'model' })
    if (!added.ok) throw new Error(added.error)
    writeFileSync(wrapper, '#!/bin/sh\nfor a in "$@"; do [ "$a" = commit ] && exit 3; done\nexec git "$@"\n')
    const failed = s.approve(added.record.id, 'key')
    // The error's own message, last two lines (the tail of the command it ran), capped at 200 characters.
    expect(failed).toEqual({ ok: false, error: 'COMMIT_FAILED', detail: 'Learned-By: tim Approved-By: key -- skills/run-migrations-safely' })
    expect(s.pending().map((r) => r.id)).toEqual([added.record.id])
  })
})

describe('history git cannot find', () => {
  it('a lesson approved before git was installed still reverts: its folder moves aside, no commit', () => {
    const first = store({ git: null })
    const record = approved(first, skill(), 'k1')
    expect(existsSync(join(root, '.git'))).toBe(false)
    // git arrives; the next lesson makes the repository, with no commit for the first.
    const s = store()
    approved(s, skill('another-lesson'), 'k2')
    const reverted = s.revert(record.id)
    expect(reverted).toMatchObject({ ok: true, commit: null, record: { status: 'reverted' } })
    expect(reverted.ok && 'note' in reverted).toBe(false)
    expect(readdirSync(join(root, 'reverted'))).toEqual([`${record.id}-run-migrations-safely`])
  })

  it('when git log itself fails, the revert still happens without a commit', () => {
    const s = store()
    const record = approved(s, skill(), 'k1')
    fail('log')
    expect(s.revert(record.id)).toMatchObject({ ok: true, commit: null })
    expect(existsSync(join(root, 'skills', record.name))).toBe(false)
    expect(readdirSync(join(root, 'reverted'))).toEqual([`${record.id}-${record.name}`])
  })
})

describe('ids, names and what is refused', () => {
  it('a default id is 8 hex characters; get() takes only an id of that shape, never a path', () => {
    const s = store({ newId: null, git: null })
    const added = s.add({ lesson: skill(), signal: signal('k1'), learnedBy: 'tim', source: 'model' })
    if (!added.ok) throw new Error(added.error)
    expect(added.record.id).toMatch(/^[0-9a-f]{8}$/)
    expect(s.get(added.record.id)?.id).toBe(added.record.id)
    for (const bad of ['../pending', 'ABCDEF', '', 'abc', `${added.record.id}/..`, 'g'.repeat(8), 'a'.repeat(33)]) expect(s.get(bad)).toBeNull()
  })

  it('skip, revert, archive, stale and restore of an unknown id say NOT_FOUND; of one in another state, which', () => {
    const s = store({ git: null })
    for (const act of [() => s.skip('abcdef'), () => s.revert('abcdef'), () => s.archive('abcdef'), () => s.markStale('abcdef'), () => s.restore('abcdef')]) {
      expect(act()).toMatchObject({ ok: false, error: 'NOT_FOUND', detail: 'no lesson abcdef' })
    }
    const record = approved(s, skill(), 'k1')
    expect(s.skip(record.id)).toMatchObject({ ok: false, error: 'NOT_PENDING', detail: `lesson ${record.id} is approved` })
    expect(s.restore(record.id)).toMatchObject({ ok: false, error: 'NOT_ARCHIVED' })
    const pending = s.add({ lesson: skill('other-lesson'), signal: signal('k2'), learnedBy: 'tim', source: 'model' })
    if (!pending.ok) throw new Error(pending.error)
    expect(s.markStale(pending.record.id)).toMatchObject({ ok: false, error: 'NOT_APPROVED', detail: `lesson ${pending.record.id} is pending` })
    expect(s.archive(pending.record.id)).toMatchObject({ ok: false, error: 'NOT_APPROVED' })
  })

  it('a second skill archived under a taken name gets its id in the folder, and each restores by its own id', () => {
    const s = store()
    const a = approved(s, skill('deploy-check', 'First.'), 'k1')
    expect(s.archive(a.id)).toMatchObject({ ok: true })
    const b = approved(s, skill('deploy-check', 'Second.'), 'k2')
    expect(b.name).toBe('deploy-check')
    expect(s.archive(b.id)).toMatchObject({ ok: true })
    expect(readdirSync(join(root, 'archive')).sort()).toEqual(['deploy-check', `deploy-check-${b.id}`])
    expect(s.restore(b.id)).toMatchObject({ ok: true, record: { id: b.id, name: 'deploy-check' } })
    expect(readFileSync(join(root, 'skills', 'deploy-check', 'SKILL.md'), 'utf8')).toContain('Second.')
    expect(s.restore(a.id)).toMatchObject({ ok: false, error: 'NAME_TAKEN' })
    expect(git('status', '--porcelain')).toBe('')
  })

  it('without git, restore says so', () => {
    const s = store({ git: null })
    const record = approved(s, skill(), 'k1')
    s.archive(record.id)
    expect(s.restore(record.id)).toMatchObject({ ok: true, commit: null, note: NO_GIT_NOTE })
  })

  it('the skipped list never holds the same hash or signal twice', () => {
    const s = store({ git: null })
    const a = approved(s, skill('lesson-a', 'A.'), 'shared-signal')
    const b = approved(s, skill('lesson-b', 'B.'), 'shared-signal')
    s.revert(a.id)
    const afterA = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as { skipped: string[] }
    expect(afterA.skipped).toEqual([a.hash, 'shared-signal'])
    // A hand-edited state.json already holding b's hash.
    writeFileSync(join(root, 'state.json'), JSON.stringify({ ...afterA, skipped: [b.hash, ...afterA.skipped] }))
    s.revert(b.id)
    const skipped = (JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as { skipped: string[] }).skipped
    expect(skipped).toEqual([a.hash, b.hash, 'shared-signal'])
    expect(new Set(skipped).size).toBe(skipped.length)
  })

  it('a later life of an id wins over its old skip in list()', () => {
    let next = 0
    const s = store({ git: null, newId: () => ['aaaa01', 'aaaa01', 'aaaa02'][next++]! })
    const x = s.add({ lesson: skill('lesson-x', 'X.'), signal: signal('kx'), learnedBy: 'tim', source: 'model' })
    if (!x.ok) throw new Error(x.error)
    s.skip(x.record.id)
    expect(s.list().map((r) => [r.id, r.name, r.status])).toEqual([['aaaa01', 'lesson-x', 'skipped']])
    const y = s.add({ lesson: skill('lesson-y', 'Y.'), signal: signal('ky'), learnedBy: 'tim', source: 'model' })
    if (!y.ok) throw new Error(y.error)
    expect(y.record.id).toBe('aaaa01')
    // The folder is removed by hand: the id is neither live nor, any longer, the skipped lesson.
    rmSync(join(root, 'pending', 'aaaa01'), { recursive: true })
    expect(s.list()).toEqual([])
  })

  it('markProposed forgets proposals of lessons no longer pending', () => {
    const s = store({ git: null })
    const a = s.add({ lesson: skill('lesson-a', 'A.'), signal: signal('ka'), learnedBy: 'tim', source: 'model' })
    const b = s.add({ lesson: skill('lesson-b', 'B.'), signal: signal('kb'), learnedBy: 'tim', source: 'model' })
    if (!a.ok || !b.ok) throw new Error('add')
    s.markProposed(a.record.id, 100)
    s.approve(a.record.id, 'key')
    s.markProposed(b.record.id, 200)
    expect(s.proposedAt(a.record.id)).toBeNull()
    expect(s.proposedAt(b.record.id)).toBe(200)
    expect(s.lastProposedAt()).toBe(200)
  })

  it('curatedAt is kept across instances', () => {
    const s = store({ git: null })
    expect(s.curatedAt()).toBeNull()
    s.markCurated(1234)
    expect(store({ git: null }).curatedAt()).toBe(1234)
  })
})

describe('what an older version or a person left in the folder', () => {
  it('folders that are not lessons, and records of the wrong shape, are passed over', () => {
    const s = store({ git: null })
    const record = approved(s, skill(), 'k1')
    mkdirSync(join(root, 'skills', 'hand-made'), { recursive: true })
    writeFileSync(join(root, 'skills', 'hand-made', 'SKILL.md'), '---\nname: hand-made\n---\n')
    for (const [name, json] of [['bad-json', '{'], ['no-id', '{"kind":"skill","name":"x"}'], ['bad-kind', '{"id":"abcdef","kind":"script","name":"x"}'], ['no-name', '{"id":"abcdef","kind":"skill"}']]) {
      mkdirSync(join(root, 'skills', name!), { recursive: true })
      writeFileSync(join(root, 'skills', name!, 'lesson.json'), json!)
    }
    writeFileSync(join(root, 'skills', 'a-file'), 'not a folder')
    expect(s.approved().map((r) => r.id)).toEqual([record.id])
    // A torn journal line is skipped, not fatal.
    writeFileSync(join(root, 'journal.jsonl'), `${readFileSync(join(root, 'journal.jsonl'), 'utf8')}{"op":"skipp\n\n`)
    expect(s.list().map((r) => r.id)).toEqual([record.id])
  })

  it('a state.json of the wrong shape is read as empty; non-string skipped entries are dropped', () => {
    const s = store({ git: null })
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'state.json'), JSON.stringify({ skipped: 'everything', proposed: 5, lastProposedAt: 'soon', curatedAt: {} }))
    expect(s.lastProposedAt()).toBeNull()
    expect(s.curatedAt()).toBeNull()
    expect(s.proposedAt('abcdef')).toBeNull()
    expect(s.add({ lesson: skill(), signal: signal('everything'), learnedBy: 'tim', source: 'model' }).ok).toBe(true)
    writeFileSync(join(root, 'state.json'), JSON.stringify({ skipped: [7, null, 'k-skipped'], proposed: {} }))
    expect(s.add({ lesson: skill('another-one'), signal: signal('k-skipped'), learnedBy: 'tim', source: 'model' })).toMatchObject({ ok: false, error: 'SKIPPED' })
  })

  it('an old .gitignore without a final newline, or empty, gains the missing lines; without git nothing commits', () => {
    const s = store({ git: null })
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, '.gitignore'), 'pending/\nreverted/')
    expect(s.add({ lesson: skill(), signal: signal('k1'), learnedBy: 'tim', source: 'model' }).ok).toBe(true)
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('pending/\nreverted/\nstate.json\njournal.jsonl\nusage.json\nexport.json\n*.tmp\n')
    writeFileSync(join(root, '.gitignore'), '')
    expect(s.add({ lesson: skill('another-one'), signal: signal('k2'), learnedBy: 'tim', source: 'model' }).ok).toBe(true)
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('pending/\nreverted/\nstate.json\njournal.jsonl\nusage.json\nexport.json\n*.tmp\n')
    expect(existsSync(join(root, '.git'))).toBe(false)
  })

  it('a .gitignore that cannot be read (a folder of that name) does not stop a lesson', () => {
    const s = store({ git: null })
    mkdirSync(join(root, '.gitignore'), { recursive: true })
    expect(s.add({ lesson: skill(), signal: signal('k1'), learnedBy: 'tim', source: 'model' }).ok).toBe(true)
  })

  it('a failed commit of the .gitignore is put back, staged nowhere, and tried again on the next write', () => {
    const s = store()
    expect(s.add({ lesson: skill(), signal: signal('k1'), learnedBy: 'tim', source: 'model' }).ok).toBe(true)
    writeFileSync(join(root, '.gitignore'), 'pending/\n')
    git('-c', 'user.name=x', '-c', 'user.email=x@x.invalid', 'commit', '-qam', 'old ignore')
    fail('commit')
    expect(s.add({ lesson: skill('two-two'), signal: signal('k2'), learnedBy: 'tim', source: 'model' }).ok).toBe(true)
    expect(git('log', '-1', '--format=%s')).toBe('old ignore\n')
    // Before the fix the new lines stayed on disk and staged: the next write found nothing missing and never
    // committed them, and the next `archive:` or `unlearn:` commit (no pathspec) swept them in.
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('pending/\n')
    expect(git('status', '--porcelain', '--', '.gitignore')).toBe('')
    expect(git('diff', '--cached', '--name-only')).toBe('')
    heal('commit')
    expect(s.add({ lesson: skill('three-three'), signal: signal('k3'), learnedBy: 'tim', source: 'model' }).ok).toBe(true)
    expect(git('log', '-1', '--format=%s')).toBe('lessons: ignore usage and export records\n')
  })
})

describe('the files an agent reads', () => {
  const base: LessonRecord = {
    id: 'abcdef', kind: 'skill', name: 'x-y', description: 'Say "hi": once.', body: '  Body.  \n', hash: 'h', signal: { kind: 'repeat-steps', key: 'k' },
    project: null, projectName: null, learnedBy: 'tim', from: [], evidence: [], source: 'template', created: 1, status: 'pending',
  }
  it('empty provenance and evidence are written as [] and read back as YAML', () => {
    const md = renderSkill(base)
    expect(md).toContain('    from: []\n    evidence: []\n---\nBody.\n')
    expect(md).toContain('description: "Say \\"hi\\": once."')
    expect(md).toContain('    approved: null')
    expect(md).not.toContain('provenance')
  })
  it('a note without lines is its description', () => {
    expect(renderNote({ ...base, kind: 'note', lines: undefined }).endsWith('---\n- Say "hi": once.\n')).toBe(true)
    expect(renderNote({ ...base, kind: 'note', lines: ['one', 'two'] }).endsWith('---\n- one\n- two\n')).toBe(true)
  })
})
