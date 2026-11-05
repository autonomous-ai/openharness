import { describe, expect, it, vi } from 'vitest'
import type { SuperTabScreen } from '../core/api.js'
import { fakeCore } from '../testing/fakeCore.js'
import { CREW_CONTINUE, CREW_FROZEN_MS, CREW_LOOK_MS, CrewKeeper, isCrewRow } from './crew.js'

// Task #3397: the host keeps a project's crew alive. A frozen crew session (the engine working, its whole screen still for
// 30 minutes) is closed so the keep-alive reopens it in place; a reopened one still holding its task is told to continue.

const crew = { role: 'Engineer', at: 1, by: 'pm' }
const row = (over: Record<string, unknown> = {}, agent: Record<string, unknown> = {}) =>
  ({ tabId: 'tab', active: true, agent: { id: 'a1', harnessId: 'h1', machineId: 'm1', crew, ...agent }, ...over })

function setup(options: { working?: () => boolean; screen?: () => SuperTabScreen; owns?: () => boolean } = {}) {
  let clock = 1_000_000
  let text = 'Running the tests'
  const steps: string[] = []
  const closeMember = vi.fn(async (id: string) => { steps.push(`close ${id}`); return { closed: true as const } })
  const core = fakeCore({
    agents: {
      byAgent: vi.fn((id: string) => (id === 'h1' ? { agentId: id } as never : undefined)),
      terminalAvailable: vi.fn(() => true),
      activity: vi.fn(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, (options.working?.() ?? true) ? 'working' as const : 'idle' as const]))),
      closeMember,
    },
    superTabs: { attention: vi.fn(), cards: vi.fn(), cardRecap: vi.fn(), shareObservers: vi.fn(), inputIfScreen: vi.fn(),
      screen: vi.fn(async () => options.screen?.() ?? { ok: true as const, text, hold: null }),
      input: vi.fn(async (_id: string, typed: string) => { steps.push(`type ${typed}`); return { ok: true as const } }) },
  })
  const log = vi.fn()
  const keeper = new CrewKeeper(core, 'm1', { now: () => clock, log, owns: async () => options.owns?.() ?? true })
  return { core, keeper, steps, log, closeMember, wait: (ms: number) => { clock += ms }, draw: (next: string) => { text = next } }
}

describe('which roster rows are crew this host keeps alive', () => {
  it('is a row whose agent is crew, not asleep and not moved', () => {
    expect(isCrewRow(row())).toBe(true)
    expect(isCrewRow(row({}, { crew: undefined }))).toBe(false)
    expect(isCrewRow(row({}, { crew: { role: '' } }))).toBe(false)
    expect(isCrewRow(row({}, { asleep: { since: 5 } }))).toBe(false)
    expect(isCrewRow(row({}, { movedTo: 'a2' }))).toBe(false)
    expect(isCrewRow({})).toBe(false)
  })
})

describe('a frozen crew session', () => {
  it('is closed once the engine has been working with an unchanged screen for 30 minutes, so its keep-alive reopens it', async () => {
    const t = setup()
    await t.keeper.tick([row()])
    t.wait(CREW_FROZEN_MS - 1)
    await t.keeper.tick([row()])
    expect(t.closeMember).not.toHaveBeenCalled()
    t.wait(1)
    await t.keeper.tick([row()])
    expect(t.steps).toEqual(['close h1'])
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining('froze'))
  })

  it('is not one whose screen moves, nor one idle at its prompt, nor one off the crew', async () => {
    const moving = setup()
    await moving.keeper.tick([row()])
    for (let i = 0; i < 40; i++) { moving.wait(CREW_LOOK_MS); moving.draw(`Running the tests ${i}s`); await moving.keeper.tick([row()]) }
    expect(moving.closeMember).not.toHaveBeenCalled()
    const idle = setup({ working: () => false })
    await idle.keeper.tick([row()])
    idle.wait(2 * CREW_FROZEN_MS)
    await idle.keeper.tick([row()])
    expect(idle.closeMember).not.toHaveBeenCalled()
    const ordinary = setup()
    await ordinary.keeper.tick([row({}, { crew: undefined })])
    ordinary.wait(2 * CREW_FROZEN_MS)
    await ordinary.keeper.tick([row({}, { crew: undefined })])
    expect(ordinary.closeMember).not.toHaveBeenCalled()
  })

  it('is never closed when its session is confidential: closing one deletes its data in a Team account', async () => {
    const t = setup()
    await t.keeper.tick([row({ confidential: true })])
    t.wait(2 * CREW_FROZEN_MS)
    await t.keeper.tick([row({ confidential: true })])
    expect(t.closeMember).not.toHaveBeenCalled()
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining('confidential'))
  })

  it('counts its 30 minutes again after the engine went idle', async () => {
    let working = true
    const t = setup({ working: () => working })
    await t.keeper.tick([row()])
    t.wait(CREW_FROZEN_MS - CREW_LOOK_MS)
    working = false
    await t.keeper.tick([row()])
    working = true
    t.wait(CREW_LOOK_MS)
    await t.keeper.tick([row()])
    expect(t.closeMember).not.toHaveBeenCalled()
  })
})

describe('a reopened crew session', () => {
  it('is told once to continue its task, only after no prompt waits on its screen', async () => {
    let hold: SuperTabScreen['hold'] = 'permission' as SuperTabScreen['hold']
    const t = setup({ working: () => false, screen: () => ({ ok: true, text: 'Allow?', hold } as SuperTabScreen) })
    t.keeper.reopened('h1')
    await t.keeper.tick([row()])
    expect(t.steps).toEqual([])
    hold = null
    t.wait(CREW_LOOK_MS)
    await t.keeper.tick([row()])
    expect(t.steps).toEqual([`type ${CREW_CONTINUE}`])
    t.wait(CREW_LOOK_MS)
    await t.keeper.tick([row()])
    expect(t.steps).toEqual([`type ${CREW_CONTINUE}`])
  })

  it('is told nothing when it holds no task here', async () => {
    const t = setup({ working: () => false, owns: () => false })
    t.keeper.reopened('h1')
    await t.keeper.tick([row()])
    t.wait(CREW_LOOK_MS)
    await t.keeper.tick([row()])
    expect(t.steps).toEqual([])
  })
})
