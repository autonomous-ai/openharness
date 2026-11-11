import { describe, expect, it, vi } from 'vitest'
import { createQuietTitles, QUIET_STRETCHES_KEPT } from './quietTitles.js'

/** Lets the reads asked for so far run, and the edges they hold move. */
const settled = () => new Promise<void>((resolve) => { setImmediate(resolve) })

describe('quiet titles', () => {
  it('judges titles quiet from a quiet turn’s start to the next turn’s start, each edge moving after one more read', async () => {
    const seen: boolean[] = []
    const titles = createQuietTitles({ read: async () => { seen.push(titles.quiet('a1')) }, log: vi.fn() })
    titles.started('a1')
    // Never read inside the turn's start; and a title that came before the edge is judged by the stretch it came in.
    expect(seen).toEqual([])
    expect(titles.quiet('a1')).toBe(false)
    await settled()
    expect(seen).toEqual([false])
    expect(titles.quiet('a1')).toBe(true)
    // The agent's next turn ends the stretch, after a read that judges what came before it quiet.
    titles.turnStarted('a1')
    expect(titles.quiet('a1')).toBe(true)
    await settled()
    expect(seen).toEqual([false, true])
    expect(titles.quiet('a1')).toBe(false)
    // A turn with no stretch before it reads nothing.
    titles.turnStarted('a1')
    await settled()
    expect(seen).toEqual([false, true])
  })

  // The input says a quiet delivery started its turn as the funnel tells that turn's start, or a moment after it: a quiet turn that
  // follows a quiet turn ends one stretch and starts the next before either read is done.
  it('keeps the stretch of a quiet turn that follows a quiet turn, whichever read ends first', async () => {
    const reads: Array<() => void> = []
    const titles = createQuietTitles({ read: () => new Promise<void>((resolve) => { reads.push(resolve) }), log: vi.fn() })
    titles.started('a1')
    await settled()
    reads[0]()
    await settled()
    titles.turnStarted('a1')
    titles.started('a1')
    await settled()
    reads[2]()
    await settled()
    expect(titles.quiet('a1')).toBe(true)
    reads[1]()
    await settled()
    expect(titles.quiet('a1')).toBe(true)
  })

  // An agent stopped in its stretch and resumed shows its conversation's titles again before any turn: one it had before the
  // quiet line is its own name, never the quiet line's.
  it('ends the stretch when its agent ends, after one more read', async () => {
    const seen: boolean[] = []
    const titles = createQuietTitles({ read: async () => { seen.push(titles.quiet('a1')) }, log: vi.fn() })
    titles.started('a1')
    await settled()
    titles.ended('a1')
    expect(titles.quiet('a1')).toBe(true)
    await settled()
    expect(seen).toEqual([false, true])
    expect(titles.quiet('a1')).toBe(false)
    // An agent that ends with no stretch reads nothing.
    titles.ended('a1')
    await settled()
    expect(seen).toEqual([false, true])
  })

  it('moves an edge when its read fails, and says so', async () => {
    const log = vi.fn()
    let failure: unknown = new Error('no tmux server')
    const titles = createQuietTitles({ read: async () => { throw failure }, log })
    titles.started('a1')
    await settled()
    expect(titles.quiet('a1')).toBe(true)
    failure = 'timed out'
    titles.turnStarted('a1')
    await settled()
    expect(titles.quiet('a1')).toBe(false)
    expect(log.mock.calls).toEqual([
      ['[terminal-title] read at a quiet edge failed · no tmux server'],
      ['[terminal-title] read at a quiet edge failed · timed out'],
    ])
  })

  // An agent deleted in its stretch never starts the turn that would end it.
  it('keeps the latest stretches only', async () => {
    const titles = createQuietTitles({ read: async () => {}, log: vi.fn() })
    for (let i = 0; i < QUIET_STRETCHES_KEPT; i++) titles.started(`a${i}`)
    // Said again, a stretch is the latest.
    titles.started('a0')
    await settled()
    expect(titles.quiet('a0')).toBe(true)
    expect(titles.quiet('a1')).toBe(true)
    titles.started('one more')
    expect(titles.quiet('a1')).toBe(false)
    expect(titles.quiet('a0')).toBe(true)
    await settled()
    expect(titles.quiet('one more')).toBe(true)
  })
})
