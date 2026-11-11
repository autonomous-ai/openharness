import { beforeEach, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ productUsageActivity: { findMany: vi.fn() }, productUsageTotal: { upsert: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() }, $runCommandRaw: vi.fn() }))
vi.mock('../lib/prisma.js', () => ({ prisma: db }))
import { rollupPeople } from './ProductUsagePeopleRollupService.js'

beforeEach(() => { vi.resetAllMocks(); db.$runCommandRaw.mockImplementation(async command => ({ ok: 1, n: command.updates.length })) })
const sent = () => db.$runCommandRaw.mock.calls.flatMap(([command]) => command.updates as Array<{ q: { dayUtc: { $date: string }; metric: string }; u: unknown; upsert: boolean }>)

it('reads only the live window of marks and writes totals with $set, never $inc', async () => {
  db.productUsageActivity.findMany.mockResolvedValue([
    { subject: 'x', dayUtc: new Date('2026-10-12'), surfaces: ['web'], worked: true, signupDay: new Date('2026-09-01'), staff: false },
  ])
  const written = await rollupPeople(new Date('2026-10-14T05:00:00Z'))
  expect(db.productUsageActivity.findMany.mock.calls[0][0].where).toEqual({ dayUtc: { gte: new Date('2026-10-05') } })
  expect(written).toBeGreaterThan(0)
  expect(sent()).toContainEqual({ q: { dayUtc: { $date: '2026-10-12T00:00:00.000Z' }, metric: 'people_active' }, u: { $set: { value: 1 } }, upsert: true })
  expect(JSON.stringify(db.$runCommandRaw.mock.calls)).not.toContain('"x"')
  expect(JSON.stringify(db.$runCommandRaw.mock.calls)).not.toContain('$inc')
})

it('reads the hosting mark and writes its total', async () => {
  db.productUsageActivity.findMany.mockResolvedValue([
    { subject: 'x', dayUtc: new Date('2026-10-12'), surfaces: [], worked: false, hosting: true, signupDay: new Date('2026-09-01'), staff: false },
  ])
  await rollupPeople(new Date('2026-10-14T05:00:00Z'))
  expect(db.productUsageActivity.findMany.mock.calls[0][0].select).toMatchObject({ hosting: true })
  expect(sent()).toContainEqual({ q: { dayUtc: { $date: '2026-10-12T00:00:00.000Z' }, metric: 'people_hosting' }, u: { $set: { value: 1 } }, upsert: true })
})

it('writes every total in a few commands and reads nothing from the totals first', async () => {
  db.productUsageActivity.findMany.mockResolvedValue([
    { subject: 'x', dayUtc: new Date('2026-10-12'), surfaces: ['web'], worked: true, signupDay: new Date('2026-09-01'), staff: false },
  ])
  const written = await rollupPeople(new Date('2026-10-14T05:00:00Z'))
  expect(sent()).toHaveLength(written)
  expect(db.$runCommandRaw.mock.calls.length).toBe(Math.ceil(written / 500))
  expect(db.productUsageTotal.upsert).not.toHaveBeenCalled()
  expect(db.productUsageTotal.findFirst).not.toHaveBeenCalled()
  expect(db.productUsageTotal.findUnique).not.toHaveBeenCalled()
})
