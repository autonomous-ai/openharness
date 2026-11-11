import { describe, expect, it, vi } from 'vitest'
import type { LastTurnText } from '../../engines/kit/events.js'
import { promptHash } from '../../lib/promptIdentity.js'
import type { TurnEnd } from '../api.js'
import { ANSWER_KEEP_MAX, createTurnEnds } from './ends.js'

const PROMPT = promptHash('Ship it.')
/** The end of the first turn a core tells, which is told as turn 1. */
const end: TurnEnd = { agentId: 'agent', sessionId: 'session', aborted: false, prompt: PROMPT, turnId: 1 }
const told = { agentId: 'agent', sessionId: 'session', aborted: false }

/** A core with an engine transcript that holds [last], and the turn ends it tells. */
function setup(last: LastTurnText | null = null, over: Partial<Parameters<typeof createTurnEnds>[0]> = {}) {
  const lastTurn = vi.fn(async (_sessionId: string) => last)
  const tell = vi.fn()
  const ends = createTurnEnds({ hearers: new Set(), tell, lastTurn, ...over })
  const heard: TurnEnd[] = []
  ends.onEnd(event => { heard.push(event) })
  /** One whole live turn in [sessionId]: its prompt, what it said (a string) or a tool it called (null), and its end, as told. */
  const turn = (prompt: string, steps: Array<string | null>, sessionId = 'session', aborted = false): TurnEnd => {
    ends.started(sessionId, prompt, false)
    for (const step of steps) step === null ? ends.worked(sessionId) : ends.said(sessionId, step)
    ends.ended({ agentId: 'agent', sessionId, aborted })
    return heard.at(-1)!
  }
  /** What the turn that ended [event] said, asked as its host asks. */
  const answer = (event: TurnEnd) => ends.answerOf(event)
  return { ends, lastTurn, tell, turn, heard, answer }
}

describe('live turn ends', () => {
  it('tells every listener each end, with the prompt of the turn that ended and the number of the turn, until it stops hearing', () => {
    const { ends, turn } = setup()
    const first = vi.fn(), second = vi.fn()
    const stop = ends.onEnd(first)
    ends.onEnd(second)
    turn('Ship it.', [])
    stop()
    turn('Ship it.', [], 'session', true)
    expect(first.mock.calls).toEqual([[end]])
    expect(second.mock.calls).toEqual([[end], [{ ...end, aborted: true, turnId: 2 }]])
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
    const { ends, heard } = setup()
    ends.said('session', 'Shipped.')
    ends.ended(told)
    expect(heard).toEqual([])
    // A turn is told once: its end closes it.
    ends.started('session', 'Ship it.', false)
    ends.ended(told)
    ends.ended(told)
    expect(heard).toHaveLength(1)
  })

  // Swarm plan, step 1, item 2: "Harness types it once after a compaction" (superTabs/nextThing.ts). An agent whose context was
  // compacted has a summary of what it was told, no more: the end of the turn it was compacted in says so, or of its next turn when
  // it was compacted between turns (`/compact` at its prompt).
  it('says the end of a turn its context was compacted in, or of the next turn after one between turns, and of no other', () => {
    const { ends, turn, heard } = setup()
    ends.started('session', 'Ship it.', false)
    ends.compacted('session')
    ends.ended(told)
    expect(heard.at(-1)).toEqual({ ...end, compacted: true })
    expect(turn('Ship it.', [])).toEqual({ ...end, turnId: 2 })
    ends.compacted('session')
    ends.ended(told)
    expect(heard).toHaveLength(2)
    expect(turn('Ship it.', [])).toEqual({ ...end, turnId: 3, compacted: true })
    ends.compacted('other')
    expect(turn('Ship it.', [])).toEqual({ ...end, turnId: 4 })
  })

  it('numbers its turns one after another, whatever session they ran in', () => {
    const { turn } = setup()
    expect([turn('One.', [], 'a'), turn('Two.', [], 'b'), turn('Three.', [], 'a')].map(event => event.turnId)).toEqual([1, 2, 3])
  })
})

