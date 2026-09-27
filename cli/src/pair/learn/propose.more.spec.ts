/**
 * PROPOSE, the edges (daemons/LEARNING.md): the signal queue's bounds, one tick at a time, every L2 step
 * failing without stopping the others, a line the voice would not say, a lesson answered through another door
 * while its line shows, a lesson too long for a dialog, and what approve, skip, revert and restore answer when
 * there is no git, no project, an edited block or nothing to act on. A real lessons folder in a temp dir
 * (without git unless a test says so), a recording voice, a fake clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BORROW_EVERY_MS, type BorrowPass } from './borrow.js'
import type { CuratorPass } from './curate.js'
import type { Distilled } from './distill.js'
import type { ExportStep } from './export.js'
import { DISTILL_EVERY_MS, PairLearner, joinProposals, type LearnerDeps } from './propose.js'
import { LESSONS_BEGIN, notesPath } from './publish.js'
import { LessonStore, NO_GIT_NOTE, type LessonRecord } from './store.js'
import { projectHash, type Lesson, type Provenance, type Signal } from './types.js'
import type { LessonUsage } from './usage.js'
import { DIALOG_MAX, type DaemonSay } from '../protocol.js'
import type { ExportDestination } from '../rules.js'

let dir: string
let ws: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'learn-propose-more-')))
  ws = join(dir, 'code', 'api')
  mkdirSync(ws, { recursive: true })
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 3, 15, 0) })
})
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) })

const from = (engine = 'claude', agentId = 'a1'): Provenance => ({ engine, machine: 'desk', agentId, session: 's', turn: 1, project: projectHash(ws), at: Date.now() })
function signal(key: string, patch: Partial<Signal> = {}): Signal {
  return { kind: 'repeat-steps', key, project: projectHash(ws), projectName: 'api', at: Date.now(), from: [from()], evidence: [], steps: ['a', 'b', 'c'], ...patch }
}
const skill = (name: string, body = `Run \`${name}\` first.`): Lesson => ({ kind: 'skill', name, description: `Do ${name} first.`, body })

class RacyStore extends LessonStore {
  /** After this many more reads of pending(), pending() answers nothing: another door took the lesson. */
  vanishAfter = Infinity
  override pending(): LessonRecord[] {
    if (this.vanishAfter <= 0) return []
    this.vanishAfter--
    return super.pending()
  }
}

function world(opts: Partial<LearnerDeps> & { git?: string | null; sayOk?: boolean } = {}) {
  let paired: string | null = 'tim'
  let present = true
  let sayOk = opts.sayOk ?? true
  let projects = [ws]
  let exportTo: ExportDestination[] = []
  const logs: string[] = []
  const said: DaemonSay[] = []
  const unsaid: Array<[string, string]> = []
  const frames: Array<Record<string, unknown>> = []
  const changed = vi.fn()
  let n = 0
  const store = new RacyStore({ root: join(dir, 'home', '.harness', 'lessons'), now: Date.now, newId: () => `ab${(++n).toString(16).padStart(4, '0')}`, git: opts.git === undefined ? null : opts.git, env: { PATH: process.env.PATH } })
  const voice = {
    say: vi.fn((say: DaemonSay) => { if (!sayOk) return false; said.push(say); return true }),
    unsay: vi.fn((id: string, reason: string) => { unsaid.push([id, reason]); return true }),
    showing: () => false,
  }
  const { git: _git, sayOk: _sayOk, ...deps } = opts
  const learner = new PairLearner({
    store, distiller: { distill: async () => ({ lesson: null, why: 'nothing' }) }, pairedDaemon: () => paired, autonomy: () => 'suggest',
    voice, sendLocal: (f) => frames.push(f), present: () => present, focused: () => false, projects: () => projects,
    machineId: () => 'machine-a', changed, home: join(dir, 'home'), now: Date.now, log: (line) => logs.push(line),
    exportTo: () => exportTo,
    ...deps,
  })
  const add = (lesson: Lesson, sig: Signal = signal(`k-${lesson.kind === 'skill' ? lesson.name : lesson.lines[0]}`)): LessonRecord => {
    const added = store.add({ lesson, signal: sig, learnedBy: 'tim', source: 'template' })
    if (!added.ok) throw new Error(added.error)
    return added.record
  }
  return {
    learner, store, voice, said, unsaid, frames, logs, changed, add,
    set: (patch: { paired?: string | null; present?: boolean; sayOk?: boolean; projects?: string[]; exportTo?: ExportDestination[] }) => {
      if (patch.paired !== undefined) paired = patch.paired
      if (patch.present !== undefined) present = patch.present
      if (patch.sayOk !== undefined) sayOk = patch.sayOk
      if (patch.projects) projects = patch.projects
      if (patch.exportTo) exportTo = patch.exportTo
    },
  }
}

