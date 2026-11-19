import { readFileSync } from 'node:fs'
import { readInlineScreen } from '../../testing/inlineScreen.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { activityRuntimeKey } from '../../lib/runtimeActivity.js'
import type { ActivityFrame } from '../../lib/turnActivity.js'
import { activityOf, createTurnActivity, type TurnActivityDeps } from './activity.js'

const live = { agentId: 'a1', sessionId: 's1', engine: 'claude', active: true } as RegisteredSession
const idle = { agentId: 'a2', sessionId: 's2', engine: 'claude', active: false } as RegisteredSession
const shell = { agentId: 'a3', sessionId: 's3', engine: 'terminal', active: true } as RegisteredSession
const claw = { agentId: 'a4', sessionId: 's4', engine: 'openclaw', active: true } as RegisteredSession
const sessions = new Map([[live.sessionId, live], [idle.sessionId, idle], [shell.sessionId, shell], [claw.sessionId, claw]])
const pane = (name: string) => readFileSync(new URL(`../../engines/openclaw/__fixtures__/screen-${name}.txt`, import.meta.url), 'utf8')
const running = (seconds: number) => pane('running-quiet').replace('• 45s', `• ${seconds}s`)

function setup(over: Partial<TurnActivityDeps> = {}) {
  const deps: TurnActivityDeps = {
    readScreen: readInlineScreen,
    terminals: { capture: vi.fn(async () => ({ state: 'succeeded' as const, value: 'screen' })) },
    bySession: (sessionId) => sessions.get(sessionId),
    sessionTurnOpen: (sessionId) => sessionId === 's1',
    drain: vi.fn(async () => {}),
    nativeActivity: vi.fn(async () => 'idle' as const),
    withheld: () => false,
    atWork: () => false,
    ...over,
  }
  return { deps, readers: createTurnActivity(deps) }
}

/** What a reader was constructed with. */
const given = (reader: object) => (reader as unknown as { deps: Record<string, (...args: unknown[]) => unknown> }).deps

