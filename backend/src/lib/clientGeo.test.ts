import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ userUpdate: vi.fn() }))
vi.mock('./prisma.js', () => ({ prisma: { user: { update: db.userUpdate } } }))

import {
  countryCodeFromHeaders,
  resetUserCountryCacheForTests,
  stampUserCountry,
  USER_COUNTRY_WRITE_MS,
} from './clientGeo.js'

describe('countryCodeFromHeaders', () => {
  it('returns the ISO-2 code Cloudflare stamped', () => {
    expect(countryCodeFromHeaders({ 'cf-ipcountry': 'VN' })).toBe('VN')
  })

  it('normalizes case and whitespace', () => {
    expect(countryCodeFromHeaders({ 'cf-ipcountry': ' vn ' })).toBe('VN')
  })

  it('takes the first value of a repeated header', () => {
    expect(countryCodeFromHeaders({ 'cf-ipcountry': ['US', 'VN'] as unknown as string })).toBe('US')
  })

  it('is undefined when the header is absent (not behind Cloudflare)', () => {
    expect(countryCodeFromHeaders({})).toBeUndefined()
  })

  it.each(['XX', 'T1', 'xx'])('drops the Cloudflare placeholder %s', (v) => {
    expect(countryCodeFromHeaders({ 'cf-ipcountry': v })).toBeUndefined()
  })

  it.each(['', 'VNM', 'V', '12', 'V N', 'US; DROP'])('rejects the malformed value %j', (v) => {
    expect(countryCodeFromHeaders({ 'cf-ipcountry': v })).toBeUndefined()
  })
})

describe('stampUserCountry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetUserCountryCacheForTests()
    db.userUpdate.mockResolvedValue({})
  })

  it('writes lastCountryCode/lastCountryAt on the first request', async () => {
    const now = new Date('2026-09-21T10:00:00.000Z')
    await stampUserCountry('user-1', 'VN', now)
    expect(db.userUpdate).toHaveBeenCalledTimes(1)
    expect(db.userUpdate.mock.calls[0][0]).toEqual({
      where: { id: 'user-1' },
      data: { lastCountryCode: 'VN', lastCountryAt: now },
    })
  })

  it('does not write again for the same country inside the write interval', async () => {
    const t0 = new Date('2026-09-21T10:00:00.000Z')
    await stampUserCountry('user-1', 'VN', t0)
    await stampUserCountry('user-1', 'VN', new Date(t0.getTime() + USER_COUNTRY_WRITE_MS - 1))
    expect(db.userUpdate).toHaveBeenCalledTimes(1)
  })

  it('writes again once the interval has elapsed', async () => {
    const t0 = new Date('2026-09-21T10:00:00.000Z')
    await stampUserCountry('user-1', 'VN', t0)
    await stampUserCountry('user-1', 'VN', new Date(t0.getTime() + USER_COUNTRY_WRITE_MS))
    expect(db.userUpdate).toHaveBeenCalledTimes(2)
  })

  it('writes immediately when the country changes', async () => {
    const t0 = new Date('2026-09-21T10:00:00.000Z')
    await stampUserCountry('user-1', 'VN', t0)
    await stampUserCountry('user-1', 'US', new Date(t0.getTime() + 1000))
    expect(db.userUpdate).toHaveBeenCalledTimes(2)
    expect(db.userUpdate.mock.calls[1][0].data.lastCountryCode).toBe('US')
  })

  it('keys the cache per user', async () => {
    const t0 = new Date('2026-09-21T10:00:00.000Z')
    await stampUserCountry('user-1', 'VN', t0)
    await stampUserCountry('user-2', 'VN', t0)
    expect(db.userUpdate).toHaveBeenCalledTimes(2)
  })

  it('collapses a burst of parallel requests into one write', async () => {
    const t0 = new Date('2026-09-21T10:00:00.000Z')
    let release!: () => void
    db.userUpdate.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const first = stampUserCountry('user-1', 'VN', t0)
    await Promise.all([
      stampUserCountry('user-1', 'VN', t0),
      stampUserCountry('user-1', 'VN', new Date(t0.getTime() + 5)),
    ])
    release()
    await first
    expect(db.userUpdate).toHaveBeenCalledTimes(1)
  })

  it('retries on the next request after a failed write, and never throws', async () => {
    const t0 = new Date('2026-09-21T10:00:00.000Z')
    db.userUpdate.mockRejectedValueOnce(new Error('mongo down'))
    await expect(stampUserCountry('user-1', 'VN', t0)).resolves.toBeUndefined()
    await stampUserCountry('user-1', 'VN', new Date(t0.getTime() + 1000))
    expect(db.userUpdate).toHaveBeenCalledTimes(2)
  })
})
