import { describe, expect, it, vi } from 'vitest'
import type { LastTurnText } from '../../engines/kit/events.js'
import { promptHash } from '../../lib/promptIdentity.js'
import type { TurnEnd } from '../api.js'
import { ANSWER_KEEP_MAX, createTurnEnds } from './ends.js'

const PROMPT = promptHash('Ship it.')
const end: TurnEnd = { agentId: 'agent', sessionId: 'session', aborted: false, prompt: PROMPT }
const told = { agentId: 'agent', sessionId: 'session', aborted: false }

/** A core with an engine transcript that holds [last], and the turn ends it tells. */
function setup(last: LastTurnText | null = null, over: Partial<Parameters<typeof createTurnEnds>[0]> = {}) {
  const lastTurn = vi.fn(async (_sessionId: string) => last)
  const tell = vi.fn()
  const ends = createTurnEnds({ hearers: new Set(), tell, lastTurn, ...over })
  /** One whole live turn in [sessionId]: its prompt, what it said (a string) or a tool it called (null), and its end. */
  const turn = (prompt: string, steps: Array<string | null>, sessionId = 'session', aborted = false) => {
    ends.started(sessionId, prompt, false)
    for (const step of steps) step === null ? ends.worked(sessionId) : ends.said(sessionId, step)
    ends.ended({ agentId: 'agent', sessionId, aborted })
  }
  return { ends, lastTurn, tell, turn }
}

describe('live turn ends', () => {
  it('tells every listener each end, with the prompt of the turn that ended, until it stops hearing', () => {
    const { ends, turn } = setup()
    const first = vi.fn(), second = vi.fn()
    const stop = ends.onEnd(first)
    ends.onEnd(second)
    turn('Ship it.', [])
    stop()
    turn('Ship it.', [], 'session', true)
    expect(first.mock.calls).toEqual([[end]])
    expect(second.mock.calls).toEqual([[end], [{ ...end, aborted: true }]])
  })

  it('tells each service in its own process that wants them, and no other', () => {
    const tell = vi.fn()
    const { turn } = setup(null, { hearers: new Set(['superTabs', 'other']), tell })
    turn('Ship it.', [])
    expect(tell.mock.calls).toEqual([['superTabs', end], ['other', end]])
    const none = vi.fn()
    setup(null, { hearers: new Set(), tell: none }).turn('Ship it.', [])
    expect(none).not.toHaveBeenCalled()
  })

  it('costs a listener that throws its own end only, never another listener or the funnel that said it', () => {
    const log = vi.fn(), tell = vi.fn()
    const { ends, turn } = setup(null, { hearers: new Set(['superTabs']), tell, log })
    const after = vi.fn()
    ends.onEnd(() => { throw new Error('boom') })
    ends.onEnd(after)
    ends.onEnd(() => { throw 'not an error' })
    expect(() => turn('Ship it.', [])).not.toThrow()
    expect(after).toHaveBeenCalledOnce()
    expect(tell).toHaveBeenCalledOnce()
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      '[turns] a turn-end listener failed on agent · boom',
      '[turns] a turn-end listener failed on agent · not an error',
    ])
  })

  it('says it on the console unless told where to log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ends, turn } = setup()
    ends.onEnd(() => { throw new Error('boom') })
    turn('Ship it.', [])
    expect(warn).toHaveBeenCalledWith('[turns] a turn-end listener failed on agent · boom')
    warn.mockRestore()
  })

  it('tells no end whose start it never saw: nobody can say which turn it was', () => {
    const { ends } = setup()
    const heard = vi.fn()
    ends.onEnd(heard)
    ends.said('session', 'Shipped.')
    ends.ended(told)
    expect(heard).not.toHaveBeenCalled()
    // A turn is told once: its end closes it.
    ends.started('session', 'Ship it.', false)
    ends.ended(told)
    ends.ended(told)
    expect(heard).toHaveBeenCalledOnce()
  })
})

