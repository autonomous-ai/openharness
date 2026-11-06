import { describe, expect, it, vi } from 'vitest'
import type { TeamConfig } from './config.js'
import { afterRevoke, recordTeamSignedOut } from './observer.js'

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

// Linuxtest2 on daniel-pc (#3684): the machines spec, run in a Team account, rewrote that machine's real status file to
// signed-out through the real observer. A spec never reads this Mac's Team config, as team/relay.ts does not.
describe('the Team config the real observer reads', () => {
  it('is none under a test run, and the config file outside one', async () => {
    vi.resetModules()
    vi.doMock('./config.js', () => ({ readTeamConfig: () => config }))
    const { teamConfigHere } = await import('./observer.js')
    expect(teamConfigHere()).toBeNull()
    const vitest = process.env.VITEST
    delete process.env.VITEST
    try { expect(teamConfigHere()).toBe(config) } finally { process.env.VITEST = vitest }
    vi.doUnmock('./config.js')
  })
})

// Security review 2 of #3331, third round: the revoke's status was written while the session's own signed-out mark still
// waited for the refresh lock, so an observer in that gap read the session as live and healed the status to signed-in.
describe('a revoke, in order', () => {
  it('writes the status only once the session is marked signed out, and even when marking failed', async () => {
    const order: string[] = []
    let finish: () => void = () => {}
    const mark = () => new Promise<void>((resolve) => { finish = () => { order.push('marked'); resolve() } })
    const done = afterRevoke(mark, () => order.push('recorded'))
    await Promise.resolve()
    expect(order).toEqual([])
    finish()
    await done
    expect(order).toEqual(['marked', 'recorded'])
    const failed: string[] = []
    await afterRevoke(async () => { throw new Error('lock held') }, () => failed.push('recorded'))
    expect(failed).toEqual(['recorded'])
  })
})
