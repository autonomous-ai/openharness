import { describe, expect, it } from 'vitest'
import { SQLITE_BACKED_ENGINES } from '../lib/sqliteAvailability.js'
import { engineFor } from './registry.js'
import { PROCESS_ENGINES } from './types.js'

describe('the engine registry', () => {
  it('has every engine, each with the transcript facet it was built with', () => {
    // An import cycle leaves a facet undefined while the table is evaluated, silently; this is where it shows.
    for (const name of PROCESS_ENGINES) {
      const engine = engineFor(name)
      expect(engine?.name, name).toBe(name)
      expect(typeof engine?.transcript?.lastTurnText, name).toBe('function')
    }
  })

  it('reads a stored conversation for exactly the engines that keep one in a database', () => {
    const stored = PROCESS_ENGINES.filter((name) => engineFor(name)?.transcript?.storedConversation)
    expect(stored.sort()).toEqual([...SQLITE_BACKED_ENGINES].sort())
  })

  it('has no engine for a terminal, a name it does not know, or none at all', () => {
    expect(engineFor('terminal')).toBeUndefined()
    expect(engineFor('gemini')).toBeUndefined()
    expect(engineFor('')).toBeUndefined()
    expect(engineFor(null)).toBeUndefined()
    expect(engineFor(undefined)).toBeUndefined()
  })

  it('hands out engines that cannot be changed from outside', () => {
    expect(Object.isFrozen(engineFor('claude'))).toBe(true)
  })
})