describe('the signal queue', () => {
  it('drops a signal while pairing is off, keeps one of each key, and past twenty lets the oldest go', async () => {
    const distilled: string[] = []
    const w = world({ distiller: { distill: async (s) => { distilled.push(s.key); return { lesson: null, why: 'nothing' } } } })
    w.set({ paired: null })
    w.learner.signal(signal('k0'))
    expect(w.learner.queued).toBe(0)
    w.set({ paired: 'tim' })
    w.learner.signal(signal('k0'))
    w.learner.signal(signal('k0'))
    expect(w.learner.queued).toBe(1)
    for (let i = 1; i <= 20; i++) w.learner.signal(signal(`k${i}`))
    expect(w.learner.queued).toBe(20)
    await w.learner.tick()
    expect(distilled).toEqual(['k1', 'k2', 'k3'])
    expect(w.learner.queued).toBe(17)
  })

  it('one tick at a time: a tick while one is distilling returns at once', async () => {
    let release!: () => void
    const distill = vi.fn(() => new Promise<Distilled>((resolve) => { release = () => resolve({ lesson: null, why: 'nothing' }) }))
    const w = world({ distiller: { distill } })
    w.learner.signal(signal('slow'))
    const first = w.learner.tick()
    await w.learner.tick()
    expect(distill).toHaveBeenCalledTimes(1)
    release()
    await first
    w.learner.signal(signal('next'))
    vi.advanceTimersByTime(DISTILL_EVERY_MS)
    const second = w.learner.tick()
    release()
    await second
    expect(distill).toHaveBeenCalledTimes(2)
  })

  it('logs what each distilled signal came to: a failure, a refusal, a pending lesson, one already here', async () => {
    const lesson = skill('deploy-api')
    const w = world({
      distiller: {
        distill: async (s): Promise<Distilled> => {
          if (s.key === 'rej') throw new Error('model down')
          if (s.key === 'ref') return { lesson: null, why: 'refused', refusal: 'secret' }
          return { lesson, source: 'template' }
        },
      },
    })
    for (const key of ['rej', 'ref', 'ok', 'dup']) w.learner.signal(signal(key))
    await w.learner.tick()
    vi.advanceTimersByTime(DISTILL_EVERY_MS)
    await w.learner.tick()
    expect(w.logs.filter((l) => l.startsWith('[learn] repeat-steps'))).toEqual([
      '[learn] repeat-steps · nothing (failed)',
      '[learn] repeat-steps · nothing (refused: secret)',
      '[learn] repeat-steps · pending ab0001 "deploy-api"',
      '[learn] repeat-steps · KNOWN',
    ])
    expect(w.store.pending().map((r) => r.name)).toEqual(['deploy-api'])
  })
})

