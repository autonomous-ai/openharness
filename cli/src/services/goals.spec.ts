import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GOALS_REQUESTS, type Asker, type ServiceRequests } from '../core/api.js'
import { HACHI_ID } from '../dsh/builtinIds.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { GOAL_HARNESSES_MAX, GOAL_KEPT_MS, GOAL_TITLE_MAX, GOALS_OPEN_MAX, goalsPath, startGoals } from './goals.js'

const NOW = Date.parse('2026-11-12T12:00:00Z')
const LOCAL: Asker = { local: true, owner: true }

const session = (agentId: string, pane: string, dsh: string | null) => ({
  agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: `/work/${agentId}`, dsh,
  runtimes: [{ backend: 'tmux', paneId: pane }],
}) as unknown as RegisteredSession

let dir: string
let clock: number
let goals: ServiceRequests
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'goals-'))
  clock = NOW
  goals = startGoals(fakeCore({ dataDir: dir, agents: { live: () => [session('hachi', '%1', HACHI_ID), session('lead', '%2', null)] } }), { now: () => clock })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const ask = async (type: (typeof GOALS_REQUESTS)[number], payload: Record<string, unknown>, asker: Asker = LOCAL) =>
  await goals[type]!({ pane: '%1', ...payload }, asker) as Record<string, any>
const open = async (title = 'flaky login test') => (await ask('goal_open', { title })).goal as Record<string, any>
const add = (id: string, creationId: string, over: Record<string, unknown> = {}) => ask('goal_add', { id, machineId: 'm', creationId, ...over })

