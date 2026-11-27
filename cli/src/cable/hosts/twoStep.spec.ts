import { describe, expect, it } from 'vitest'
import { MAX_TEXT } from './text.js'
import { cleanWords, createTwoStep, settleMs, type StepAnswer, type TwoStep, type TwoSteps } from './twoStep.js'

type Why = 'busy' | 'refused' | 'failed'

/** An `after` that records each wait and runs it when told: a send waits at its settle until then. */
function fakeAfter() {
  const asked: number[] = []
  const waiting: Array<() => void> = []
  return {
    asked,
    after: (ms: number, run: () => void) => {
      asked.push(ms)
      waiting.push(run)
    },
    flush: () => {
      for (const run of waiting.splice(0)) run()
    },
  }
}

/** Steps that record each call by name and answer as told. */
function fakeSteps(answers: Partial<{
  words: Why
  enter: Why
  wordsAnswer: StepAnswer<Why>
  enterAnswer: StepAnswer<Why>
}> = {}) {
  const calls: string[] = []
  const steps: TwoSteps<Why> = {
    check: async (before) => {
      calls.push(`check:${before}`)
      return answers[before]
    },
    words: async () => {
      calls.push('words')
      return answers.wordsAnswer ?? { ok: true }
    },
    enter: async () => {
      calls.push('enter')
      return answers.enterAnswer ?? { ok: true }
    },
  }
  return { calls, steps }
}

/** Lets every promise already settled run its callbacks. */
const drain = () => new Promise<void>((done) => { setImmediate(done) })

/** A send on [key] carried to its end: true when the key was free for it. */
async function sendAgain(twoStep: TwoStep<number>, clock: { flush(): void }, key: number): Promise<true | Why> {
  const sent = twoStep.send<Why>(key, 'again', fakeSteps().steps, 'failed')
  await drain()
  clock.flush()
  return sent
}

describe('cleanWords', () => {
  it('types a control character as a space and a lone surrogate as the replacement character', () => {
    expect(cleanWords('a\nb\tc\u001b[0m')).toBe('a b c [0m')
    expect(cleanWords('x\ud800y')).toBe('x�y')
  })

  it('has no words for an empty text or one over MAX_TEXT', () => {
    expect(cleanWords('')).toBeUndefined()
    expect(cleanWords('a'.repeat(MAX_TEXT + 1))).toBeUndefined()
    expect(cleanWords('a'.repeat(MAX_TEXT))).toBe('a'.repeat(MAX_TEXT))
  })
})

describe('settleMs', () => {
  it('grows a millisecond each 60 characters from 400, to at most 1500', () => {
    expect(settleMs('')).toBe(400)
    expect(settleMs('a'.repeat(60))).toBe(401)
    expect(settleMs('a'.repeat(100_000))).toBe(1500)
  })
})