describe('L2 on the tick: each step fails alone', () => {
  it('a borrower that throws is logged, and tried again only after its interval', async () => {
    const pass = vi.fn<(learnedBy: string) => BorrowPass>()
      .mockImplementationOnce(() => { throw new Error('disk gone') })
      .mockImplementationOnce(() => { throw 'EACCES' })
      .mockImplementation(() => ({ added: [{} as LessonRecord], considered: 4, passed: {} }))
    const w = world({ borrowEnabled: () => true, borrower: { pass } })
    await w.learner.tick()
    await w.learner.tick()
    expect(pass).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(BORROW_EVERY_MS)
    await w.learner.tick()
    vi.advanceTimersByTime(BORROW_EVERY_MS)
    await w.learner.tick()
    expect(pass).toHaveBeenCalledWith('tim')
    expect(w.logs).toEqual(['[learn] borrow failed: disk gone', '[learn] borrow failed: EACCES', '[learn] borrowed 1 of 4'])
  })

  it('no borrowing with pairing off, or without the opt-in', async () => {
    const pass = vi.fn(() => ({ added: [], considered: 0, passed: {} }))
    const off = world({ borrower: { pass } })
    await off.learner.tick()
    const unpaired = world({ borrowEnabled: () => true, borrower: { pass } })
    unpaired.set({ paired: null })
    await unpaired.learner.tick()
    expect(pass).not.toHaveBeenCalled()
  })

  it('a curator that throws is logged every time, and export still runs after it', async () => {
    const maybeRun = vi.fn<() => CuratorPass | null>().mockImplementationOnce(() => { throw new Error('git broke') }).mockImplementationOnce(() => { throw 42 })
    const sync = vi.fn(() => ({ steps: [] as ExportStep[], dryRun: false }))
    const w = world({ curator: { maybeRun }, exporter: { sync, active: () => true } })
    await w.learner.tick()
    await w.learner.tick()
    expect(w.logs).toEqual(['[learn] curator failed: git broke', '[learn] curator failed: 42'])
    expect(sync).toHaveBeenCalledTimes(1)
    // With pairing off the curator waits.
    w.set({ paired: null })
    await w.learner.tick()
    expect(maybeRun).toHaveBeenCalledTimes(2)
  })

  it('export follows a change of destinations only, logs what moved and why, and survives a failure', async () => {
    const steps: ExportStep[] = [
      { dest: 'claude', name: 'a', id: 'x', action: 'write', path: '/p/a' },
      { dest: 'agents', name: 'b', id: 'y', action: 'skip', path: '/p/b', why: 'taken' },
      { dest: 'claude', name: 'c', id: 'z', action: 'keep', path: '/p/c' },
    ]
    const sync = vi.fn<() => { steps: ExportStep[]; dryRun: boolean }>(() => ({ steps, dryRun: false }))
    let active = true
    const w = world({ exporter: { sync, active: () => active } })
    const learner = w.learner
    await learner.tick()
    await learner.tick()
    expect(sync).toHaveBeenCalledTimes(1)
    expect(w.logs).toEqual(['[learn] export · write claude/a, skip agents/b (taken)'])
    sync.mockImplementationOnce(() => { throw new Error('read-only') })
    w.set({ exportTo: ['claude'] })
    await learner.tick()
    expect(w.logs.at(-1)).toBe('[learn] export failed: read-only')
    sync.mockImplementationOnce(() => { throw 'EROFS' })
    w.set({ exportTo: ['agents'] })
    await learner.tick()
    expect(w.logs.at(-1)).toBe('[learn] export failed: EROFS')
    // An exporter that is not active is never asked.
    active = false
    w.set({ exportTo: ['claude', 'agents'] })
    await learner.tick()
    expect(sync).toHaveBeenCalledTimes(3)
  })
})

describe('the line', () => {
  const record = (patch: Partial<LessonRecord>): LessonRecord => ({
    id: 'ab0001', kind: 'skill', name: 'deploy-api', description: 'd', body: 'b', hash: 'h', signal: { kind: 'repeat-steps', key: 'k' },
    project: null, projectName: 'api', learnedBy: 'tim', from: [], evidence: [], source: 'template', created: 0, status: 'pending', ...patch,
  })

  it('names who was corrected, every engine that failed, or an agent; a note with no project name says this project', () => {
    const { learner } = world()
    expect(learner.line(record({ signal: { kind: 'correction', key: 'k' }, from: [from('codex')] }))).toBe('[y/n/s] teach your agents "deploy-api"? you corrected codex.')
    expect(learner.line(record({ signal: { kind: 'repeat-failure', key: 'k' }, from: [from('claude'), from('codex'), from('hermes'), from('codex', 'b')] })))
      .toBe('[y/n/s] teach your agents "deploy-api"? claude, codex and hermes hit the same failure.')
    expect(learner.line(record({ signal: { kind: 'repeat-failure', key: 'k' }, from: [] }))).toBe('[y/n/s] teach your agents "deploy-api"? an agent hit the same failure.')
    expect(learner.line(record({ kind: 'note', projectName: null, from: [from('claude', 'a1'), from('claude', 'a2')] })))
      .toBe('[y/n/s] add a note for this project? the same steps, 2 times in this project.')
  })
})

