import { describe, expect, it, vi } from 'vitest'
import type { SuperTabScreen } from '../core/api.js'
import { fakeCore } from '../testing/fakeCore.js'
import { CREW_CONTINUE, CREW_CONTINUE_TRIES, CREW_FROZEN_MS, CREW_LOOK_MS, CrewKeeper, isCrewRow } from './crew.js'

// Task #3397: the host keeps a project's crew alive. A frozen crew session (the engine working, its whole screen still for
// 30 minutes) is closed so the keep-alive reopens it in place; a reopened one still holding its task is told to continue.

const crew = { role: 'Engineer', at: 1, by: 'pm' }
const row = (over: Record<string, unknown> = {}, agent: Record<string, unknown> = {}) =>
  ({ tabId: 'tab', active: true, agent: { id: 'a1', harnessId: 'h1', machineId: 'm1', crew, ...agent }, ...over })

/** A keeper on a fake core. The screen is [text] with [hold]; typing adds to it, and Enter goes through only on the screen
 *  the caller read (inputIfScreen, as the core's pane lock does). `still` is when the whole screen last changed, which the
 *  terminal watch records from its own reads. */
function setup(options: { working?: () => boolean; owns?: () => boolean; typing?: () => boolean; team?: boolean } = {}) {
  let clock = 1_000_000
  let text = '❯ '
  let hold: 'permission_open' | null = null
  let still: number | undefined = clock
  const steps: string[] = []
  const closeMember = vi.fn(async (id: string) => { steps.push(`close ${id}`); return { closed: true as const } })
  const activity = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, (options.working?.() ?? true) ? 'working' as const : 'idle' as const])))
  const screen = vi.fn(async (): Promise<SuperTabScreen> => ({ ok: true, text, hold }))
  const core = fakeCore({
    agents: {
      byAgent: vi.fn((id: string) => (['h1', 'h2'].includes(id) ? { agentId: id } as never : undefined)),
      terminalAvailable: vi.fn(() => true),
      activity,
      closeMember,
    },
    superTabs: { attention: vi.fn(), cards: vi.fn(), cardRecap: vi.fn(), shareObservers: vi.fn(), screen,
      input: vi.fn(async (_id: string, typed: string) => {
        if (options.typing && !options.typing()) return { ok: false as const, error: 'PANE_BUSY' }
        steps.push(`type ${typed}`); text = `❯ ${typed}`; return { ok: true as const }
      }),
      inputIfScreen: vi.fn(async (_id: string, keys: string[], seen: string) => {
        if (seen !== text || hold) return { ok: false as const, error: 'SCREEN_CHANGED' }
        steps.push(keys.join(' ')); text = '❯ '; return { ok: true as const }
      }) },
  })
  const log = vi.fn()
  const keeper = new CrewKeeper(core, 'm1', { now: () => clock, log, owns: async () => options.owns?.() ?? true, stillSince: () => still, team: () => options.team ?? false })
  return { core, keeper, steps, log, closeMember, activity, screen,
    wait: (ms: number) => { clock += ms },
    moved: () => { still = clock },
    prompt: (open: boolean) => { hold = open ? 'permission_open' : null; text = open ? 'Allow? 1. Yes 2. No' : text },
    show: (next: string) => { text = next },
    unknown: () => { still = undefined } }
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
    // Looked at once a minute: still 29 minutes in, frozen at 30.
    for (let i = 1; i < CREW_FROZEN_MS / CREW_LOOK_MS; i++) { t.wait(CREW_LOOK_MS); await t.keeper.tick([row()]) }
    expect(t.closeMember).not.toHaveBeenCalled()
    t.wait(CREW_LOOK_MS)
    await t.keeper.tick([row()])
    expect(t.steps).toEqual(['close h1'])
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining('froze'))
  })

  // Review of #3222 (ENGINEERING.md 4, the daemon's idle work): the keeper reads no screen of its own for this, and asks the
  // engines' activity once a minute for all its crew in one call, whatever the host's poll rate.
  it('reads no screen and asks activity once a minute for all crew in one call', async () => {
    const t = setup()
    const rows = [row(), row({}, { id: 'a2', harnessId: 'h2' })]
    for (let i = 0; i < 120; i++) { t.wait(1_000); await t.keeper.tick(rows) }
    expect(t.screen).not.toHaveBeenCalled()
    expect(t.activity.mock.calls).toEqual([[['h1', 'h2']], [['h1', 'h2']]])
  })

  it('is not one whose screen moves, nor one idle at its prompt, nor one off the crew, nor one never read', async () => {
    const moving = setup()
    await moving.keeper.tick([row()])
    for (let i = 0; i < 40; i++) { moving.wait(CREW_LOOK_MS); moving.moved(); await moving.keeper.tick([row()]) }
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
    const unread = setup()
    unread.unknown()
    await unread.keeper.tick([row()])
    unread.wait(2 * CREW_FROZEN_MS)
    await unread.keeper.tick([row()])
    expect(unread.closeMember).not.toHaveBeenCalled()
  })

  // Security review 1 of #3222: on a Team daemon a close is the Swarm's end for good, which deletes a Team-written Codex
  // session's own engine home (inCore/teamPurge.ts), so the reopen could not resume it. There it is left, and said once.
  it('is never closed on a Team daemon, where a close deletes what the reopen needs', async () => {
    const t = setup({ team: true })
    await t.keeper.tick([row()])
    for (let i = 0; i < 2 * CREW_FROZEN_MS / CREW_LOOK_MS; i++) { t.wait(CREW_LOOK_MS); await t.keeper.tick([row()]) }
    expect(t.closeMember).not.toHaveBeenCalled()
    expect(t.log.mock.calls.filter(([line]) => String(line).includes('Team account'))).toHaveLength(1)
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
    const t = setup({ working: () => false })
    t.prompt(true)
    t.keeper.reopened('h1')
    await t.keeper.tick([row()])
    expect(t.steps).toEqual([])
    t.prompt(false)
    t.wait(CREW_LOOK_MS)
    await t.keeper.tick([row()])
    expect(t.steps).toEqual([`type ${CREW_CONTINUE}`, 'Enter'])
    t.wait(CREW_LOOK_MS)
    await t.keeper.tick([row()])
    expect(t.steps).toEqual([`type ${CREW_CONTINUE}`, 'Enter'])
  })

  // Reviews of #3222: a prompt that opens between the screen read and the typing must never take the Enter.
  it('never sends Enter to a prompt that opened after its screen was read, and continues once it is answered', async () => {
    const t = setup({ working: () => false })
    t.keeper.reopened('h1')
    vi.mocked(t.core.superTabs!.input).mockImplementationOnce(async (_id, typed) => { t.steps.push(`type ${typed}`); t.prompt(true); return { ok: true } })
    await t.keeper.tick([row()])
    expect(t.steps).toEqual([`type ${CREW_CONTINUE}`])
    t.prompt(false)
    t.show(`❯ ${CREW_CONTINUE}`)
    t.wait(CREW_LOOK_MS)
    await t.keeper.tick([row()])
    // The text it typed already is not typed again: only the Enter.
    expect(t.steps).toEqual([`type ${CREW_CONTINUE}`, 'Enter'])
  })

  // Review of #3222: a typing that failed for a moment is tried again, a few times, never dropped at once.
  it('tries a continue that failed again, at most CREW_CONTINUE_TRIES times, and says once it gave up', async () => {
    let fails = 2
    const t = setup({ working: () => false, typing: () => fails-- <= 0 })
    t.keeper.reopened('h1')
    for (let i = 0; i < 3; i++) { await t.keeper.tick([row()]); t.wait(CREW_LOOK_MS) }
    expect(t.steps).toEqual([`type ${CREW_CONTINUE}`, 'Enter'])
    const never = setup({ working: () => false, typing: () => false })
    never.keeper.reopened('h1')
    for (let i = 0; i < CREW_CONTINUE_TRIES + 3; i++) { await never.keeper.tick([row()]); never.wait(CREW_LOOK_MS) }
    expect(vi.mocked(never.core.superTabs!.input)).toHaveBeenCalledTimes(CREW_CONTINUE_TRIES)
    expect(never.log.mock.calls.filter(([line]) => /gave up/i.test(String(line)))).toHaveLength(1)
  })

  // Review 2 of #3222: after a second crash the restored history shows the first continue; the composer is empty, so it is
  // typed again, never an Enter on an empty prompt.
  it('types the continue again when only the history shows it, never a bare Enter', async () => {
    const t = setup({ working: () => false })
    t.show(`❯ ${CREW_CONTINUE}\n\n⏺ Picking the task up again.\n\n${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  ? for shortcuts`)
    t.keeper.reopened('h1')
    await t.keeper.tick([row()])
    expect(t.steps).toEqual([`type ${CREW_CONTINUE}`, 'Enter'])
  })

  // Review 2 of #3222: a terminal gone for a moment keeps the continue owed while the roster names the crew member.
  it('keeps the continue owed while its terminal is away for a moment', async () => {
    let away = true
    const t = setup({ working: () => false })
    vi.mocked(t.core.agents.terminalAvailable).mockImplementation(() => !away)
    t.keeper.reopened('h1')
    await t.keeper.tick([row()])
    expect(t.steps).toEqual([])
    away = false
    t.wait(CREW_LOOK_MS)
    await t.keeper.tick([row()])
    expect(t.steps).toEqual([`type ${CREW_CONTINUE}`, 'Enter'])
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