describe('what it keeps, and for whom', () => {
  const transcript: LastTurnText = { userMessage: 'Ship it.', assistantText: 'From the transcript.' }

  it('names every turn, but keeps what one said only once someone can hear it: a listener here, or a service that asked and has connected', async () => {
    const tell = vi.fn(), lastTurn = vi.fn(async () => transcript)
    const ends = createTurnEnds({ hearers: new Set(['superTabs']), tell, lastTurn })
    const run = () => { ends.started('session', 'Ship it.', false); ends.said('session', 'Shipped.'); ends.worked('session'); ends.said('session', 'Done.'); ends.ended(told) }
    // Nobody hears yet: the turn is named all the same, and what it said is not kept, so its answer is the transcript's.
    run()
    // A service that is not one that hears turn ends is nobody.
    ends.connected('another-service')
    run()
    expect(tell).toHaveBeenCalledTimes(2)
    expect(await ends.answerOf(tell.mock.calls[1]![1])).toBe('From the transcript.')
    expect(lastTurn).toHaveBeenCalledOnce()
    ends.connected('superTabs')
    run()
    expect(await ends.answerOf(tell.mock.calls[2]![1])).toBe('Done.')
    expect(lastTurn).toHaveBeenCalledOnce()
    // Kept for good: a service that went and came back still has the turns that began while it was away.
    const quiet = createTurnEnds({ hearers: new Set(['superTabs']), tell, lastTurn })
    quiet.connected('superTabs')
    quiet.started('session', 'Ship it.', false)
    quiet.said('session', 'Shipped.')
    tell.mockClear()
    quiet.ended(told)
    expect(tell).toHaveBeenCalledOnce()
    expect(await quiet.answerOf(tell.mock.calls[0]![1])).toBe('Shipped.')
    const listened = createTurnEnds({ hearers: new Set(), tell: vi.fn(), lastTurn })
    const heard = vi.fn()
    listened.onEnd(heard)
    listened.started('session', 'Ship it.', false)
    listened.said('session', 'Shipped.')
    listened.ended(told)
    expect(heard).toHaveBeenCalledOnce()
    expect(await listened.answerOf(heard.mock.calls[0]![0])).toBe('Shipped.')
  })

  it('names a turn that began before anyone could hear it, and read it from the transcript when it ends: a daemon restarted in the middle of a turn picks it up before its Swarm process is back', async () => {
    const tell = vi.fn(), lastTurn = vi.fn(async () => transcript)
    const ends = createTurnEnds({ hearers: new Set(['superTabs']), tell, lastTurn })
    ends.started('session', 'Ship it.', true)
    ends.said('session', 'Shipped.')
    ends.connected('superTabs')
    ends.said('session', 'Done.')
    ends.ended(told)
    expect(tell.mock.calls).toEqual([['superTabs', end]])
    // What it said before it could be heard was not kept, and the part after it is not the whole of it: the transcript's.
    expect(await ends.answerOf(end)).toBe('From the transcript.')
    // So is a turn of a live start that nobody heard.
    const live = createTurnEnds({ hearers: new Set(['superTabs']), tell, lastTurn })
    live.started('session', 'Ship it.', false)
    live.connected('superTabs')
    live.said('session', 'Done.')
    tell.mockClear()
    live.ended(told)
    expect(tell.mock.calls).toEqual([['superTabs', end]])
    expect(await live.answerOf(end)).toBe('From the transcript.')
  })
})