describe('createTwoStep', () => {
  it('checks, writes the words, settles, checks again, then presses Enter', async () => {
    const clock = fakeAfter()
    const twoStep = createTwoStep<number>(clock.after)
    const { calls, steps } = fakeSteps()
    const sent = twoStep.send(7, 'hello there', steps, 'failed')
    await drain()
    expect(calls).toEqual(['check:words', 'words'])
    expect(clock.asked).toEqual([settleMs('hello there')])
    clock.flush()
    expect(await sent).toBe(true)
    expect(calls).toEqual(['check:words', 'words', 'check:enter', 'enter'])
    expect(clock.asked).toHaveLength(1)
  })

  it('stops at the first refusal, with its reason', async () => {
    const clock = fakeAfter()
    const twoStep = createTwoStep<number>(clock.after)

    const beforeWords = fakeSteps({ words: 'busy' })
    expect(await twoStep.send(1, 'hi', beforeWords.steps, 'failed')).toBe('busy')
    expect(beforeWords.calls).toEqual(['check:words'])

    const wordsRefused = fakeSteps({ wordsAnswer: { ok: false, why: 'refused' } })
    expect(await twoStep.send(1, 'hi', wordsRefused.steps, 'failed')).toBe('refused')
    expect(wordsRefused.calls).toEqual(['check:words', 'words'])
    expect(clock.asked).toEqual([])

    const beforeEnter = fakeSteps({ enter: 'busy' })
    const sent = twoStep.send(1, 'hi', beforeEnter.steps, 'failed')
    await drain()
    clock.flush()
    expect(await sent).toBe('busy')
    expect(beforeEnter.calls).toEqual(['check:words', 'words', 'check:enter'])

    const enterRefused = fakeSteps({ enterAnswer: { ok: false, why: 'refused' } })
    const pressed = twoStep.send(1, 'hi', enterRefused.steps, 'failed')
    await drain()
    clock.flush()
    expect(await pressed).toBe('refused')
  })

  it('answers a second send on a key still sending failed, with no step run, while another key sends', async () => {
    const clock = fakeAfter()
    const twoStep = createTwoStep<number>(clock.after)
    const first = fakeSteps()
    const sent = twoStep.send(1, 'one', first.steps, 'failed')
    await drain()

    const again = fakeSteps()
    expect(await twoStep.send(1, 'two', again.steps, 'failed')).toBe('failed')
    expect(again.calls).toEqual([])

    const other = fakeSteps()
    const elsewhere = twoStep.send(2, 'three', other.steps, 'failed')
    await drain()
    expect(other.calls).toEqual(['check:words', 'words'])
    clock.flush()
    expect(await sent).toBe(true)
    expect(await elsewhere).toBe(true)
    expect(await sendAgain(twoStep, clock, 1)).toBe(true)
    expect(await sendAgain(twoStep, clock, 2)).toBe(true)
  })

  it('answers a second send on a key still sending busy, when given one; a step that throws is still failed', async () => {
    const clock = fakeAfter()
    const twoStep = createTwoStep<number>(clock.after)
    const sent = twoStep.send(1, 'one', fakeSteps().steps, 'failed', 'busy')
    await drain()
    const again = fakeSteps()
    expect(await twoStep.send(1, 'two', again.steps, 'failed', 'busy')).toBe('busy')
    expect(again.calls).toEqual([])
    const throws: TwoSteps<Why> = {
      check: () => { throw new Error('boom') },
      words: async () => ({ ok: true }),
      enter: async () => ({ ok: true }),
    }
    expect(await twoStep.send(2, 'hi', throws, 'failed', 'busy')).toBe('failed')
    clock.flush()
    expect(await sent).toBe(true)
  })

  it('keeps the key locked after the send ended, until every held answer settled', async () => {
    const clock = fakeAfter()
    const twoStep = createTwoStep<number>(clock.after)
    let release!: () => void
    const held = new Promise<void>((settled) => { release = settled })
    const { steps } = fakeSteps({ wordsAnswer: { ok: false, why: 'refused', held } })
    expect(await twoStep.send(1, 'hi', steps, 'failed')).toBe('refused')
    await drain()
    const locked = fakeSteps()
    expect(await twoStep.send(1, 'hi', locked.steps, 'failed')).toBe('failed')
    expect(locked.calls).toEqual([])

    release()
    await drain()
    expect(await sendAgain(twoStep, clock, 1)).toBe(true)
  })

  it('answers failed for a step that throws or rejects, and frees the key', async () => {
    const twoStep = createTwoStep<number>((_ms, run) => run())
    const throws: TwoSteps<Why> = {
      check: () => { throw new Error('boom') },
      words: async () => ({ ok: true }),
      enter: async () => ({ ok: true }),
    }
    expect(await twoStep.send(1, 'hi', throws, 'failed')).toBe('failed')
    expect(await twoStep.send(1, 'hi', fakeSteps().steps, 'failed')).toBe(true)

    const rejects: TwoSteps<Why> = {
      check: async () => undefined,
      words: async () => ({ ok: true }),
      enter: () => Promise.reject(new Error('gone')),
    }
    expect(await twoStep.send(1, 'hi', rejects, 'failed')).toBe('failed')
    expect(await twoStep.send(1, 'hi', fakeSteps().steps, 'failed')).toBe(true)
  })
})
