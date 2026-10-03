import { describe, expect, it } from 'vitest'
import { FIRST_TURN_WINDOW_MS, transcriptIsFirstTurn } from './firstTurnReplay.js'

const registeredAt = Date.parse('2026-09-25T13:35:00Z')
const entry = { registeredAt, boundAt: registeredAt + 20_000, transcriptPath: '/t/rollout.jsonl' }
const birth = registeredAt + 18_000

describe('transcriptIsFirstTurn', () => {
  it('replays a transcript that appeared after its agent, moments ago', () => {
    expect(transcriptIsFirstTurn(entry, birth, { rebound: false, now: birth + 2_000 })).toBe(true)
  })

  it('never replays a long session again: a restart forgets the replay, the file stays old', () => {
    // The crash: two days later, a SessionStart after a daemon restart replayed 346 MB live.
    expect(transcriptIsFirstTurn(entry, birth, { rebound: false, now: birth + 2 * 86_400_000 })).toBe(false)
    expect(transcriptIsFirstTurn(entry, birth, { rebound: false, now: birth + FIRST_TURN_WINDOW_MS })).toBe(false)
  })

  it('keeps a first turn announced a few minutes after the file appeared', () => {
    expect(transcriptIsFirstTurn(entry, birth, { rebound: false, now: birth + FIRST_TURN_WINDOW_MS - 1 })).toBe(true)
  })

  it('folds a resumed transcript, older than its agent, as history', () => {
    expect(transcriptIsFirstTurn(entry, registeredAt - 81_500, { rebound: false, now: birth })).toBe(false)
  })

  it('folds when the session was rebound, unbound, has no file, or its birth is unreadable', () => {
    const now = birth + 1_000
    expect(transcriptIsFirstTurn(entry, birth, { rebound: true, now })).toBe(false)
    expect(transcriptIsFirstTurn({ ...entry, boundAt: null }, birth, { rebound: false, now })).toBe(false)
    expect(transcriptIsFirstTurn({ ...entry, boundAt: registeredAt }, birth, { rebound: false, now })).toBe(false)
    expect(transcriptIsFirstTurn({ ...entry, transcriptPath: null }, birth, { rebound: false, now })).toBe(false)
    expect(transcriptIsFirstTurn(entry, 0, { rebound: false, now })).toBe(false)
  })
})
