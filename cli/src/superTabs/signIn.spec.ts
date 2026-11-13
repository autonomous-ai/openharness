import { describe, expect, it } from 'vitest'
import { writeAuthSession, clearAuthSession } from '../lib/authSession.js'
import { signInOnDisk } from './signIn.js'

// The reviews of #4221: the host and first answers tell a new sign-in, or a refreshed one, from the session the server refused.
describe('which sign-in is on disk', () => {
  const session = { version: 1 as const, accessToken: 'access-1', refreshToken: 'refresh-1', autonomousEnv: 'prod' as const, computerId: 'c', updatedAt: 1 }

  it('is none with no session, and keeps no token in its key', () => {
    clearAuthSession()
    expect(signInOnDisk()).toBeNull()
    writeAuthSession(session)
    const key = signInOnDisk()!
    expect(key).not.toContain('refresh-1')
    expect(key).not.toContain('access-1')
  })

  it('changes with another sign-in, and with a session refreshed on disk (the fifth review: a refresh kept the same epoch)', () => {
    writeAuthSession({ ...session, signInEpoch: 'epoch-1' })
    const first = signInOnDisk()
    writeAuthSession({ ...session, signInEpoch: 'epoch-1', accessToken: 'access-2', updatedAt: 2 })
    const refreshed = signInOnDisk()
    writeAuthSession({ ...session, signInEpoch: 'epoch-2', updatedAt: 2 })
    expect(new Set([first, refreshed, signInOnDisk()]).size).toBe(3)
    // The same session read again is the same sign-in.
    expect(signInOnDisk()).toBe(signInOnDisk())
    clearAuthSession()
  })
})
