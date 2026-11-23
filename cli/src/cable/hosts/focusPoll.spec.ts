import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { FOCUS_FAILS_MAX, FOCUS_POLL_MS, FOCUS_READ_MS, startFocusPoll } from './focusPoll.js'

/** A read held until the spec answers it; each answer lets the poll take it in. */
interface Read {
  answer(value: string | undefined): Promise<void>
  reject(error: Error): Promise<void>
}

/** Lets what a read was answered be taken in: setImmediate is not faked. */
const turn = () => new Promise((resolve) => setImmediate(resolve))

/** A poll on fakes: reads the spec answers by hand, an `after` on the faked setTimeout, and what it told. */
function setup(answered: (answer: string) => void = () => {}) {
  const reads: Read[] = []
  const answers: string[] = []
  const lines: string[] = []
  let failing = 0
  const poll = startFocusPoll<string>({
    read: () => new Promise<string | undefined>((resolve, reject) => {
      reads.push({
        answer: async (value) => { resolve(value); await turn() },
        reject: async (error) => { reject(error); await turn() },
      })
    }),
    answered: (answer) => { answers.push(answer); answered(answer) },
    failing: () => { failing++ },
    after: (ms, run) => {
      const timer = setTimeout(run, ms)
      return () => clearTimeout(timer)
    },
    log: (line) => { lines.push(line) },
  })
  /** The read under way answered, then the wait to the next one run out. */
  const next = async (value: string | undefined) => {
    await reads[reads.length - 1].answer(value)
    vi.advanceTimersByTime(FOCUS_POLL_MS)
  }
  return { poll, reads, answers, lines, failing: () => failing, next }
}

const STARTED = '[device] focus poll · started'

describe('startFocusPoll', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
  afterEach(() => { vi.useRealTimers() })

  it('its values: 500 ms between reads, 2 s for one read, 3 failed reads in a row', () => {
    expect(FOCUS_POLL_MS).toBe(500)
    expect(FOCUS_READ_MS).toBe(2_000)
    expect(FOCUS_FAILS_MAX).toBe(3)
  })

  it('reads at once, then FOCUS_POLL_MS after each read ends, never two at once', async () => {
    const s = setup()
    expect(s.reads).toHaveLength(1)
    expect(s.lines).toEqual([STARTED])
    vi.advanceTimersByTime(300)
    await s.reads[0].answer('a')
    vi.advanceTimersByTime(FOCUS_POLL_MS - 1)
    expect(s.reads).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(s.reads).toHaveLength(2)
    // A read that runs past FOCUS_READ_MS is still the one under way: its deadline is its adapter's.
    vi.advanceTimersByTime(5_000)
    expect(s.reads).toHaveLength(2)
    await s.reads[1].answer('b')
    vi.advanceTimersByTime(FOCUS_POLL_MS)
    expect(s.reads).toHaveLength(3)
  })

  it('each answer is told in order; a failed read and a rejected one tell nothing', async () => {
    const s = setup()
    await s.next('a')
    await s.next(undefined)
    await s.reads[2].reject(new Error('gone'))
    vi.advanceTimersByTime(FOCUS_POLL_MS)
    await s.next('b')
    expect(s.answers).toEqual(['a', 'b'])
    expect(s.reads).toHaveLength(5)
  })

  it('a stop starts no read, drops the answer of the read under way, and says its counts once', async () => {
    const s = setup()
    await s.next('a')
    await s.next(undefined)
    expect(s.reads).toHaveLength(3)
    s.poll.stop()
    expect(s.lines).toEqual([STARTED, '[device] focus poll · stopped · 2 reads, 1 failed'])
    await s.reads[2].answer('c')
    expect(s.answers).toEqual(['a'])
    s.poll.stop()
    expect(s.lines).toHaveLength(2)
    vi.advanceTimersByTime(FOCUS_POLL_MS * 2)
    expect(s.reads).toHaveLength(3)
  })

  it('a stop between reads cancels the next one', async () => {
    const s = setup()
    await s.reads[0].answer('a')
    s.poll.stop()
    vi.advanceTimersByTime(FOCUS_POLL_MS * 2)
    expect(s.reads).toHaveLength(1)
    expect(s.lines).toEqual([STARTED, '[device] focus poll · stopped · 1 reads, 0 failed'])
  })

  it('three failed reads in a row stop it as failing, told once', async () => {
    const s = setup()
    await s.next(undefined)
    await s.reads[1].reject(new Error('refused'))
    vi.advanceTimersByTime(FOCUS_POLL_MS)
    await s.reads[2].answer(undefined)
    expect(s.lines).toEqual([STARTED, '[device] focus poll · stopped · 3 reads, 3 failed · failing'])
    expect(s.failing()).toBe(1)
    vi.advanceTimersByTime(FOCUS_POLL_MS * 4)
    expect(s.reads).toHaveLength(3)
    s.poll.stop()
    expect(s.lines).toHaveLength(2)
    expect(s.failing()).toBe(1)
  })

  it('a good read between failures starts the count again', async () => {
    const s = setup()
    await s.next(undefined)
    await s.next(undefined)
    await s.next('a')
    await s.next(undefined)
    await s.next(undefined)
    expect(s.reads).toHaveLength(6)
    expect(s.failing()).toBe(0)
    expect(s.lines).toEqual([STARTED])
  })

  it('an answered that throws still leaves the next read on time', async () => {
    const rejected: unknown[] = []
    const note = (reason: unknown) => { rejected.push(reason) }
    process.on('unhandledRejection', note)
    onTestFinished(() => { process.off('unhandledRejection', note) })
    const s = setup(() => { throw new Error('broken') })
    await s.reads[0].answer('a')
    vi.advanceTimersByTime(FOCUS_POLL_MS - 1)
    expect(s.reads).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(s.reads).toHaveLength(2)
    expect(s.answers).toEqual(['a'])
    await turn()
    expect(rejected).toEqual([])
  })
})
