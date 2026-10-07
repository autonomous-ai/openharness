/** The long-run harness must not turn missing evidence into a passing result. */
import { describe, expect, it } from 'vitest'
import type { LocalClient } from './harness/client.js'
import { slopes, TurnLedger, type Sample } from './harness/endurance.js'

describe('endurance evidence', () => {
  it('requires three independent windows before reporting memory growth', () => {
    const sample = (at: number, rssMiB: number, pid = 1): Sample => ({ at, rssMiB, name: 'core', pid, footprintMiB: null, fds: 10 })
    expect(slopes([], 0, 1000)).toEqual([])
    expect(slopes([sample(0, 10), sample(500, 10)], 0, 1000)[0]).toMatchObject({ perHour: null, windows: 1 })
    expect(slopes([sample(0, 10), sample(1000, 11), sample(2000, 12)], 0, 1000)[0]).toMatchObject({ perHour: 3600, windows: 3, fdsPerHour: 0 })
    expect(slopes([sample(0, 10), sample(1000, 11), sample(2000, 1, 2)], 0, 1000)[0]).toMatchObject({ perHour: null, restarts: 1, samples: 1 })
  })
  it('finds lost, duplicate, out-of-order and unsolicited turns including unknown agents', () => {
    const frames: LocalClient['frames'] = []
    const ledger = new TurnLedger({ frames } as LocalClient, /soak-[a-z]+-\d+/)
    const seen = (agentId: string, token: string) => frames.push({ type: 'turn_started', agentId, payload: { userMessage: token } })
    ledger.send('a', 'soak-a-1'); ledger.send('a', 'soak-a-2'); ledger.send('a', 'soak-a-3')
    seen('a', 'soak-a-2'); seen('a', 'soak-a-1'); seen('unknown', 'soak-x-1')
    expect(ledger.differences()).toEqual(['a: never seen soak-a-3 (1 of 3)', 'a: out of order', 'unknown: never sent soak-x-1'])
    seen('a', 'soak-a-2')
    expect(ledger.differences()).toContain('a: seen twice soak-a-2')
    expect(ledger.totals()).toEqual({ sent: 3, seen: 4 })
  })
})