describe('the answer of a turn that ended, kept as it was said', () => {
  it('is what was said after its last tool call, joined, each text trimmed, without the empty ones', async () => {
    const { turn, lastTurn, answer } = setup()
    expect(await answer(turn('Ship it.', ['Let me look.', null, '  Found it.  ', '', '   ', 'And fixed it.\n']))).toBe('Found it.\n\nAnd fixed it.')
    expect(lastTurn).not.toHaveBeenCalled()
  })

  it('is what it said before its tool calls when it said nothing after them', async () => {
    const { turn, answer } = setup()
    expect(await answer(turn('Ship it.', ['Let me look.', null, 'Then this.', null]))).toBe('Let me look.\n\nThen this.')
  })

  // Codex says what it is about to do in messages of their own (its commentary, 306 to 73 final answers on real rollouts) and its engine
  // reader leaves them out of a turn's text (engines/codex/normalizer.ts lastCodexTurnText): one that follows the last tool call, or
  // comes with none, is no part of the answer either.
  it('leaves out what its agent says on the way, its commentary, whether or not a tool call follows it', async () => {
    const { ends, lastTurn, heard, answer } = setup({ userMessage: 'Ship it.', assistantText: 'From the transcript.' })
    ends.started('session', 'Ship it.', false)
    ends.said('session', 'I will look at the build.', true)
    ends.worked('session')
    ends.said('session', 'The build is fine; now the summary.', true)
    ends.said('session', 'Shipped.', false)
    ends.said('session', 'One more thing on the way.', true)
    ends.ended(told)
    expect(await answer(heard.at(-1)!)).toBe('Shipped.')
    expect(lastTurn).not.toHaveBeenCalled()
    // A turn that said nothing else has no answer of its own: the transcript's, if that is the turn asked.
    ends.started('session', 'Ship it.', false)
    ends.said('session', 'Still on the way.', true)
    ends.ended(told)
    expect(await answer(heard.at(-1)!)).toBe('From the transcript.')
    expect(lastTurn).toHaveBeenCalledOnce()
  })

  it('keeps no more of an answer than one message takes and a character over, so its reader can tell it was cut', async () => {
    const { turn, answer } = setup()
    expect(await answer(turn('Ship it.', ['a'.repeat(ANSWER_KEEP_MAX), 'b'.repeat(500)]))).toBe('a'.repeat(ANSWER_KEEP_MAX))
    const narrated = setup()
    expect(await narrated.answer(narrated.turn('Ship it.', ['c'.repeat(ANSWER_KEEP_MAX), 'd'.repeat(500), null]))).toBe('c'.repeat(ANSWER_KEEP_MAX))
    // A long text after a short one is cut to what is left.
    const after = setup()
    const answered = await after.answer(after.turn('Ship it.', ['Short.', 'e'.repeat(ANSWER_KEEP_MAX)]))
    expect(answered).toBe(`Short.\n\n${'e'.repeat(ANSWER_KEEP_MAX - 'Short.'.length)}`.slice(0, ANSWER_KEEP_MAX))
  })

  it('keeps no more of one huge text than that, and no more than that of the many that follow it', async () => {
    const { turn, answer } = setup()
    const huge = 'x'.repeat(5_000_000)
    expect(await answer(turn('Ship it.', [huge, huge]))).toBe('x'.repeat(ANSWER_KEEP_MAX))
    // Spaces cost nothing to keep, but are not an answer.
    const blank = setup()
    expect(await blank.answer(blank.turn('Ship it.', [' '.repeat(5_000_000)]))).toBeNull()
  })

  it('keeps what it was said in words of any script, an emoji cut in two at the most kept included', async () => {
    const words = 'Ship it 🚀 — naïve café 日本語 مرحبا é'
    const { turn, answer } = setup()
    expect(await answer(turn(words, [words]))).toBe(words)
    const cut = setup()
    const long = `${'a'.repeat(ANSWER_KEEP_MAX - 1)}😀tail`
    expect(await cut.answer(cut.turn('Ship it.', [long]))).toBe(long.slice(0, ANSWER_KEEP_MAX))
  })

  it('is the answer of its own turn when a queued follow-up that began at once ended after it', async () => {
    const { ends, answer, lastTurn, heard } = setup({ userMessage: 'Then this.', assistantText: 'Narration of the second.' })
    ends.started('session', 'Ship it.', false)
    ends.said('session', 'Shipped.')
    ends.ended(told)
    const first = heard.at(-1)!
    ends.started('session', 'Then this.', false)
    ends.said('session', 'Let me check the logs.')
    // The second one is at work, the first one's end is only now being read: its own answer, never the second's text.
    expect(await answer(first)).toBe('Shipped.')
    ends.worked('session')
    ends.said('session', 'All done.')
    ends.ended(told)
    expect(await answer(heard.at(-1)!)).toBe('All done.')
    expect(await answer(first)).toBe('Shipped.')
    expect(lastTurn).not.toHaveBeenCalled()
  })

  it('is told apart by the turn when two turns were asked the same words, however late each is asked for', async () => {
    const { turn, answer } = setup()
    const one = turn('Same words.', ['The first answer.'])
    const two = turn('Same words.', ['The second answer.'])
    expect(one.prompt).toBe(two.prompt)
    expect(await answer(two)).toBe('The second answer.')
    expect(await answer(one)).toBe('The first answer.')
  })

  it('does not give a turn that said nothing the transcript\'s answer when a later turn was asked the same words: it could be that one\'s', async () => {
    const { ends, turn, answer } = setup({ userMessage: 'Same words.', assistantText: 'The second answer.' })
    const one = turn('Same words.', [null])
    expect(await answer(one)).toBe('The second answer.')
    const two = turn('Same words.', ['The second answer.'])
    expect(await answer(one)).toBeNull()
    expect(await answer(two)).toBe('The second answer.')
    // Nor while the later one is still at work.
    const three = turn('Same words.', [null])
    expect(await answer(three)).toBe('The second answer.')
    ends.started('session', 'Same words.', false)
    expect(await answer(three)).toBeNull()
  })

  it('does not give it either when the later turn asked the same words was one it saw only in part: that one\'s answer is the transcript\'s too', async () => {
    const { ends, turn, heard, answer } = setup({ userMessage: 'Same words.', assistantText: 'The second answer.' })
    const one = turn('Same words.', [null])
    // A turn of an engine whose texts are not whole, or one a restart interrupted.
    ends.started('session', 'Same words.', true)
    ends.said('session', 'its last words')
    ends.ended(told)
    expect(await answer(one)).toBeNull()
    expect(await answer(heard.at(-1)!)).toBe('The second answer.')
  })

  it('keeps the answers of the last few turns of a session, and asks the transcript for an older one', async () => {
    const { turn, lastTurn, answer } = setup()
    const ended = Array.from({ length: 5 }, (_, i) => turn(`Turn ${i}`, [`Answer ${i}`]))
    expect(await answer(ended[4]!)).toBe('Answer 4')
    expect(await answer(ended[1]!)).toBe('Answer 1')
    expect(lastTurn).not.toHaveBeenCalled()
    expect(await answer(ended[0]!)).toBeNull()
    expect(lastTurn).toHaveBeenCalledOnce()
  })

  it('keeps the sessions it has seen last, and forgets the oldest of many', async () => {
    const { turn, lastTurn, answer } = setup()
    const ended = Array.from({ length: 300 }, (_, i) => turn('Ship it.', [`Answer ${i}`], `session-${i}`))
    expect(await answer(ended[299]!)).toBe('Answer 299')
    expect(await answer(ended[43]!)).toBeNull()
    expect(await answer(ended[44]!)).toBe('Answer 44')
    expect(lastTurn).toHaveBeenCalledOnce()
  })

  it('is told by the transcript when it saw the turn only from where a daemon picked it up, if that turn is the one asked', async () => {
    const { ends, lastTurn, heard, answer } = setup({ userMessage: 'Ship it.', assistantText: '  The whole answer, from the first word.  ' })
    // A restart in the middle of a turn: what was said before it is not known, so what is seen of it is no answer.
    ends.started('session', 'Ship it.', true)
    ends.said('session', 'its last words')
    ends.ended(told)
    expect(heard).toEqual([end])
    expect(await answer(heard[0]!)).toBe('The whole answer, from the first word.')
    expect(lastTurn).toHaveBeenCalledWith('session')
  })

  it('is told by the transcript when it saw no text of the turn, and by nobody when the transcript\'s last turn is another', async () => {
    const empty = setup({ userMessage: 'Ship it.', assistantText: 'From the transcript.' })
    expect(await empty.answer(empty.turn('Ship it.', [null]))).toBe('From the transcript.')
    const other = setup({ userMessage: 'Something else.', assistantText: 'Not its answer.' })
    expect(await other.answer(other.turn('Ship it.', []))).toBeNull()
    const nothing = setup(null)
    expect(await nothing.answer(nothing.turn('Ship it.', []))).toBeNull()
    const blank = setup({ userMessage: 'Ship it.', assistantText: ' \n ' })
    const turned = blank.turn('Ship it.', [])
    expect(await blank.answer(turned)).toBeNull()
    expect(await blank.answer({ ...turned, sessionId: 'another-session' })).toBeNull()
  })

  it('cuts what the transcript gives as it cuts what it saw, and fails as the transcript fails', async () => {
    const long = setup({ userMessage: 'Ship it.', assistantText: 'x'.repeat(ANSWER_KEEP_MAX + 100) })
    long.ends.started('session', 'Ship it.', true)
    long.ends.ended(told)
    expect(await long.answer(long.heard[0]!)).toBe('x'.repeat(ANSWER_KEEP_MAX))
    const broken = setup(null)
    broken.lastTurn.mockRejectedValueOnce(new Error('transcript unreadable'))
    await expect(broken.answer(end)).rejects.toThrow('transcript unreadable')
  })

  it('forgets a turn that never ended when its session starts another, and says nothing of text with no turn open', async () => {
    const { ends, turn, answer } = setup()
    ends.said('session', 'Said before any turn began.')
    ends.worked('session')
    ends.started('session', 'Lost.', false)
    ends.said('session', 'Never ended.')
    const shipped = turn('Ship it.', ['Shipped.'])
    expect(await answer(shipped)).toBe('Shipped.')
    expect(await answer({ ...shipped, prompt: promptHash('Lost.'), turnId: 99 })).toBeNull()
  })

  it('keeps only so many turns open at once, the ones seen last', () => {
    const { ends, heard } = setup()
    for (let i = 0; i < 300; i++) ends.started(`session-${i}`, 'Ship it.', false)
    for (let i = 0; i < 300; i++) ends.ended({ ...told, sessionId: `session-${i}` })
    expect(heard).toHaveLength(256)
    expect(heard[0]!.sessionId).toBe('session-44')
  })
})
