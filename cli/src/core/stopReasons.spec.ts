import { describe, expect, it } from 'vitest'
import { stopsForGood } from './stopReasons.js'

describe('a core stop that keeps the daemon stopped (the master exits and launchd, systemd or Windows leave it)', () => {
  it('is a revoked sign-in, a computer in use elsewhere, or a retired Team account\'s daemon (#4221)', () => {
    expect(['revoked', 'busy', 'retired'].map(stopsForGood)).toEqual([true, true, true])
  })

  it('is no other stop: a signal or the master asking', () => {
    expect(['SIGTERM', 'the harnessd master asked this core to stop'].map(stopsForGood)).toEqual([false, false])
  })
})