describe('turn activity', () => {
  afterEach(() => vi.restoreAllMocks())

  it('checks only an active session, keyed to the runtime that runs it', async () => {
    const { deps, readers } = setup()
    const turn = given(readers.turnActivity)
    expect(turn.runtime('s1')).toEqual({ key: activityRuntimeKey(live), turnOpen: true, withheld: false })
    expect(turn.runtime('s2')).toBeUndefined()
    expect(turn.runtime('nobody')).toBeUndefined()
    await turn.drain('s1')
    expect(deps.drain).toHaveBeenCalledWith('s1')
    const read = vi.spyOn(readers.runtimeActivity, 'read').mockResolvedValue('working')
    expect(await turn.probe('s1')).toBe('working')
    expect(read).toHaveBeenCalledWith(live)
    expect(await turn.probe('s2')).toBe('unknown')
  })

  it('while withheld the probe answers unknown and reads no pane', async () => {
    const { readers } = setup({ withheld: (sessionId) => sessionId === 's1' })
    const turn = given(readers.turnActivity)
    expect(turn.runtime('s1')).toEqual({ key: activityRuntimeKey(live), turnOpen: true, withheld: true })
    const read = vi.spyOn(readers.runtimeActivity, 'read').mockResolvedValue('working')
    expect(await turn.probe('s1')).toBe('unknown')
    expect(read).not.toHaveBeenCalled()
  })

  it('while at work the probe answers working and reads no pane; withheld wins', async () => {
    let withheld = false
    const { readers } = setup({ withheld: () => withheld, atWork: (sessionId) => sessionId === 's1' })
    const turn = given(readers.turnActivity)
    const read = vi.spyOn(readers.runtimeActivity, 'read').mockResolvedValue('idle')
    expect(await turn.probe('s1')).toBe('working')
    expect(read).not.toHaveBeenCalled()
    withheld = true
    expect(await turn.probe('s1')).toBe('unknown')
    expect(read).not.toHaveBeenCalled()
  })

  it('neither withheld nor at work, the probe reads the pane', async () => {
    const { readers } = setup()
    const turn = given(readers.turnActivity)
    const read = vi.spyOn(readers.runtimeActivity, 'read').mockResolvedValue('idle')
    expect(await turn.probe('s1')).toBe('idle')
    expect(read).toHaveBeenCalledWith(live)
  })

  it('reads Codex\'s activity from its own server (through its worker), and every other runtime from what its pane shows', async () => {
    const { deps, readers } = setup()
    const runtime = given(readers.runtimeActivity)
    expect(await runtime.codex(live)).toBe('idle')
    expect(deps.nativeActivity).toHaveBeenCalledWith(live)
    expect(await runtime.capture(live)).toBe('screen')
    expect(deps.terminals.capture).toHaveBeenCalledWith(live, { mode: 'visible', ansi: true })
    vi.mocked(deps.terminals.capture).mockResolvedValueOnce({ state: 'failed', reason: 'no pane' })
    expect(await runtime.capture(live)).toBeNull()
  })

  it('a pane the binding pass read shows a moving OpenClaw timer as working with no turn open; a ready pane changes nothing', async () => {
    const { deps, readers } = setup()
    await readers.paneRead(claw, running(41))
    expect(readers.turnActivity.snapshot('s4')?.state).toBe('idle')
    await readers.paneRead(claw, running(46))
    expect(readers.turnActivity.snapshot('s4')?.state).toBe('working')
    await readers.paneRead(claw, pane('plain'))
    await readers.paneRead(claw, pane('plain'))
    expect(readers.turnActivity.snapshot('s4')?.state).toBe('working')
    expect(deps.terminals.capture).not.toHaveBeenCalled()
  })

  // Final review: the pass's capture was taken before the drain that delivered the run's end, so its timer, changed
  // since the last pass, read as working for the 30 s lease after the answer was there.
  it('a run\'s end drained after the binding pass captured its pane wins over that capture\'s timer', async () => {
    let endOnDrain = false
    const { readers } = setup({ drain: vi.fn(async () => {
      if (endOnDrain) { endOnDrain = false; readers.turnActivity.observe('s4', 'turn_ended') }
    }) })
    await readers.paneRead(claw, running(41))
    readers.turnActivity.observe('s4', 'text_delta')
    endOnDrain = true
    await readers.paneRead(claw, running(46))
    expect(readers.turnActivity.snapshot('s4')?.state).toBe('idle')
  })

  it('a run\'s end observed after the revision the caller read before capturing wins over that capture\'s timer', async () => {
    const { readers } = setup()
    await readers.paneRead(claw, running(41))
    readers.turnActivity.observe('s4', 'text_delta')
    const revision = readers.turnActivity.snapshot('s4')!.revision
    readers.turnActivity.observe('s4', 'turn_ended')
    await readers.paneRead(claw, running(46), revision)
    expect(readers.turnActivity.snapshot('s4')?.state).toBe('idle')
  })

  // Final review: every pass's read of a bound OpenClaw pane cost two store polls and a screen read.
  it('a pane the binding pass read polls nothing while a turn is open, which the heartbeat probes, or while no run shows', async () => {
    let open = true
    const readScreen = vi.fn(readInlineScreen)
    const { deps, readers } = setup({ readScreen, sessionTurnOpen: (sessionId) => sessionId === 's4' && open })
    await readers.paneRead(claw, running(41))
    open = false
    await readers.paneRead(claw, pane('plain'))
    expect(deps.drain).not.toHaveBeenCalled()
    expect(readScreen).not.toHaveBeenCalled()
  })

  it('a pane with no run forgets the run read before it: the next run\'s first timer is not compared with it', async () => {
    const { readers } = setup()
    await readers.paneRead(claw, running(41))
    await readers.paneRead(claw, pane('plain'))
    await readers.paneRead(claw, running(46))
    expect(readers.turnActivity.snapshot('s4')?.state).toBe('idle')
    await readers.paneRead(claw, running(47))
    expect(readers.turnActivity.snapshot('s4')?.state).toBe('working')
  })

  it('a pane the binding pass read claims nothing while withheld', async () => {
    const { readers } = setup({ withheld: () => true })
    await readers.paneRead(claw, running(41))
    await readers.paneRead(claw, running(46))
    expect(readers.turnActivity.snapshot('s4')?.state).toBe('idle')
  })

  it('reports the working state of the live agents asked about, and leaves out those that are not live', () => {
    const frames: Record<string, ActivityFrame | null> = { a1: { state: 'working' } as ActivityFrame, a3: null }
    const byAgent = (id: string) => [live, shell].find((s) => s.agentId === id)
    expect(activityOf(['a1', 'a3', 'gone'], byAgent, (s) => frames[s.agentId] ?? null)).toEqual({ a1: 'working', a3: 'unknown' })
    expect(activityOf(['a3'], byAgent, () => null)).toEqual({ a3: 'unknown' })
    expect(activityOf([], byAgent, () => null)).toEqual({})
  })

  it('shows the app an agent\'s activity, and none for a plain terminal', () => {
    const { readers } = setup()
    const frame = { state: 'working' } as ActivityFrame
    const snapshot = vi.spyOn(readers.turnActivity, 'snapshot').mockReturnValueOnce(frame).mockReturnValueOnce(undefined)
    expect(readers.activityFrame(live)).toBe(frame)
    expect(readers.activityFrame(live)).toBeNull()
    expect(readers.activityFrame(shell)).toBeNull()
    expect(snapshot).toHaveBeenCalledTimes(2)
  })
})
