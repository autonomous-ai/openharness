import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { startUsage, USAGE_REQUESTS } from './usage.js'

const ASKER = { local: false, owner: true }

describe('the usage service', () => {
  it('answers exactly the request it declares', () => {
    expect(Object.keys(startUsage(fakeCore())).sort()).toEqual([...USAGE_REQUESTS].sort())
  })

  it('usage_read: this machine\'s own readings, as the vendors gave them', async () => {
    const readings = [{ provider: 'claude' as const, account: 'k1', outcome: 'answered' as const, httpStatus: 200, body: { seven_day: { utilization: 42 } } }]
    const read = vi.fn(async () => readings)
    expect(await startUsage(fakeCore(), { read }).usage_read!({}, ASKER)).toEqual({ providers: readings })
    expect(read).toHaveBeenCalledOnce()
  })

  it('usage_read: a reading that fails is said, never thrown', async () => {
    const requests = startUsage(fakeCore(), { read: async () => { throw new Error('keychain locked') } })
    expect(await requests.usage_read!({}, ASKER)).toEqual({ error: 'USAGE_READ_FAILED' })
  })
})
