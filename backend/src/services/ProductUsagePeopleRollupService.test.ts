import { beforeEach, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ productUsageActivity: { findMany: vi.fn() }, productUsageTotal: { upsert: vi.fn() } }))
vi.mock('../lib/prisma.js', () => ({ prisma: db }))
import { rollupPeople } from './ProductUsagePeopleRollupService.js'

beforeEach(() => { vi.resetAllMocks(); db.productUsageTotal.upsert.mockResolvedValue({}) })

it('reads only the live window of marks and writes totals with $set, never $inc', async () => {
  db.productUsageActivity.findMany.mockResolvedValue([
    { subject: 'x', dayUtc: new Date('2026-10-12'), surfaces: ['web'], worked: true, signupDay: new Date('2026-09-01'), staff: false },
  ])
  const written = await rollupPeople(new Date('2026-10-14T05:00:00Z'))
  expect(db.productUsageActivity.findMany.mock.calls[0][0].where).toEqual({ dayUtc: { gte: new Date('2026-10-05') } })
  expect(written).toBeGreaterThan(0)
  expect(db.productUsageTotal.upsert).toHaveBeenCalledWith({
    where: { dayUtc_metric: { dayUtc: new Date('2026-10-12'), metric: 'people_active' } },
    create: { dayUtc: new Date('2026-10-12'), metric: 'people_active', value: 1 }, update: { value: 1 },
  })
  expect(JSON.stringify(db.productUsageTotal.upsert.mock.calls)).not.toContain('"x"')
})

it('reads the hosting mark and writes its total', async () => {
  db.productUsageActivity.findMany.mockResolvedValue([
    { subject: 'x', dayUtc: new Date('2026-10-12'), surfaces: [], worked: false, hosting: true, signupDay: new Date('2026-09-01'), staff: false },
  ])
  await rollupPeople(new Date('2026-10-14T05:00:00Z'))
  expect(db.productUsageActivity.findMany.mock.calls[0][0].select).toMatchObject({ hosting: true })
  expect(db.productUsageTotal.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: { dayUtc: new Date('2026-10-12'), metric: 'people_hosting', value: 1 } }))
})
