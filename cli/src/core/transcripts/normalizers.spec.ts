import { describe, expect, it, vi } from 'vitest'
import type { LiveState } from '../../engines/facets/live.js'
import type { OtherStream } from '../engines/otherStreams.js'
import { createSessionNormalizers } from './normalizers.js'

/** A live parser, or another engine's stream, with only what the table touches. */
const parser = (turnOpen = false): LiveState => ({ engine: 'claude', turnOpen, snapshot: vi.fn(), closeTurn: vi.fn() })
const stream = (turnOpen = false) => ({ turnOpen, closeTurn: vi.fn() }) as unknown as OtherStream
function others(entries: Record<string, OtherStream> = {}) {
  return { get: (id: string) => entries[id], has: (id: string) => id in entries, forget: vi.fn(), stop: vi.fn() }
}

/** Turn hooks that hold no end. */
const noTurns = { held: () => false, closed: vi.fn(), forget: vi.fn() }

describe('the session normalizer table', () => {
  it('has state for a session with a live parser or another engine\'s stream, and none for one with neither', () => {
    expect(createSessionNormalizers(others(), noTurns).hasState('s')).toBe(false)
    const table = createSessionNormalizers(others({ o: stream() }), noTurns)
    table.liveParsers.set('p', parser())
    expect([table.hasState('p'), table.hasState('o'), table.hasState('none')]).toEqual([true, true, false])
  })

  it('reads whether a turn is open from the parser, else the stream, the parser first', () => {
    const table = createSessionNormalizers(others({ s: stream(true), o: stream(true) }), noTurns)
    expect(table.sessionTurnState('none')).toBeUndefined()
    expect(table.sessionTurnOpen('none')).toBe(false)
    expect(table.sessionTurnState('o')).toBe(true)
    // A closed live parser is authoritative even when an old stream still reports an open turn.
    table.liveParsers.set('s', parser(false))
    expect(table.sessionTurnState('s')).toBe(false)
    expect(table.sessionTurnOpen('o')).toBe(true)
  })

  it('forgets a session\'s parser and its stream, and leaves other sessions alone', () => {
    const streams = others({ s: stream() })
    const table = createSessionNormalizers(streams, noTurns)
    table.liveParsers.set('s', parser())
    table.liveParsers.set('keep', parser())
    table.forget('s')
    expect(table.liveParsers.has('s')).toBe(false)
    expect(table.liveParsers.has('keep')).toBe(true)
    expect(streams.forget).toHaveBeenCalledWith('s')
  })

  it('closes a cancelled turn in the parser and the stream, as a cancel', () => {
    const live = parser(true), other = stream(true)
    const table = createSessionNormalizers(others({ s: other }), noTurns)
    table.liveParsers.set('s', live)
    table.closeTurns('s')
    expect(live.closeTurn).toHaveBeenCalledWith('cancel')
    expect(other.closeTurn).toHaveBeenCalledWith('cancel')
    expect(() => table.closeTurns('never-seen')).not.toThrow()
  })

  it('reads a turn as open while its end is held, whatever the parser says', () => {
    const turns = { held: (id: string) => id === 'held', closed: vi.fn(), forget: vi.fn() }
    const table = createSessionNormalizers(others({ other: stream(false) }), turns)
    table.liveParsers.set('held', parser(false))
    table.liveParsers.set('closed', parser(false))
    expect(['held', 'closed', 'other', 'none'].map(table.sessionTurnState)).toEqual([true, false, false, undefined])
  })

  it('a cancel tells the turn hooks it closed; forgetting a session forgets its record', () => {
    const turns = { held: () => false, closed: vi.fn(), forget: vi.fn() }
    const table = createSessionNormalizers(others(), turns)
    table.closeTurns('s')
    expect(turns.closed).toHaveBeenCalledWith('s')
    table.forget('s')
    expect(turns.forget).toHaveBeenCalledWith('s')
  })

  it('stops following every other engine\'s stream on shutdown', () => {
    const streams = others()
    createSessionNormalizers(streams, noTurns).stopPollers()
    expect(streams.stop).toHaveBeenCalledOnce()
  })
})