describe('the answer of a turn that ended, kept as it was said', () => {
  it('is what was said after its last tool call, joined, each text trimmed, without the empty ones', async () => {
    const { ends, turn, lastTurn } = setup()
    turn('Ship it.', ['Let me look.', null, '  Found it.  ', '', '   ', 'And fixed it.\n'])
    expect(await ends.answerOf('session', PROMPT)).toBe('Found it.\n\nAnd fixed it.')
    expect(lastTurn).not.toHaveBeenCalled()
  })

  it('is what it said before its tool calls when it said nothing after them', async () => {
    const { ends, turn } = setup()
    turn('Ship it.', ['Let me look.', null, 'Then this.', null])
    expect(await ends.answerOf('session', PROMPT)).toBe('Let me look.\n\nThen this.')
  })

  it('keeps no more of an answer than one message takes and a character over, so its reader can tell it was cut', async () => {
    const { ends, turn } = setup()
    turn('Ship it.', ['a'.repeat(ANSWER_KEEP_MAX), 'b'.repeat(500)])
    const answer = (await ends.answerOf('session', PROMPT))!
    expect(answer).toBe('a'.repeat(ANSWER_KEEP_MAX))
    const narrated = setup()
    narrated.turn('Ship it.', ['c'.repeat(ANSWER_KEEP_MAX), 'd'.repeat(500), null])
    expect(await narrated.ends.answerOf('session', PROMPT)).toBe('c'.repeat(ANSWER_KEEP_MAX))
  })

  it('is the answer of its own turn when a queued follow-up that began at once ended after it', async () => {
    const { ends, turn, lastTurn } = setup({ userMessage: 'Then this.', assistantText: 'Narration of the second.' })
    turn('Ship it.', ['Shipped.'])
    ends.started('session', 'Then this.', false)
    ends.said('session', 'Let me check the logs.')
    // The second one is at work, the first one's end is only now being read: its own answer, never the second's text.
    expect(await ends.answerOf('session', PROMPT)).toBe('Shipped.')
    ends.worked('session')
    ends.said('session', 'All done.')
    ends.ended(told)
    expect(await ends.answerOf('session', promptHash('Then this.'))).toBe('All done.')
    expect(await ends.answerOf('session', PROMPT)).toBe('Shipped.')
    expect(lastTurn).not.toHaveBeenCalled()
  })

  it('keeps the answers of the last few turns of a session, and asks the transcript for an older one', async () => {
    const { ends, turn, lastTurn } = setup()
    for (let i = 0; i < 5; i++) turn(`Turn ${i}`, [`Answer ${i}`])
    expect(await ends.answerOf('session', promptHash('Turn 4'))).toBe('Answer 4')
    expect(await ends.answerOf('session', promptHash('Turn 1'))).toBe('Answer 1')
    expect(lastTurn).not.toHaveBeenCalled()
    expect(await ends.answerOf('session', promptHash('Turn 0'))).toBeNull()
    expect(lastTurn).toHaveBeenCalledOnce()
  })

  it('keeps the sessions it has seen last, and forgets the oldest of many', async () => {
    const { ends, turn, lastTurn } = setup()
    for (let i = 0; i < 70; i++) turn('Ship it.', [`Answer ${i}`], `session-${i}`)
    expect(await ends.answerOf('session-69', PROMPT)).toBe('Answer 69')
    expect(await ends.answerOf('session-5', PROMPT)).toBeNull()
    expect(await ends.answerOf('session-6', PROMPT)).toBe('Answer 6')
    expect(lastTurn).toHaveBeenCalledOnce()
  })

  it('is told by the transcript when it saw the turn only from where a daemon picked it up, if that turn is the one asked', async () => {
    const { ends, lastTurn } = setup({ userMessage: 'Ship it.', assistantText: '  The whole answer, from the first word.  ' })
    // A restart in the middle of a turn: what was said before it is not known, so what is seen of it is no answer.
    ends.started('session', 'Ship it.', true)
    ends.said('session', 'its last words')
    const heard = vi.fn()
    ends.onEnd(heard)
    ends.ended(told)
    expect(heard).toHaveBeenCalledWith(end)
    expect(await ends.answerOf('session', PROMPT)).toBe('The whole answer, from the first word.')
    expect(lastTurn).toHaveBeenCalledWith('session')
  })

  it('is told by the transcript when it saw no text of the turn, and by nobody when the transcript\'s last turn is another', async () => {
    const empty = setup({ userMessage: 'Ship it.', assistantText: 'From the transcript.' })
    empty.turn('Ship it.', [null])
    expect(await empty.ends.answerOf('session', PROMPT)).toBe('From the transcript.')
    const other = setup({ userMessage: 'Something else.', assistantText: 'Not its answer.' })
    other.turn('Ship it.', [])
    expect(await other.ends.answerOf('session', PROMPT)).toBeNull()
    const nothing = setup(null)
    nothing.turn('Ship it.', [])
    expect(await nothing.ends.answerOf('session', PROMPT)).toBeNull()
    const blank = setup({ userMessage: 'Ship it.', assistantText: ' \n ' })
    blank.turn('Ship it.', [])
    expect(await blank.ends.answerOf('session', PROMPT)).toBeNull()
    expect(await blank.ends.answerOf('another-session', PROMPT)).toBeNull()
  })

  it('cuts what the transcript gives as it cuts what it saw, and fails as the transcript fails', async () => {
    const long = setup({ userMessage: 'Ship it.', assistantText: 'x'.repeat(ANSWER_KEEP_MAX + 100) })
    long.ends.started('session', 'Ship it.', true)
    long.ends.ended(told)
    expect(await long.ends.answerOf('session', PROMPT)).toBe('x'.repeat(ANSWER_KEEP_MAX))
    const broken = setup(null)
    broken.lastTurn.mockRejectedValueOnce(new Error('transcript unreadable'))
    await expect(broken.ends.answerOf('session', PROMPT)).rejects.toThrow('transcript unreadable')
  })

  it('forgets a turn that never ended when its session starts another, and says nothing of text with no turn open', async () => {
    const { ends, turn } = setup()
    ends.said('session', 'Said before any turn began.')
    ends.worked('session')
    ends.started('session', 'Lost.', false)
    ends.said('session', 'Never ended.')
    turn('Ship it.', ['Shipped.'])
    expect(await ends.answerOf('session', PROMPT)).toBe('Shipped.')
    expect(await ends.answerOf('session', promptHash('Lost.'))).toBeNull()
  })

  it('keeps only so many turns open at once, the ones seen last', () => {
    const { ends } = setup()
    const heard = vi.fn()
    ends.onEnd(heard)
    for (let i = 0; i < 70; i++) ends.started(`session-${i}`, 'Ship it.', false)
    for (let i = 0; i < 70; i++) ends.ended({ ...told, sessionId: `session-${i}` })
    expect(heard).toHaveBeenCalledTimes(64)
    expect(heard.mock.calls[0]![0].sessionId).toBe('session-6')
  })
})
