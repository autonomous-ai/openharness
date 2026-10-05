import { describe, expect, it, vi } from 'vitest'
import type { TurnState } from '../../lib/normalize.js'
import { createSessionNormalizers, type SessionNormalizers } from './normalizers.js'

/** Every engine map in the table, in the order a turn's state is looked up. */
const ENGINE_MAPS = [
  'codexNormalizers', 'cursorNormalizers', 'opencodeReaders', 'kiloReaders', 'piNormalizers', 'museNormalizers',
  'ampNormalizers', 'grokNormalizers', 'agyNormalizers', 'copilotNormalizers', 'hermesReaders', 'devinReaders',
  'commandcodeNormalizers',
] as const
type EngineMap = typeof ENGINE_MAPS[number]
const DATABASE_READERS: EngineMap[] = ['opencodeReaders', 'kiloReaders', 'hermesReaders', 'devinReaders']

/** A normalizer or reader with only what the table touches. */
const fake = (turnOpen: boolean | undefined = false) => ({ turnOpen, closeTurn: vi.fn(() => []), stop: vi.fn() })
type Fake = ReturnType<typeof fake>

function put(table: SessionNormalizers, map: EngineMap, sessionId: string, entry: Fake): void {
  (table[map] as Map<string, unknown>).set(sessionId, entry)
}

describe('the session normalizer table', () => {
  it('has state for a session that any engine map holds, and none for one that none does', () => {
    const table = createSessionNormalizers()
    expect(table.hasState('s')).toBe(false)
    table.turnStates.set('s', { turnOpen: false } as TurnState)
    expect(table.hasState('s')).toBe(true)
    for (const map of ENGINE_MAPS) {
      const one = createSessionNormalizers()
      put(one, map, 's', fake())
      expect(one.hasState('s'), map).toBe(true)
      expect(one.hasState('other'), map).toBe(false)
    }
  })

  it('reads whether a turn is open from Claude Code\'s state first, then each engine in turn', () => {
    const table = createSessionNormalizers()
    expect(table.sessionTurnState('s')).toBeUndefined()
    expect(table.sessionTurnOpen('s')).toBe(false)
    for (const map of ENGINE_MAPS) {
      const one = createSessionNormalizers()
      put(one, map, 's', fake(true))
      expect(one.sessionTurnState('s'), map).toBe(true)
      expect(one.sessionTurnOpen('s'), map).toBe(true)
    }
    // The first engine that knows wins, even when it says closed: Claude Code's state before Codex's, Codex
    // before Cursor, and so on down the list.
    table.turnStates.set('s', { turnOpen: false } as TurnState)
    put(table, 'codexNormalizers', 's', fake(true))
    expect(table.sessionTurnState('s')).toBe(false)
    table.turnStates.delete('s')
    put(table, 'cursorNormalizers', 's', fake(false))
    expect(table.sessionTurnState('s')).toBe(true)
  })

  it('forgets a session in every map, stopping its database readers, and leaves other sessions alone', () => {
    const table = createSessionNormalizers()
    table.turnStates.set('s', { turnOpen: true } as TurnState)
    table.turnStates.set('keep', { turnOpen: true } as TurnState)
    const entries = new Map<EngineMap, Fake>()
    for (const map of ENGINE_MAPS) {
      entries.set(map, fake())
      put(table, map, 's', entries.get(map)!)
      put(table, map, 'keep', fake())
    }
    table.forget('s')
    expect(table.hasState('s')).toBe(false)
    expect(table.turnStates.has('keep')).toBe(true)
    for (const map of ENGINE_MAPS) {
      expect(table[map].has('keep'), map).toBe(true)
      expect(entries.get(map)!.stop, map).toHaveBeenCalledTimes(DATABASE_READERS.includes(map) ? 1 : 0)
    }
    expect(() => table.forget('never-seen')).not.toThrow()
  })

  it('closes a cancelled turn in every engine', () => {
    const table = createSessionNormalizers()
    const state = { turnOpen: true } as TurnState
    table.turnStates.set('s', state)
    const entries = new Map<EngineMap, Fake>()
    for (const map of ENGINE_MAPS) {
      entries.set(map, fake(true))
      put(table, map, 's', entries.get(map)!)
    }
    table.closeTurns('s')
    expect(state.turnOpen).toBe(false)
    for (const map of ENGINE_MAPS) {
      // Kilo's included: it used to be missed, so a cancelled Kilo agent could go on showing as working.
      expect(entries.get(map)!.closeTurn, map).toHaveBeenCalledTimes(1)
    }
    expect(() => table.closeTurns('never-seen')).not.toThrow()
  })

  it('stops every database reader\'s poller on shutdown, and touches nothing else', () => {
    const table = createSessionNormalizers()
    const entries = new Map<EngineMap, Fake>()
    for (const map of ENGINE_MAPS) {
      entries.set(map, fake())
      put(table, map, 's', entries.get(map)!)
    }
    table.stopPollers()
    for (const map of ENGINE_MAPS) {
      // Kilo's included: it used to be missed, and its poller ran on through the update handoff.
      expect(entries.get(map)!.stop, map).toHaveBeenCalledTimes(DATABASE_READERS.includes(map) ? 1 : 0)
    }
  })
})
