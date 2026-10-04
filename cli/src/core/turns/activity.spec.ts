import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { activityRuntimeKey } from '../../lib/runtimeActivity.js'
import type { ActivityFrame } from '../../lib/turnActivity.js'
import { createTurnActivity, type TurnActivityDeps } from './activity.js'

const live = { agentId: 'a1', sessionId: 's1', engine: 'claude', active: true } as RegisteredSession
const idle = { agentId: 'a2', sessionId: 's2', engine: 'claude', active: false } as RegisteredSession
const shell = { agentId: 'a3', sessionId: 's3', engine: 'terminal', active: true } as RegisteredSession
const sessions = new Map([[live.sessionId, live], [idle.sessionId, idle], [shell.sessionId, shell]])

function setup(over: Partial<TurnActivityDeps> = {}) {
  const deps: TurnActivityDeps = {
    terminals: { capture: vi.fn(async () => ({ state: 'succeeded' as const, value: 'screen' })) },
    bySession: (sessionId) => sessions.get(sessionId),
    sessionTurnOpen: (sessionId) => sessionId === 's1',
    drain: vi.fn(async () => {}),
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
    expect(turn.runtime('s1')).toEqual({ key: activityRuntimeKey(live), turnOpen: true })
    expect(turn.runtime('s2')).toBeUndefined()
    expect(turn.runtime('nobody')).toBeUndefined()
    await turn.drain('s1')
    expect(deps.drain).toHaveBeenCalledWith('s1')
    const read = vi.spyOn(readers.runtimeActivity, 'read').mockResolvedValue('working')
    expect(await turn.probe('s1')).toBe('working')
    expect(read).toHaveBeenCalledWith(live)
    expect(await turn.probe('s2')).toBe('unknown')
  })

  it('reads Codex\'s activity from Codex, and every other runtime from what its pane shows', async () => {
    const { deps, readers } = setup()
    const runtime = given(readers.runtimeActivity)
    const codex = vi.spyOn(readers.codexActivity, 'read').mockResolvedValue('idle' as never)
    expect(await runtime.codex(live)).toBe('idle')
    expect(codex).toHaveBeenCalledWith(live)
    expect(await runtime.capture(live)).toBe('screen')
    expect(deps.terminals.capture).toHaveBeenCalledWith(live, { mode: 'visible', ansi: true })
    vi.mocked(deps.terminals.capture).mockResolvedValueOnce({ state: 'failed', reason: 'no pane' })
    expect(await runtime.capture(live)).toBeNull()
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