describe('harness goal, kept by the service', () => {
  it('answers every request it declares', () => {
    expect(Object.keys(startGoals(fakeCore({ dataDir: dir }))).sort()).toEqual([...GOALS_REQUESTS].sort())
  })

  it('opens a goal from the person\'s words, records the harnesses started under it, and closes it', async () => {
    const goal = await open('  flaky   login\ttest ')
    expect(goal).toEqual({ id: expect.stringMatching(/^[0-9a-f]{8}$/), title: 'flaky login test', harnesses: [], openedAt: NOW, lastStartAt: null, doneAt: null })
    clock += 1_000
    // Asked for and not started yet (its engine installing), then made: one harness, by its creation.
    await add(goal.id, 'c1')
    expect((await add(goal.id, 'c1', { agentId: 'a1' })).goal.harnesses).toEqual([{ machineId: 'm', creationId: 'c1', agentId: 'a1' }])
    // Recorded again without its id (a retry of the asking): the id it has is kept.
    expect((await add(goal.id, 'c1')).goal.harnesses).toEqual([{ machineId: 'm', creationId: 'c1', agentId: 'a1' }])
    await add(goal.id, 'c2', { machineId: 'office', agentId: 'a2' })
    clock += 1_000
    const done = await ask('goal_done', { id: goal.id })
    expect(done.goal).toMatchObject({ id: goal.id, lastStartAt: NOW + 1_000, doneAt: NOW + 2_000,
      harnesses: [{ machineId: 'm', creationId: 'c1', agentId: 'a1' }, { machineId: 'office', creationId: 'c2', agentId: 'a2' }] })
    // Asked twice, it is done once.
    clock += 1_000
    expect((await ask('goal_done', { id: goal.id })).goal.doneAt).toBe(NOW + 2_000)
    expect((await add(goal.id, 'c3')).error).toBe('GOAL_DONE')
  })

  it('refuses done for a goal with no harness started under it: an empty goal is never announced', async () => {
    const goal = await open()
    expect(await ask('goal_done', { id: goal.id })).toMatchObject({ error: 'GOAL_EMPTY' })
    expect((await ask('goal_list', {})).goals[0].doneAt).toBeNull()
  })

  it('lists the open goals and those closed in the last 7 days, newest first', async () => {
    const first = await open('first')
    await add(first.id, 'c1', { agentId: 'a1' })
    await ask('goal_done', { id: first.id })
    clock += 1_000
    const second = await open('second')
    expect((await ask('goal_list', {})).goals.map((g: { title: string }) => g.title)).toEqual(['second', 'first'])
    clock += GOAL_KEPT_MS
    expect((await ask('goal_list', {})).goals.map((g: { id: string }) => g.id)).toEqual([second.id])
    // Pruned from the file, not only from the answer.
    expect(readFileSync(goalsPath(dir), 'utf8')).not.toContain(first.id)
  })

  it('answers only the Hachi harness, from its pane on this machine: anything else is refused by name', async () => {
    const refused = { error: 'NOT_HACHI', message: expect.stringContaining('Only Hachi') }
    for (const type of GOALS_REQUESTS) {
      // Another harness here, a pane nothing runs in, no pane, or a request over the relay.
      expect(await ask(type, { pane: '%2', title: 't', id: 'x' })).toMatchObject(refused)
      expect(await ask(type, { pane: '%9', title: 't', id: 'x' })).toMatchObject(refused)
      expect(await ask(type, { pane: 7, title: 't', id: 'x' })).toMatchObject(refused)
      expect(await ask(type, { title: 't', id: 'x' }, { local: false, owner: true })).toMatchObject(refused)
    }
    expect(existsSync(goalsPath(dir))).toBe(false)
  })

  it('takes a title of at most 80 characters, with words in it', async () => {
    expect(await ask('goal_open', { title: 'x'.repeat(GOAL_TITLE_MAX + 1) })).toMatchObject({ error: 'BAD_TITLE' })
    expect(await ask('goal_open', { title: ' \n ' })).toMatchObject({ error: 'BAD_TITLE' })
    expect(await ask('goal_open', {})).toMatchObject({ error: 'BAD_TITLE' })
    expect((await open('x'.repeat(GOAL_TITLE_MAX))).title).toHaveLength(GOAL_TITLE_MAX)
  })

  it('holds at most 50 open goals, and as many harnesses a goal as it bounds', async () => {
    for (let i = 0; i < GOALS_OPEN_MAX; i++) await open(`goal ${i}`)
    expect(await ask('goal_open', { title: 'one more' })).toMatchObject({ error: 'GOAL_LIMIT' })
    const goal = (await ask('goal_list', {})).goals[0]
    for (let i = 0; i < GOAL_HARNESSES_MAX; i++) await add(goal.id, `c${i}`)
    expect(await add(goal.id, 'past')).toMatchObject({ error: 'GOAL_FULL' })
    // The one recorded already is recorded again, not refused.
    expect((await add(goal.id, 'c0', { agentId: 'a0' })).goal.harnesses[0]).toEqual({ machineId: 'm', creationId: 'c0', agentId: 'a0' })
  })

  it('refuses a goal it does not know, and a harness it cannot tell', async () => {
    expect(await ask('goal_done', { id: 'nope' })).toMatchObject({ error: 'UNKNOWN_GOAL' })
    expect(await add('nope', 'c1')).toMatchObject({ error: 'UNKNOWN_GOAL' })
    const goal = await open()
    expect(await add(goal.id, '')).toMatchObject({ error: 'BAD_HARNESS' })
    expect(await add(goal.id, 'c1', { machineId: 3 })).toMatchObject({ error: 'BAD_HARNESS' })
    expect(await add(goal.id, 'c1', { agentId: 4 })).toMatchObject({ error: 'BAD_HARNESS' })
  })

  it('keeps its file at mode 0600 in the data folder, and makes it 0600 again if it was not', async () => {
    await open()
    const file = goalsPath(dir)
    expect(file).toBe(join(dir, 'hachi', 'goals.json'))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    chmodSync(file, 0o644)
    await open('another')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8')).goals).toHaveLength(2)
  })

  it('says by name when this computer could not save a goal, and logs the code', async () => {
    const goal = await open()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    // The folder made read-only: nothing can be written into it.
    chmodSync(join(dir, 'hachi'), 0o500)
    try {
      const notSaved = { error: 'NOT_SAVED', message: expect.stringContaining('could not save') }
      expect(await ask('goal_open', { title: 'another' })).toMatchObject(notSaved)
      expect(await add(goal.id, 'c1')).toMatchObject(notSaved)
    } finally { chmodSync(join(dir, 'hachi'), 0o700) }
    await add(goal.id, 'c1')
    chmodSync(join(dir, 'hachi'), 0o500)
    try { expect(await ask('goal_done', { id: goal.id })).toMatchObject({ error: 'NOT_SAVED' }) } finally { chmodSync(join(dir, 'hachi'), 0o700) }
    expect(log).toHaveBeenCalledWith('[goals] goals.json not written · EACCES')
    log.mockRestore()
  })

  it('starts empty from a file it cannot read, and says so by its code, never its contents', async () => {
    mkdirSync(join(dir, 'hachi'), { recursive: true })
    writeFileSync(goalsPath(dir), '{not json')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await ask('goal_list', {})).goals).toEqual([])
    expect(log).toHaveBeenCalledWith('[goals] goals.json unreadable · SyntaxError')
    // A file of another shape is no goals either; a goal missing its parts is dropped.
    writeFileSync(goalsPath(dir), JSON.stringify({ goals: [{ id: 'a' }, { id: 'b', title: 't', harnesses: [], openedAt: 1, lastStartAt: null, doneAt: null }] }))
    expect((await ask('goal_list', {})).goals.map((g: { id: string }) => g.id)).toEqual(['b'])
    writeFileSync(goalsPath(dir), JSON.stringify({ goals: 'no' }))
    expect((await ask('goal_list', {})).goals).toEqual([])
    log.mockRestore()
  })
})