describe('propose, when the voice or another door gets there first', () => {
  it('a line the voice would not say is not a proposal: nothing is marked, and it is tried again', () => {
    const w = world({ sayOk: false })
    const r = w.add(skill('deploy-api'))
    expect(w.learner.propose()).toBe(false)
    expect(w.store.proposedAt(r.id)).toBeNull()
    expect(w.store.lastProposedAt()).toBeNull()
    expect(w.changed).not.toHaveBeenCalled()
    expect(w.learner.pending()).toEqual([])
    w.set({ sayOk: true })
    expect(w.learner.propose()).toBe(true)
    expect(w.store.proposedAt(r.id)).toBe(Date.now())
  })

  it('a lesson with no provenance is about no pane', () => {
    const w = world()
    w.add(skill('deploy-api'), signal('k', { kind: 'repeat-failure', from: [] }))
    expect(w.learner.propose()).toBe(true)
    expect(w.said[0]).toMatchObject({ about: { machineId: 'machine-a', agentId: '' }, line: '[y/n/s] teach your agents "deploy-api"? an agent hit the same failure.' })
  })

  it('a lesson skipped through another door while its line shows: the line is gone, a key answers GONE', async () => {
    const w = world()
    const r = w.add(skill('deploy-api'))
    w.learner.propose()
    const id = w.said[0]!.id
    expect(w.store.skip(r.id)).toMatchObject({ ok: true })
    expect(w.learner.pending()).toEqual([])
    expect(await w.learner.act(id, 'y')).toEqual({ ok: false, error: 'GONE' })
  })

  it('a lesson taken between the key and its showing: [s] answers GONE and sends nothing', async () => {
    const w = world()
    w.add(skill('deploy-api'))
    w.learner.propose()
    const id = w.said[0]!.id
    w.store.vanishAfter = 1
    expect(await w.learner.act(id, 's')).toEqual({ ok: false, error: 'GONE' })
    expect(w.frames.filter((f) => f.type === 'daemon_brief')).toEqual([])
  })

  it('a lesson longer than a dialog is cut, and says how to read it whole', () => {
    const w = world()
    const body = Array.from({ length: 800 }, (_, i) => `Step ${i}: run the check for part ${i} and read its output.`).join('\n')
    const r = w.add(skill('long-procedure', body))
    w.learner.propose()
    const detail = w.said[0]!.detail!
    expect(detail).toBe(`${w.store.text(r).slice(0, DIALOG_MAX)}\n… (cut: harness pair lessons show ${r.id})`)
    expect(w.learner.pending()[0]!.detail).toBe(detail)
  })
})

