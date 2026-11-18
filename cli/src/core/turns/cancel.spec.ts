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
    expect(deps.input.cancelConfirmed).toHaveBeenCalledWith('a1', expect.any(Function))
    expect(deps.input.cancel).not.toHaveBeenCalled()
    await cancelAgent('s9', true)
    expect(deps.input.cancelConfirmed).toHaveBeenLastCalledWith('s9', expect.any(Function))
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

describe('acknowledged cancellation', () => {
  it.each([true, false])('answers the actual confirmed result %s through the existing request', async ok => {
    const cancel = vi.fn(async (_id: string, _confirmed = false, _current = () => true) => ok), reply = vi.fn()
    const request = createCancelRequest(cancel), current = () => true
    await request({ agentId: 'a1', requestId: 'cancel-1' }, reply, current)
    expect(cancel).toHaveBeenCalledExactlyOnceWith('a1', true, current)
    expect(reply).toHaveBeenCalledExactlyOnceWith({ ok })
  })

  it('refuses stale caller authority before any turn metadata is changed', async () => {
    const { cancelAgent, deps, calls } = setup()
    expect(await cancelAgent('a1', true, () => false)).toBe(false)
    expect(calls).toEqual([])
    expect(deps.input.cancelConfirmed).not.toHaveBeenCalled()
    expect(deps.turnStartedAt.has('s1')).toBe(true)
  })

  it('passes caller authority to the key and refuses a stale confirmation', async () => {
    let active = true, finish!: (ok: boolean) => void
    const current = () => active, stop = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const { cancelAgent, deps } = setup({ input: { cancel: vi.fn(), cancelConfirmed: stop } })
    const pending = cancelAgent('a1', true, current)
    expect(stop).toHaveBeenCalledExactlyOnceWith('a1', current)
    expect(deps.turnStartedAt.has('s1')).toBe(false)
    active = false; finish(true)
    expect(await pending).toBe(false)
  })
})

describe('cancel request refusals and compatibility', () => {
  it('keeps legacy empty and session-id requests one-way without requiring a reply', () => {
    const cancel = vi.fn()
    const request = createCancelRequest(cancel)
    request({}); request({ sessionId: 'session' })
    expect(cancel.mock.calls).toEqual([['session']])
  })
  it.each([null, false, 0, '', 'r'.repeat(129)])('rejects an invalid confirmation id %j', async requestId => {
    const cancel = vi.fn(), reply = vi.fn()
    await createCancelRequest(cancel)({ agentId: 'a', requestId }, reply)
    expect(reply).toHaveBeenCalledExactlyOnceWith({ error: 'INVALID_REQUEST' }); expect(cancel).not.toHaveBeenCalled()
  })
  it.each([{}, { agentId: 9 }, { agentId: 'a'.repeat(201) }])('rejects an invalid target %j', async target => {
    const cancel = vi.fn(), reply = vi.fn()
    await createCancelRequest(cancel)({ ...target, requestId: 'r' }, reply)
    expect(reply).toHaveBeenCalledExactlyOnceWith({ error: 'INVALID_REQUEST' }); expect(cancel).not.toHaveBeenCalled()
  })
  it('refuses stale request authority before validation, and accepts a bounded session id with default authority', async () => {
    const cancel = vi.fn(async () => true), reply = vi.fn(), request = createCancelRequest(cancel)
    await request({ agentId: 'a', requestId: 'r' }, reply, () => false)
    expect(cancel).not.toHaveBeenCalled(); expect(reply).not.toHaveBeenCalled()
    await request({ sessionId: 's', requestId: 'r' }, reply)
    expect(reply).toHaveBeenCalledWith({ ok: true })
    await request({ sessionId: 's', requestId: 'r' })
  })
  it.each(['throw', 'reject', 'void'] as const)('reports %s without uncaught failures or invented success', async failure => {
    const reply = vi.fn(), request = createCancelRequest(() => {
      if (failure === 'throw') throw new Error('private')
      if (failure === 'reject') return Promise.reject(new Error('private'))
    })
    await request({ agentId: 'a', requestId: 'r' }, reply)
    expect(reply).toHaveBeenCalledExactlyOnceWith(failure === 'void' ? { ok: false } : { ok: false, error: 'CANCEL_UNAVAILABLE' })
  })
  it.each([true, false])('suppresses a stale %s completion', async success => {
    let active = true, resolve!: (ok: boolean) => void, reject!: (error: Error) => void
    const reply = vi.fn(), request = createCancelRequest(() => new Promise((done, fail) => { resolve = done; reject = fail }))
    const pending = request({ agentId: 'a', requestId: 'r' }, reply, () => active)
    active = false; if (success) resolve(true); else reject(new Error('private'))
    await pending; expect(reply).not.toHaveBeenCalled()
  })
})
