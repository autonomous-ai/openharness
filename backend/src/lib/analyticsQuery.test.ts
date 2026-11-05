import { beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  const table = () => ({ findMany: vi.fn(async () => []) })
  return { primary: { machine: table(), analyticsDailyBucket: table(), analyticsDailyMachine: table(), analyticsMachineState: table() },
    secondary: { machine: table(), analyticsDailyBucket: table(), analyticsDailyMachine: table(), analyticsMachineState: table() } }
})
vi.mock('./prisma.js', () => ({ prisma: m.primary, prismaSecondary: m.secondary, machineAlive: {} }))
import { analyticsOverview } from './analyticsQuery.js'

beforeEach(() => vi.clearAllMocks())

it('reads the usage totals on the secondaries and which machines are the person\'s on the primary (task #2970)', async () => {
  await analyticsOverview({ userId: 'u1', days: 7, now: new Date('2026-11-04T12:00:00Z') })
  for (const model of ['analyticsDailyBucket', 'analyticsDailyMachine', 'analyticsMachineState'] as const) {
    expect(m.secondary[model].findMany).toHaveBeenCalledOnce()
    expect(m.primary[model].findMany).not.toHaveBeenCalled()
  }
  expect(m.primary.machine.findMany).toHaveBeenCalledOnce()
  expect(m.secondary.machine.findMany).not.toHaveBeenCalled()
})
