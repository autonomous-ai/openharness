import { describe, expect, it } from 'vitest'
import { stopsForGood } from './stopReasons.js'

describe('a core stop that keeps the daemon stopped (the master exits and launchd, systemd or Windows leave it)', () => {
  it('is a revoked sign-in or a computer in use elsewhere', () => {
    expect(['revoked', 'busy'].map(stopsForGood)).toEqual([true, true])
  })

  it('is no other stop: a signal or the master asking', () => {
    expect(['SIGTERM', 'the harnessd master asked this core to stop'].map(stopsForGood)).toEqual([false, false])
  })
})
