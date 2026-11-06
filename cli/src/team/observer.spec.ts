import { describe, expect, it, vi } from 'vitest'
import type { TeamConfig } from './config.js'
import { recordTeamSignedOut } from './observer.js'

const config = { user: '_harnessteam', statusFile: '/Users/_harnessteam/.harness/team-status.json' } as TeamConfig

// Security review 2 of #3331 (#3684): a revoke stops the Team daemon for good, and its status file kept `signed-in`, so
// the owner's card offered Restart, not Sign in again, until something started the job. Said as the daemon stops.
describe('a revoke in the Harness Team account', () => {
  it('records its sign-in signed out in the status file the owner reads, with fixed words', () => {
    const writeStatus = vi.fn()
    recordTeamSignedOut({ config: () => config, user: () => '_harnessteam', writeStatus, now: () => 42 })
    expect(writeStatus).toHaveBeenCalledWith(config.statusFile, { signIn: { state: 'signed-out', at: 42,
      detail: 'The Team sign-in is no longer available. Run harness team setup --sign-in-again.' } })
  })

  it('writes nothing in the owner\'s own daemon, or with no Team account, and never throws', () => {
    const writeStatus = vi.fn()
    recordTeamSignedOut({ config: () => config, user: () => 'owner', writeStatus, now: () => 1 })
    recordTeamSignedOut({ config: () => null, user: () => '_harnessteam', writeStatus, now: () => 1 })
    expect(writeStatus).not.toHaveBeenCalled()
    expect(() => recordTeamSignedOut({ config: () => config, user: () => '_harnessteam',
      writeStatus: () => { throw new Error('read-only') }, now: () => 1 })).not.toThrow()
  })
})
