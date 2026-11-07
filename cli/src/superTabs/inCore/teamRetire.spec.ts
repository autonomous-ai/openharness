import { describe, expect, it, vi } from 'vitest'
import { TEAM_RETIRED, teamRetirement } from './teamRetire.js'

// Swarm v3 has no Team accounts (#4221): a Team account's daemon stops for good once no agent runs in it.
describe('a Harness Team account\'s daemon, after each pass over its agents', () => {
  const made = (teamAccount: boolean, live: number[]) => {
    const stop = vi.fn<(reason: string) => void>()
    const log = vi.fn<(line: string) => void>()
    const counts = [...live]
    const pass = teamRetirement({ teamAccount, live: () => counts.shift() ?? 0, stop, log })
    return { pass, stop, log }
  }

  it('stops for good, once, when no agent runs in it', () => {
    const { pass, stop, log } = made(true, [0, 0])
    pass()
    pass()
    expect(stop).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledWith(TEAM_RETIRED)
    expect(log).toHaveBeenCalledWith('[team] Swarm v3 has no Team accounts: no agent runs here, stopping for good')
  })

  it('waits while an agent still runs in it, and stops once the last one is gone', () => {
    const { pass, stop } = made(true, [2, 1, 0])
    pass()
    pass()
    expect(stop).not.toHaveBeenCalled()
    pass()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('never stops a daemon that is not a Team account\'s: the owner\'s own, or a computer signed in with harness team on', () => {
    const { pass, stop, log } = made(false, [0])
    pass()
    expect(stop).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })
})
