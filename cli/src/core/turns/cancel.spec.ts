import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { createCancel, createCancelRequest, type CancelDeps } from './cancel.js'
import { createHeartbeats } from './heartbeats.js'

function setup(over: Partial<CancelDeps> = {}) {
  const calls: string[] = []
  const deps: CancelDeps = {
    resolve: (id) => id === 'a1' ? ({ agentId: 'a1', sessionId: 's1' } as RegisteredSession) : undefined,
    normalizers: { closeTurns: vi.fn((sessionId: string) => { calls.push(`close ${sessionId}`) }) },
    input: { cancel: vi.fn(), cancelConfirmed: vi.fn(async () => true) },
    stopHeartbeat: vi.fn(),
    questionWatcher: { stop: vi.fn() },
    mirror: { cancel: vi.fn() },
    turnActivity: { observe: vi.fn(() => { calls.push('observe') }) },
    turnStartedAt: new Map([['s1', 1]]),
    tell: vi.fn(() => { calls.push('tell') }),
    ...over,
  }
  return { deps, calls, cancelAgent: createCancel(deps) }
}

describe('cancelling a turn', () => {
  it('publishes the captured session cancel activity before confirmation without synthesizing a completed turn', async () => {
    let finish!: (ok: boolean) => void
    const sent = vi.fn()
    const beats = createHeartbeats({ bySession: () => undefined, sessionTurnOpen: () => false, agentIdFor: () => 'a1',
      runtimeActivity: { forget: vi.fn() }, turnActivity: { check: vi.fn(), forget: vi.fn(),
        snapshot: () => ({ epoch: 'core', revision: 8, state: 'idle', validForMs: 0 }) },
      mirror: { heartbeat: () => false }, clients: { send: sent }, turns: { beat: vi.fn() } })
    const f = setup({ tell: beats.tell, input: { cancel: vi.fn(), cancelConfirmed: () => new Promise(resolve => { finish = resolve }) } })
    const pending = f.cancelAgent('a1', true)
    expect(sent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'agent_activity', agentId: 'a1', dbSessionId: 's1',
      payload: expect.objectContaining({ cause: 'cancel', activity: { epoch: 'core', revision: 8, state: 'idle', validForMs: 0 } }) }))
    finish(false)
    expect(await pending).toBe(false)
    expect(sent).toHaveBeenCalledOnce()
  })
  it('closes the turn everywhere and tells input, the heartbeat, questions and the dial', async () => {
    const { deps, cancelAgent } = setup()
    expect(await cancelAgent('a1')).toBe(true)
    expect(deps.normalizers.closeTurns).toHaveBeenCalledWith('s1')
    expect(deps.input.cancel).toHaveBeenCalledWith('a1')
    expect(deps.input.cancelConfirmed).not.toHaveBeenCalled()
    expect(deps.stopHeartbeat).toHaveBeenCalledWith('s1')
    expect(deps.questionWatcher.stop).toHaveBeenCalledWith('s1')
    expect(deps.mirror.cancel).toHaveBeenCalledWith('s1')
  })

  it('tells every window the agent is idle now, without a turn_ended that would recap a killed turn', async () => {
    const { deps, calls, cancelAgent } = setup()
    await cancelAgent('a1')
    expect(deps.turnStartedAt.has('s1')).toBe(false)
    expect(deps.turnActivity.observe).toHaveBeenCalledWith('s1', 'turn_ended')
    expect(deps.tell).toHaveBeenCalledExactlyOnceWith('s1', 'cancel')
    expect(calls.slice(-2)).toEqual(['observe', 'tell'])
  })

  it('waits for input to confirm a cancel a stop depends on, and answers with what it said', async () => {
    const { deps, cancelAgent } = setup()
    vi.mocked(deps.input.cancelConfirmed).mockResolvedValueOnce(false)
    expect(await cancelAgent('a1', true)).toBe(false)
    expect(deps.input.cancelConfirmed).toHaveBeenCalledWith('a1')
    expect(deps.input.cancel).not.toHaveBeenCalled()
    await cancelAgent('s9', true)
    expect(deps.input.cancelConfirmed).toHaveBeenLastCalledWith('s9')
  })

  it('cancels by the id it was given when no agent has it', async () => {
    const { deps, cancelAgent } = setup()
    await cancelAgent('s9')
    expect(deps.normalizers.closeTurns).toHaveBeenCalledWith('s9')
    expect(deps.input.cancel).toHaveBeenCalledWith('s9')
  })
})

describe('a cancel frame', () => {
  it('interrupts the agent it names by agent id, or by session id, and takes a frame naming neither as nothing', () => {
    const cancel = vi.fn()
    const request = createCancelRequest(cancel)
    request({ agentId: 'a1', sessionId: 's1' })
    request({ sessionId: 's2' })
    request({ agentId: '' })
    request({})
    expect(cancel.mock.calls).toEqual([['a1'], ['s2']])
  })
})
