import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { createCancel, createCancelRequest, type CancelDeps } from './cancel.js'

function setup(over: Partial<CancelDeps> = {}) {
  const calls: string[] = []
  const service = { turnEnded: vi.fn() }
  const deps: CancelDeps = {
    resolve: (id) => id === 'a1' ? ({ agentId: 'a1', sessionId: 's1' } as RegisteredSession) : undefined,
    normalizers: { closeTurns: vi.fn((sessionId: string) => { calls.push(`close ${sessionId}`) }) },
    cursorSubagents: { forget: vi.fn() },
    input: { cancel: vi.fn(), cancelConfirmed: vi.fn(async () => true) },
    device: () => service,
    stopHeartbeat: vi.fn(),
    questionWatcher: { stop: vi.fn() },
    mirror: { cancel: vi.fn() },
    turnActivity: { observe: vi.fn(), snapshot: vi.fn(() => ({ state: 'idle' as const, epoch: 'e', revision: 2, validForMs: 0 })) },
    turnStartedAt: new Map([['s1', 1]]),
    agentIdFor: (sessionId) => (sessionId === 's1' ? 'a1' : sessionId),
    clients: { send: vi.fn() },
    ...over,
  }
  return { deps, service, calls, cancelAgent: createCancel(deps) }
}

describe('cancelling a turn', () => {
  it('closes the turn everywhere and tells input, the device, the heartbeat, questions and the dial', async () => {
    const { deps, service, cancelAgent } = setup()
    expect(await cancelAgent('a1')).toBe(true)
    expect(deps.normalizers.closeTurns).toHaveBeenCalledWith('s1')
    expect(deps.cursorSubagents.forget).toHaveBeenCalledWith('s1')
    expect(deps.input.cancel).toHaveBeenCalledWith('a1')
    expect(deps.input.cancelConfirmed).not.toHaveBeenCalled()
    expect(service.turnEnded).toHaveBeenCalledWith('a1', true)
    expect(deps.stopHeartbeat).toHaveBeenCalledWith('s1')
    expect(deps.questionWatcher.stop).toHaveBeenCalledWith('s1')
    expect(deps.mirror.cancel).toHaveBeenCalledWith('s1')
  })

  it('tells every window the agent is idle now, without a turn_ended that would recap a killed turn', async () => {
    const { deps, cancelAgent } = setup()
    await cancelAgent('a1')
    expect(deps.turnStartedAt.has('s1')).toBe(false)
    expect(deps.turnActivity.observe).toHaveBeenCalledWith('s1', 'turn_ended')
    expect(deps.clients.send).toHaveBeenCalledTimes(1)
    expect(deps.clients.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent_activity', agentId: 'a1', payload: expect.objectContaining({ activity: expect.objectContaining({ state: 'idle' }) }),
    }))
    // An agent the tracker no longer knows has no activity to report.
    const unknown = setup({ turnActivity: { observe: vi.fn(), snapshot: vi.fn(() => undefined) } })
    await unknown.cancelAgent('a1')
    expect(unknown.deps.clients.send).not.toHaveBeenCalled()
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

  it('cancels by the id it was given when no agent has it, with or without a device', async () => {
    const { deps, service, cancelAgent } = setup()
    await cancelAgent('s9')
    expect(deps.normalizers.closeTurns).toHaveBeenCalledWith('s9')
    expect(deps.input.cancel).toHaveBeenCalledWith('s9')
    expect(service.turnEnded).toHaveBeenCalledWith('s9', true)
    const none = setup({ device: () => undefined })
    expect(await none.cancelAgent('a1')).toBe(true)
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
