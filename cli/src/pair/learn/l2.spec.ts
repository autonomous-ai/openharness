/**
 * L2 through the learner (daemons/LEARNING.md): borrowing on the tick (opt-in), the curator on the tick,
 * export following every approval, revert, archive and restore, and the `lessons` verbs that go with them.
 * Real lessons folder and real git in a temp dir; every engine home and export folder is a temp folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { LessonBorrower, BORROW_EVERY_MS } from './borrow.js'
import { LessonCurator } from './curate.js'
import { LessonDistiller } from './distill.js'
import { LessonExporter } from './export.js'
import { PairLearner } from './propose.js'
import { installLessons, runtimeLessons } from './publish.js'
import { LessonStore } from './store.js'
import { LessonUsage } from './usage.js'
import { projectHash, type Signal } from './types.js'
import { PairVoice } from '../voice.js'
import type { DaemonSay } from '../protocol.js'
import type { ExportDestination } from '../rules.js'

const DAY = 24 * 60 * 60_000
let dir: string
let ws: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'learn-l2-')))
  ws = join(dir, 'code', 'api')
  mkdirSync(ws, { recursive: true })
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 3, 15, 0) })
})
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) })

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  utimesSync(path, new Date(Date.now() - DAY), new Date(Date.now() - DAY))
}

function world(opts: { borrow?: boolean; exportTo?: ExportDestination[] } = {}) {
  let borrow = opts.borrow ?? false
  let exportTo = opts.exportTo ?? []
  let busy = false
  const home = join(dir, 'home')
  const frames: Array<Record<string, unknown>> = []
  const voice = new PairVoice({ sendLocal: (f) => frames.push(f), now: Date.now })
  let n = 0
  const store = new LessonStore({ root: join(home, '.harness', 'lessons'), now: Date.now, newId: () => `d0${(++n).toString(16).padStart(4, '0')}`, env: { PATH: process.env.PATH } })
  const usage = new LessonUsage({ store, now: Date.now })
  const dirs = { agents: join(home, '.agents', 'skills'), claude: join(home, '.claude', 'skills') }
  let learner: PairLearner | null = null
  learner = new PairLearner({
    store, distiller: new LessonDistiller({ now: Date.now }), pairedDaemon: () => 'tim', autonomy: () => 'suggest',
    voice, sendLocal: (f) => frames.push(f), present: () => true, focused: () => false, busy: () => busy,
    projects: () => [ws], machineId: () => 'machine-a', home, now: Date.now,
    borrowEnabled: () => borrow,
    borrower: new LessonBorrower({ store, sources: { hermesHome: join(home, '.hermes'), claudeProjectsDir: null, codexHome: null }, projects: () => [ws], machine: () => 'desk', now: Date.now, home }),
    usage,
    curator: new LessonCurator({ store, usage, now: Date.now, busy: () => busy, archived: (record) => { learner?.withdrawn(record) } }),
    exportTo: () => exportTo,
    exporter: new LessonExporter({ store, dirs, destinations: () => exportTo }),
  })
  const says = () => frames.filter((f) => f.type === 'daemon_say').map((f) => f.payload as DaemonSay)
  const approveSteps = async (name = 'npm run db:reset'): Promise<string> => {
    const project = projectHash(ws)
    const signal: Signal = {
      kind: 'repeat-steps', key: `steps:${name}`, project, projectName: 'api', at: Date.now(), steps: [name, 'npm run migrate', 'npm test'],
      from: [1, 2, 3].map((turn) => ({ engine: 'claude', machine: 'desk', agentId: 'a1', session: `s${turn}`, turn, project, at: Date.now() })), evidence: [],
    }
    const added = store.add({ lesson: { kind: 'skill', name: 'run-db-reset-first', description: 'Reset the database first.', body: 'Run `npm run db:reset` first.' }, signal, learnedBy: 'tim', source: 'template' })
    if (!added.ok) throw new Error(added.error)
    const result = learner!.approve(added.record.id, 'key')
    if (result.ok !== true) throw new Error(String(result.error))
    return added.record.id
  }
  return {
    learner, store, usage, dirs, home, says, approveSteps,
    set: (patch: { borrow?: boolean; exportTo?: ExportDestination[]; busy?: boolean }) => {
      if (patch.borrow !== undefined) borrow = patch.borrow
      if (patch.exportTo) exportTo = patch.exportTo
      if (patch.busy !== undefined) busy = patch.busy
    },
  }
}

describe('borrow on the tick', () => {
  const hermesSkill = (home: string) => {
    write(join(home, '.hermes', 'skills', 'deploy-api', 'SKILL.md'), '---\nname: deploy-api\ndescription: Deploy the api. Use before any deploy of api.\n---\nBuild, then run the smoke test.\n')
    write(join(home, '.hermes', 'skills', '.usage.json'), JSON.stringify({ 'deploy-api': { created_by: 'agent' } }))
  }

  it('does nothing unless pair.jsonc turns it on; then proposes a borrowed lesson through the same line', async () => {
    const w = world()
    hermesSkill(w.home)
    await w.learner.tick()
    expect(w.store.list()).toEqual([])
    w.set({ borrow: true, busy: true })
    await w.learner.tick()
    expect(w.store.list()).toEqual([])                                      // waits for a quiet moment
    w.set({ busy: false })
    await w.learner.tick()
    expect(w.store.pending().map((r) => [r.name, r.source, r.provenance])).toEqual([['deploy-api', 'borrowed', 'borrowed from hermes']])
    expect(w.says().at(-1)!.line).toBe('[y/n/s] teach your agents "deploy-api"? borrowed from hermes.')
    // Every few hours, not every tick.
    write(join(w.home, '.hermes', 'skills', 'lint', 'SKILL.md'), '---\nname: lint\ndescription: Lint first.\n---\nRun the linter.\n')
    write(join(w.home, '.hermes', 'skills', '.usage.json'), JSON.stringify({ 'deploy-api': { created_by: 'agent' }, lint: { created_by: 'agent' } }))
    await w.learner.tick()
    expect(w.store.pending()).toHaveLength(1)
    vi.advanceTimersByTime(BORROW_EVERY_MS)
    await w.learner.tick()
    expect(w.store.pending()).toHaveLength(2)
    const list = await w.learner.local({ action: 'list' })
    expect(list.lessons).toContainEqual(expect.objectContaining({ name: 'deploy-api', provenance: 'borrowed from hermes', from: ['hermes@desk skills/deploy-api/SKILL.md'] }))
  })
})

describe('export follows every change', () => {
  it('an approval exports; a revert takes the copy out of engine folders and of running sessions', async () => {
    const w = world({ exportTo: ['claude'] })
    const id = await w.approveSteps()
    const exported = join(w.dirs.claude, 'run-db-reset-first', 'SKILL.md')
    expect(readFileSync(exported, 'utf8')).toContain('    managed: true')
    const runtime = join(ws, '.harness', 'runtime', 'k1')
    mkdirSync(runtime, { recursive: true })
    installLessons(runtime, runtimeLessons(w.store, ws))
    expect(existsSync(join(runtime, 'lessons', 'run-db-reset-first', 'SKILL.md'))).toBe(true)
    const reverted = await w.learner.local({ action: 'revert', id })
    expect(reverted).toMatchObject({ ok: true, unpublished: { via: 'runtime', withdrawn: 1 } })
    expect(existsSync(exported)).toBe(false)
    expect(existsSync(join(runtime, 'lessons', 'run-db-reset-first', 'SKILL.md'))).toBe(false)
  })

  it('a change to pair.jsonc\'s destinations is followed on the next tick; export --dry-run and export say what happens', async () => {
    const w = world()
    await w.approveSteps()
    await w.learner.tick()
    expect(existsSync(w.dirs.agents)).toBe(false)
    w.set({ exportTo: ['agents'] })
    expect(await w.learner.local({ action: 'export', dryRun: true })).toMatchObject({ ok: true, dryRun: true, destinations: ['agents'], steps: [{ dest: 'agents', name: 'run-db-reset-first', action: 'write', path: '~/.agents/skills/run-db-reset-first/SKILL.md' }] })
    expect(existsSync(w.dirs.agents)).toBe(false)
    expect(await w.learner.local({ action: 'export' })).toMatchObject({ ok: false, error: 'CONFIRM' })
    await w.learner.tick()
    expect(existsSync(join(w.dirs.agents, 'run-db-reset-first', 'SKILL.md'))).toBe(true)
    w.set({ exportTo: [] })
    expect(await w.learner.local({ action: 'export', confirmed: true })).toMatchObject({ ok: true, dryRun: false, steps: [{ action: 'remove' }] })
    expect(existsSync(join(w.dirs.agents, 'run-db-reset-first'))).toBe(false)
  })
})

describe('the curator on the tick, and restore', () => {
  it('archives a skill nobody read for 90 days (out of exports and sessions), and restore brings it back', async () => {
    const w = world({ exportTo: ['claude'] })
    const id = await w.approveSteps()
    for (let day = 0; day < 91; day++) {
      vi.advanceTimersByTime(DAY)
      w.usage.ingest({ cwd: '/elsewhere' }, [{ type: 'turn_started', payload: {} }])
    }
    let list = await w.learner.local({ action: 'list' })
    expect(list.lessons).toEqual([expect.objectContaining({ id, status: 'approved', lastUsed: null, unusedDays: 91 })])
    await w.learner.tick()
    expect(w.store.get(id)?.status).toBe('archived')
    expect(existsSync(join(w.dirs.claude, 'run-db-reset-first'))).toBe(false)
    expect(await w.learner.local({ action: 'restore', id })).toMatchObject({ ok: false, error: 'CONFIRM' })
    expect(await w.learner.local({ action: 'restore', id, confirmed: true })).toMatchObject({ ok: true, restored: 'run-db-reset-first', commit: expect.any(String) })
    expect(existsSync(join(w.dirs.claude, 'run-db-reset-first', 'SKILL.md'))).toBe(true)
    list = await w.learner.local({ action: 'list' })
    expect(list.lessons).toEqual([expect.objectContaining({ id, status: 'approved', unusedDays: 0 })])
  })

  it('a read of the lesson keeps it; a stale one shows in the list', async () => {
    const w = world()
    const id = await w.approveSteps()
    for (let day = 0; day < 31; day++) {
      vi.advanceTimersByTime(DAY)
      w.usage.ingest({ cwd: '/elsewhere' }, [{ type: 'turn_started', payload: {} }])
    }
    await w.learner.tick()
    expect((await w.learner.local({ action: 'list' })).lessons).toEqual([expect.objectContaining({ id, stale: true })])
    w.usage.ingest({ cwd: '/elsewhere' }, [{ type: 'tool_start', payload: { id: 't', tool: 'Read', input: { file_path: '/x/lessons/run-db-reset-first/SKILL.md' } } }])
    const after = (await w.learner.local({ action: 'list' })).lessons as Array<Record<string, unknown>>
    expect(after[0]).toMatchObject({ lastUsed: new Date(Date.now()).toISOString(), unusedDays: 0 })
    expect(after[0]!.stale).toBeUndefined()
  })
})
