import { describe, expect, it, vi } from 'vitest'
import type { TurnEnd } from '../api.js'
import { createTurnEnds } from './ends.js'

const end: TurnEnd = { agentId: 'agent', sessionId: 'session', aborted: false }

describe('live turn ends', () => {
  it('tells every listener each end, until it stops hearing', () => {
    const ends = createTurnEnds({ hearers: new Set(), tell: vi.fn() })
    const first = vi.fn(), second = vi.fn()
    const stop = ends.onEnd(first)
    ends.onEnd(second)
    ends.ended(end)
    stop()
    ends.ended({ ...end, aborted: true })
    expect(first.mock.calls).toEqual([[end]])
    expect(second.mock.calls).toEqual([[end], [{ ...end, aborted: true }]])
  })

  it('tells each service in its own process that wants them, and no other', () => {
    const tell = vi.fn()
    const ends = createTurnEnds({ hearers: new Set(['superTabs', 'other']), tell })
    ends.ended(end)
    expect(tell.mock.calls).toEqual([['superTabs', end], ['other', end]])
    const none = vi.fn()
    createTurnEnds({ hearers: new Set(), tell: none }).ended(end)
    expect(none).not.toHaveBeenCalled()
  })

  it('costs a listener that throws its own end only, never another listener or the funnel that said it', () => {
    const log = vi.fn(), tell = vi.fn()
    const ends = createTurnEnds({ hearers: new Set(['superTabs']), tell, log })
    const after = vi.fn()
    ends.onEnd(() => { throw new Error('boom') })
    ends.onEnd(after)
    ends.onEnd(() => { throw 'not an error' })
    expect(() => ends.ended(end)).not.toThrow()
    expect(after).toHaveBeenCalledOnce()
    expect(tell).toHaveBeenCalledOnce()
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      '[turns] a turn-end listener failed on agent · boom',
      '[turns] a turn-end listener failed on agent · not an error',
    ])
  })

  it('says it on the console unless told where to log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ends = createTurnEnds({ hearers: new Set(), tell: vi.fn() })
    ends.onEnd(() => { throw new Error('boom') })
    ends.ended(end)
    expect(warn).toHaveBeenCalledWith('[turns] a turn-end listener failed on agent · boom')
    warn.mockRestore()
  })
})
