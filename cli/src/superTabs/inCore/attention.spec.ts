import { describe, expect, it, vi } from 'vitest'
import type { SuperTabAttention } from '../../core/api.js'
import { createSuperTabAttention } from './attention.js'

const wait = (agentId: string, over: Partial<SuperTabAttention> = {}): SuperTabAttention =>
  ({ agentId, requestId: `supertab:as-${agentId}:needs_human`, superTab: 'Pilot', attention: 'decision', text: 'Ship it?', ...over })
const raised = (item: SuperTabAttention) => ({ type: 'commander_question', agentId: item.agentId,
  payload: { requestId: item.requestId, questions: [{ q: item.text }], superTab: item.superTab, attention: item.attention } })
const closed = (item: SuperTabAttention) => ({ type: 'commander_question_close', agentId: item.agentId, payload: { requestId: item.requestId } })

function setup() {
  const send = vi.fn()
  const asking = new Set<string>()
  const log = vi.fn()
  const waits = createSuperTabAttention({ send, asking: (agentId) => asking.has(agentId), log })
  return { send, asking, log, waits }
}

describe('the Super Tab waits on the devices', () => {
  it('raises what is new, keeps what is unchanged and closes what is gone or changed', () => {
    const { send, waits, log } = setup()
    const a = wait('a1'), b = wait('a2', { attention: 'stuck', requestId: 'supertab:as-a2:blocked', text: 'Stuck: no key' })
    waits.attention([a, b])
    expect(send.mock.calls.map(([frame]) => frame)).toEqual([raised(a), raised(b)])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('waits on a person (stuck)'))
    send.mockClear()
    waits.attention([a, b])
    expect(send).not.toHaveBeenCalled()
    // A new reason is a new alert; a status that moved on closes it.
    const reworded = { ...a, text: 'Ship it today?' }
    waits.attention([reworded])
    expect(send.mock.calls.map(([frame]) => frame)).toEqual([closed(a), closed(b), raised(reworded)])
    send.mockClear()
    waits.attention('not a list')
    expect(send.mock.calls.map(([frame]) => frame)).toEqual([closed(reworded)])
  })

  it('refuses what a device could not show or close, and keeps one wait per agent', () => {
    const { send, waits } = setup()
    const bad = [null, 'x', { ...wait('a1'), agentId: 'bad id' }, { ...wait('a1'), agentId: 7 },
      { ...wait('a1'), requestId: 'tool-1' }, { ...wait('a1'), requestId: `supertab:${'x'.repeat(60)}` },
      { ...wait('a1'), superTab: 'x'.repeat(49) }, { ...wait('a1'), superTab: '' }, { ...wait('a1'), text: 'x'.repeat(1201) },
      { ...wait('a1'), attention: 'urgent' }]
    waits.attention(bad)
    expect(send).not.toHaveBeenCalled()
    const first = wait('a1'), second = wait('a1', { requestId: 'supertab:other:needs_human' })
    waits.attention([first, second, ...Array.from({ length: 70 }, (_, i) => wait(`b${i}`))])
    // The first for an agent, and at most 64 items.
    expect(send.mock.calls[0][0]).toEqual(raised(first))
    expect(send).toHaveBeenCalledTimes(63)
  })

  it('lets an engine\'s question come first, and shows the wait again once it closes', () => {
    const { send, asking, waits } = setup()
    const a = wait('a1')
    // Raised while the agent's own question is open: it waits for that question.
    asking.add('a1')
    waits.attention([a])
    expect(send).not.toHaveBeenCalled()
    waits.after({ type: 'commander_question_close', agentId: 'a1', payload: { requestId: 'tool-1' } })
    expect(send).toHaveBeenLastCalledWith(raised(a))
    asking.delete('a1')
    // An engine's question for it takes its place: closed before the question goes out.
    send.mockClear()
    waits.before({ type: 'commander_question', agentId: 'a1', payload: { requestId: 'tool-2' } })
    expect(send.mock.calls.map(([frame]) => frame)).toEqual([closed(a)])
    // Its own frames, other cards and other agents change nothing.
    send.mockClear()
    for (const frame of [raised(a), closed(a), { type: 'commander_event', agentId: 'a1', payload: { kind: 'done' } },
      { type: 'commander_question', payload: {} }, { type: 'commander_question', agentId: 'a9', payload: { requestId: 'tool-3' } },
      { type: 'commander_question_close', agentId: 'a9', payload: { requestId: 'tool-3' } }]) {
      waits.before(frame)
      waits.after(frame)
    }
    expect(send).not.toHaveBeenCalled()
    waits.before({ type: 'commander_question', agentId: 'a1', payload: { requestId: 'tool-4' } })
    expect(send).not.toHaveBeenCalled()
    waits.after({ type: 'commander_question_close', agentId: 'a1', payload: { requestId: 'tool-2' } })
    expect(send).toHaveBeenLastCalledWith(raised(a))
    send.mockClear()
    waits.after({ type: 'commander_question_close', agentId: 'a1', payload: { requestId: 'tool-2' } })
    expect(send).not.toHaveBeenCalled()
  })

  it('shows every wait again to a dial that attaches, after the engines\' questions', () => {
    const { send, asking, waits } = setup()
    const a = wait('a1'), b = wait('a2')
    waits.attention([a, b])
    send.mockClear()
    asking.add('a2')
    waits.replay()
    expect(send.mock.calls.map(([frame]) => frame)).toEqual([raised(a)])
    // Hidden behind a2's question, it is not closed when it goes.
    send.mockClear()
    waits.attention([a])
    expect(send).not.toHaveBeenCalled()
  })

  it('logs to the console by default', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      createSuperTabAttention({ send: () => {}, asking: () => false }).attention([wait('a1')])
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('[super-tabs] a1 waits on a person'))
    } finally { spy.mockRestore() }
  })
})
