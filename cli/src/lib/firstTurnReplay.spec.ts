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

  describe('on a rebind', () => {
    // A row as a rotation leaves it: Codex's `/new` 590 s in, its hook landing 10 s later with the first turn.
    const rotated = { registeredAt, boundAt: registeredAt + 600_000, transcriptPath: '/t/rollout-new.jsonl' }
    const since = registeredAt + 20_000
    const born = registeredAt + 590_000
    const now = born + 12_000

    it("replays a new conversation's first turn, born after the binding it replaced", () => {
      expect(transcriptIsFirstTurn(rotated, born, { rebound: true, newConversationSince: since, now })).toBe(true)
      expect(
        transcriptIsFirstTurn(rotated, since, { rebound: true, newConversationSince: since, now: since + 12_000 }),
      ).toBe(true)
    })

    it("folds a fork's rollout, written before the binding it replaced", () => {
      expect(
        transcriptIsFirstTurn(rotated, since - 1, { rebound: true, newConversationSince: since, now: since + 12_000 }),
      ).toBe(false)
    })

    it('folds a new conversation whose hook landed after the window', () => {
      const options = { rebound: true, newConversationSince: since, now: born + FIRST_TURN_WINDOW_MS }
      expect(transcriptIsFirstTurn(rotated, born, options)).toBe(false)
      expect(transcriptIsFirstTurn(rotated, born, { ...options, now: options.now - 1 })).toBe(true)
    })

    it('folds without the new-conversation signal, whatever the birth', () => {
      expect(transcriptIsFirstTurn(rotated, born, { rebound: true, now })).toBe(false)
      expect(transcriptIsFirstTurn(rotated, now - 1, { rebound: true, now })).toBe(false)
    })

    it('folds when unbound, with no file, or with an unreadable birth', () => {
      const options = { rebound: true, newConversationSince: since, now }
      expect(transcriptIsFirstTurn({ ...rotated, boundAt: null }, born, options)).toBe(false)
      expect(transcriptIsFirstTurn({ ...rotated, transcriptPath: null }, born, options)).toBe(false)
      expect(transcriptIsFirstTurn(rotated, 0, options)).toBe(false)
    })
  })
})