describe('approve, skip, revert and restore: the answers', () => {
  it('approving twice: the second answers NOT_PENDING; an unknown id answers NOT_FOUND', () => {
    const w = world()
    const r = w.add(skill('deploy-api'))
    expect(w.learner.approve(r.id, 'cli')).toMatchObject({ ok: true, learned: 'deploy-api', commit: null, note: NO_GIT_NOTE })
    expect(w.learner.approve(r.id, 'cli')).toEqual({ ok: false, error: 'NOT_PENDING', detail: `lesson ${r.id} is approved` })
    expect(w.learner.approve('beef99', 'cli')).toEqual({ ok: false, error: 'NOT_FOUND', detail: 'no lesson beef99' })
  })

  it('approved at a terminal while its line shows: the line is taken down as answered', () => {
    const w = world()
    const r = w.add(skill('deploy-api'))
    w.learner.propose()
    const id = w.said[0]!.id
    w.changed.mockClear()
    expect(w.learner.approve(r.id, 'cli')).toMatchObject({ ok: true })
    expect(w.unsaid).toEqual([[id, 'answered']])
    expect(w.learner.pending()).toEqual([])
    expect(w.changed).toHaveBeenCalled()
  })

  it('at a terminal with nobody at this computer, it says nothing aloud; with someone here it does', () => {
    const w = world()
    const a = w.add(skill('deploy-api'))
    const b = w.add(skill('lint-first'))
    w.set({ present: false })
    w.learner.approve(a.id, 'cli')
    expect(w.said).toEqual([])
    w.set({ present: true })
    w.learner.approve(b.id, 'cli')
    expect(w.said.map((s) => [s.mood, s.line])).toEqual([['say', 'learned "lint-first". harness sessions on every engine will load it.']])
  })

  it('a note for a project no harness runs in now is kept, and says why it could not be written', () => {
    const w = world()
    const r = w.add({ kind: 'note', lines: ['Run the billing tests alone.'] }, signal('n', { project: projectHash(join(dir, 'gone')), projectName: null }))
    const result = w.learner.approve(r.id, 'cli')
    expect(result).toMatchObject({ ok: true, kind: 'note', published: { ok: false, error: 'PROJECT_UNKNOWN' } })
    expect(result.line).toBe(`kept "note-${r.id}". it could not be written for the project: no harness here runs in that project now; approve it again from one that does`)
  })

  it('an export that updated an engine\'s copy is reported with where and why', () => {
    const sync = vi.fn(() => ({ steps: [
      { dest: 'claude' as const, name: 'deploy-api', id: 'x', action: 'update' as const, path: join(dir, 'home', '.claude', 'skills', 'deploy-api', 'SKILL.md'), why: 'edited' as const },
      { dest: 'agents' as const, name: 'deploy-api', id: 'x', action: 'keep' as const, path: join(dir, 'home', '.agents', 'skills', 'deploy-api', 'SKILL.md') },
    ], dryRun: false }))
    const w = world({ exporter: { sync, active: () => true } })
    const r = w.add(skill('deploy-api'))
    expect(w.learner.approve(r.id, 'cli').exported).toEqual([
      { dest: 'claude', name: 'deploy-api', action: 'update', path: '~/.claude/skills/deploy-api/SKILL.md', why: 'edited' },
      { dest: 'agents', name: 'deploy-api', action: 'keep', path: '~/.agents/skills/deploy-api/SKILL.md' },
    ])
  })

  it('skip: of a lesson not pending answers why; at a terminal while its line shows, the line is taken down as declined', () => {
    const w = world()
    const a = w.add(skill('deploy-api'))
    w.learner.approve(a.id, 'cli')
    expect(w.learner.skip(a.id)).toEqual({ ok: false, error: 'NOT_PENDING', detail: `lesson ${a.id} is approved` })
    const b = w.add(skill('lint-first'))
    vi.advanceTimersByTime(60 * 60_000)
    expect(w.learner.propose()).toBe(true)
    const id = w.said.at(-1)!.id
    expect(w.learner.skip(b.id)).toEqual({ ok: true, id: b.id, skipped: 'lint-first' })
    expect(w.unsaid).toEqual([[id, 'declined']])
    expect(w.learner.pending()).toEqual([])
  })

  it('revert without git: moved aside, the note taken out, and it says there were no commits', () => {
    const w = world()
    const r = w.add({ kind: 'note', lines: ['Run the billing tests alone.'] })
    expect(w.learner.approve(r.id, 'cli')).toMatchObject({ ok: true, published: { ok: true, untracked: true } })
    expect(readFileSync(notesPath(ws), 'utf8')).toContain(`<!-- lesson:${r.id} -->`)
    expect(w.learner.revert(r.id)).toEqual({ ok: true, id: r.id, reverted: `note-${r.id}`, commit: null, unpublished: { file: notesPath(ws) }, note: NO_GIT_NOTE })
    expect(existsSync(notesPath(ws))).toBe(false)
    expect(existsSync(join(w.store.root, 'reverted', `${r.id}-note-${r.id}`))).toBe(true)
  })

  it('revert of a note whose project no harness runs in now: reverted, its file left for the person', () => {
    const w = world()
    const r = w.add({ kind: 'note', lines: ['Run the billing tests alone.'] })
    w.learner.approve(r.id, 'cli')
    w.set({ projects: [] })
    expect(w.learner.revert(r.id)).toMatchObject({ ok: true, unpublished: { file: null } })
    expect(w.store.get(r.id)?.status).toBe('reverted')
    expect(readFileSync(notesPath(ws), 'utf8')).toContain(`<!-- lesson:${r.id} -->`)
  })

  it('revert of a note whose AGENTS.md block was edited: reverted in the store, the file left alone, and why', () => {
    writeFileSync(join(ws, 'AGENTS.md'), '# API\n')
    const w = world({ agentsMd: () => true })
    const r = w.add({ kind: 'note', lines: ['Run the billing tests alone.'] })
    expect(w.learner.approve(r.id, 'cli')).toMatchObject({ published: { ok: true, file: join(ws, 'AGENTS.md') } })
    const edited = `${readFileSync(join(ws, 'AGENTS.md'), 'utf8')}\n${LESSONS_BEGIN}\n`
    writeFileSync(join(ws, 'AGENTS.md'), edited)
    const reverted = w.learner.revert(r.id)
    expect(reverted).toMatchObject({ ok: true, unpublished: { ok: false, error: 'EDITED' } })
    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toBe(edited)
    expect(w.store.get(r.id)?.status).toBe('reverted')
  })

  it('revert of what is not approved answers why; a note withdrawn from sessions is no skill copy', () => {
    const changed = vi.fn()
    const w = world({ usage: { changed } as unknown as LessonUsage })
    expect(w.learner.revert('beef99')).toEqual({ ok: false, error: 'NOT_FOUND', detail: 'no lesson beef99' })
    const r = w.add({ kind: 'note', lines: ['x y z'] })
    expect(w.learner.withdrawn(r)).toBe(0)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('restore without git: back in skills/, its clock restarted, and it says there were no commits', () => {
    const usage = { changed: vi.fn(), restored: vi.fn() }
    const w = world({ usage: usage as unknown as LessonUsage })
    expect(w.learner.restore('beef99')).toEqual({ ok: false, error: 'NOT_FOUND', detail: 'no lesson beef99' })
    const r = w.add(skill('deploy-api'))
    w.learner.approve(r.id, 'cli')
    expect(w.store.archive(r.id)).toMatchObject({ ok: true })
    expect(w.learner.restore(r.id)).toEqual({ ok: true, id: r.id, restored: 'deploy-api', commit: null, note: NO_GIT_NOTE })
    expect(usage.restored).toHaveBeenCalledWith(r.id)
    expect(existsSync(join(w.store.skillsDir, 'deploy-api', 'SKILL.md'))).toBe(true)
  })
})

describe('harness pair lessons, the rest of the verbs', () => {
  it('no action lists; without git the list says so', async () => {
    const w = world()
    w.add(skill('deploy-api'))
    expect(await w.learner.local({})).toMatchObject({ ok: true, root: '~/.harness/lessons', git: false, note: NO_GIT_NOTE, lessons: [{ name: 'deploy-api', status: 'pending' }] })
  })

  it('export without an exporter is unsupported; a dry run with no destinations configured lists none', async () => {
    expect(await world().learner.local({ action: 'export', dryRun: true })).toEqual({ ok: false, error: 'UNSUPPORTED' })
    const sync = vi.fn((o?: { dryRun?: boolean }) => ({ steps: [] as ExportStep[], dryRun: o?.dryRun === true }))
    expect(await world({ exporter: { sync, active: () => true }, exportTo: undefined }).learner.local({ action: 'export', dryRun: true })).toEqual({ ok: true, dryRun: true, destinations: [], steps: [] })
    expect(sync).toHaveBeenCalledWith({ dryRun: true })
  })

  it('show of a lesson that is not here answers NOT_FOUND', async () => {
    expect(await world().learner.local({ action: 'show', id: 'beef99' })).toEqual({ ok: false, error: 'NOT_FOUND', detail: 'no lesson beef99' })
  })
})

describe('joinProposals', () => {
  it('a key for a line nobody owns is GONE; asks from every source are listed together', async () => {
    const a = { owns: (id: string) => id.startsWith('ask:'), act: vi.fn(async () => ({ ok: true })), pending: () => [{ id: 'ask:1', line: 'a', actions: [] }] }
    const b = { owns: (id: string) => id.startsWith('lesson:'), act: vi.fn(async () => ({ ok: true })), pending: () => [{ id: 'lesson:1', line: 'b', actions: [] }] }
    const joined = joinProposals(a, b)
    expect(joined.owns('other:1')).toBe(false)
    expect(await joined.act('other:1', 'y')).toEqual({ ok: false, error: 'GONE' })
    expect(await joined.act('lesson:1', 'y')).toEqual({ ok: true })
    expect(b.act).toHaveBeenCalledWith('lesson:1', 'y')
    expect(a.act).not.toHaveBeenCalled()
    expect(joined.pending().map((p) => p.id)).toEqual(['ask:1', 'lesson:1'])
  })
})
