import { expect, it, vi } from 'vitest'
import { incrementUsageTotals } from './productUsageWrite.js'

const increments = [{ dayUtc: new Date('2026-10-14'), metric: 'turns_started', value: 2 }]
it.each([
  [{ ok: 1, n: 0, writeErrors: [{ code: 112, errmsg: 'PRIVATE_CANARY' }] }, 'P2034'],
  [{ ok: 1, n: 0, writeErrors: [{ code: 11000, errmsg: 'PRIVATE_CANARY' }] }, 'P2002'],
  [{ ok: 1, n: 0, writeErrors: [{ code: 14, errmsg: 'PRIVATE_CANARY' }] }, 'USAGE_WRITE_FAILED'],
  [{ ok: 1, n: 0 }, 'USAGE_WRITE_FAILED'],
  [{ ok: 0, n: 1 }, 'USAGE_WRITE_FAILED'],
  [{ ok: 1, n: 1, writeConcernError: { errmsg: 'PRIVATE_CANARY' } }, 'USAGE_WRITE_FAILED'],
])('aborts partial or uncertain writes without reflecting database text', async (result, code) => {
  const tx = { $runCommandRaw: vi.fn().mockResolvedValue(result) }
  await expect(incrementUsageTotals(tx, increments)).rejects.toMatchObject({ code, message: 'Product usage write unavailable' })
})
it('avoids an invalid empty update command', async () => {
  const tx = { $runCommandRaw: vi.fn() }
  await incrementUsageTotals(tx, [])
  expect(tx.$runCommandRaw).not.toHaveBeenCalled()
})
