/**
 * The soft-delete filter on the machine list.
 *
 * This is the one line standing between a deleted machine and an app-store binary: `/api/mobile/v1/overview`
 * builds its whole machine list from `machineService.listForUser` (routes/mobile.ts), and the mobile route's
 * own test mocks that call away — so nothing else in the suite proves a deleted machine cannot reach it.
 *
 * `prisma.machine.findMany` is mocked to genuinely EVALUATE the where-clause with Mongo semantics rather
 * than echo it back, because the bug this guards against is exactly the semantic Prisma+Mongo gets wrong:
 * a MISSING field is not null, so `{deletedAt: null}` alone silently drops every legacy row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const findMany = vi.hoisted(() => vi.fn())
const groupBy = vi.hoisted(() => vi.fn())
const planFindMany = vi.hoisted(() => vi.fn())
const runCommandRaw = vi.hoisted(() => vi.fn())
const getAgentPresence = vi.hoisted(() => vi.fn())
const readAgentPresence = vi.hoisted(() => vi.fn())

vi.mock('../lib/prisma.js', () => ({
  // The REAL helper — the thing under test is whether listForUser applies it, so stubbing it would
  // test the stub.
  machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
  prisma: {
    machine: { findMany },
    machineAgent: { groupBy },
    subscriptionPlan: { findMany: planFindMany },
    $runCommandRaw: runCommandRaw,
  },
}))
vi.mock('../lib/bus.js', () => ({
  getAgentPresence,
  readAgentPresence,
  clearAgentPresence: vi.fn(),
  publishDown: vi.fn(),
  publishDeviceMachineListChanged: vi.fn(),
}))
vi.mock('../config/env.js', () => ({ env: { HARNESS_BILLING_ENABLED: true, HARNESS_CAMPAIGN_CODE: 'ai-harness-device' } }))
vi.mock('../lib/managers.js', () => ({ selectManagerId: vi.fn() }))
vi.mock('../lib/provision.js', () => ({ provisionViaManager: vi.fn() }))
vi.mock('../lib/machineLifecycle.js', () => ({ ensureMachineReady: vi.fn(), publishMachineLifecycle: vi.fn() }))
vi.mock('../lib/machineCredential.js', () => ({ encryptMachineCredential: vi.fn() }))
vi.mock('./MachineBillingService.js', () => ({ machineBillingService: {} }))
const warn = vi.hoisted(() => vi.fn())
vi.mock('../utils/logger.js', () => ({ logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { machineService, MACHINE_LIST_MAX } = await import('./MachineService.js')

type Row = Record<string, unknown>
type Where = Record<string, unknown>

/**
 * Mongo matching semantics, deliberately faithful on the one point that matters: an ABSENT key is not
 * null. `{deletedAt: null}` matches an explicit null only — which is why `machineAlive` is an OR.
 */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((c) => matches(row, c))
    if (key === 'AND') return (cond as Where[]).every((c) => matches(row, c))
    const present = key in row
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>
      if ('isSet' in c) return c.isSet === present
      if ('in' in c) return present && (c.in as unknown[]).includes(row[key])
    }
    if (cond === null) return present && row[key] === null
    return present && row[key] === cond
  })
}

const base = { authMode: 'self', billingStatus: 'active', planId: null, createdAt: new Date('2026-01-01') }

/** One of each shape a real collection holds after years of schema drift. */
const ROWS: Row[] = [
  // Legacy: the field was never written. This is the row `{deletedAt: null}` alone would lose.
  { ...base, machineId: 'legacy', userId: 'u1' },
  { ...base, machineId: 'explicit-null', userId: 'u1', deletedAt: null },
  { ...base, machineId: 'deleted', userId: 'u1', deletedAt: new Date('2026-08-01') },
  { ...base, machineId: 'someone-else', userId: 'u2' },
]

/** What Prisma hands back for one findMany: the matching rows, newest first when asked, at most `take`, with only
 *  the selected fields when there is a `select`. */
function answer(rows: Row[], args: { where: Where; select?: Record<string, boolean>; take?: number; orderBy?: { createdAt?: 'desc' } }): Row[] {
  let out = rows.filter((r) => matches(r, args.where))
  if (args.orderBy?.createdAt === 'desc') out = [...out].sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
  if (args.take !== undefined) out = out.slice(0, args.take)
  if (!args.select) return out
  const picked = Object.keys(args.select).filter((k) => args.select![k])
  return out.map((r) => Object.fromEntries(picked.filter((k) => k in r).map((k) => [k, r[k]])))
}

beforeEach(() => {
  vi.clearAllMocks()
  findMany.mockImplementation(async (args: Parameters<typeof answer>[1]) => answer(ROWS, args))
  groupBy.mockResolvedValue([])
  planFindMany.mockResolvedValue([])
  runCommandRaw.mockResolvedValue({ cursor: { firstBatch: [] } })
  getAgentPresence.mockResolvedValue(null)
  readAgentPresence.mockResolvedValue(false)
})

const listedIds = async (env?: 'prod' | 'stag') =>
  (await machineService.listForUser('u1', env)).map((m) => m.machineId)

describe('listForUser — what the mobile app is allowed to see', () => {
  it('never returns a soft-deleted machine', async () => {
    expect(await listedIds()).not.toContain('deleted')
  })

  it('still returns a legacy row that has no deletedAt field at all', async () => {
    // The regression that filtering with a bare `{deletedAt: null}` would cause: every pre-soft-delete
    // machine vanishes from the list, which reads to the owner as their machines being gone.
    expect(await listedIds()).toContain('legacy')
  })

  it('returns a row whose deletedAt is an explicit null', async () => {
    expect(await listedIds()).toContain('explicit-null')
  })

  it('returns exactly the caller-s live machines', async () => {
    expect((await listedIds()).sort()).toEqual(['explicit-null', 'legacy'])
  })

  it('keeps the delete filter when an environment filter is also applied', async () => {
    // Both are spread into one where-clause; the alive filter is an OR, so a future sibling OR would
    // silently overwrite it. Assert the combination, not just the simple case.
    await listedIds('prod')
    const where = findMany.mock.calls[0]![0].where as Where
    expect(where.autonomousEnv).toBe('prod')
    expect(where.OR).toEqual([{ deletedAt: null }, { deletedAt: { isSet: false } }])
  })
})

describe('listForUser — a remote machine\'s presence', () => {
  const remote = (machineId: string): Row => ({ ...base, machineId, userId: 'u1', authMode: 'remote' })
  const statusOf = async (): Promise<Record<string, unknown>> =>
    Object.fromEntries((await machineService.listForUser('u1')).map((m) => [m.machineId, m.status]))

  beforeEach(() => {
    findMany.mockImplementation(async ({ where }: { where: Where }) =>
      [remote('up'), remote('down'), remote('unreadable')].filter((r) => matches(r, where)))
    readAgentPresence.mockImplementation(async (id: string) => id === 'up' ? true : id === 'down' ? false : null)
  })

  it('reads running when present, offline when absent, and unknown — never offline — when the read failed', async () => {
    // A daemon labels a model "seems offline" only on `offline` (grid-reads-without-waking issue 03), so a
    // presence store that could not be read must not say a machine is gone.
    expect(await statusOf()).toEqual({ up: 'running', down: 'offline', unreadable: 'unknown' })
  })
})

// One machine (docs/plans/2026-10-24-swarm-team-account.md): a Mac's team machine names the Mac it lives on, so a list
// can show that Mac once. Only a team machine names one; a row that is no longer a team machine names none.
describe('listForUser — the Mac a team machine lives on', () => {
  beforeEach(() => {
    findMany.mockImplementation(async ({ where }: { where: Where }) => [
      { ...base, machineId: 'laptop', userId: 'u1', sessionKind: 'computer' },
      { ...base, machineId: 'laptop-team', userId: 'u1', sessionKind: 'team', hostMachineId: 'laptop' },
      { ...base, machineId: 'mini', userId: 'u1', sessionKind: 'team' },
      { ...base, machineId: 'taken-over', userId: 'u1', sessionKind: 'computer', hostMachineId: 'laptop' },
    ].filter((r) => matches(r, where)))
  })

  it('is returned for a team machine on a Mac, and null for every other machine', async () => {
    const hosts = Object.fromEntries((await machineService.listForUser('u1')).map((m) => [m.machineId, m.hostMachineId]))
    expect(hosts).toEqual({ laptop: null, 'laptop-team': 'laptop', mini: null, 'taken-over': null })
  })
})

// DB optimization roadmap, Phase 2 item 7: the list read whole machine documents, api keys included, with no limit.
describe('listForUser — what it reads', () => {
  const API_KEY = 'a'.repeat(64)
  // Every field a machine document holds today that the list could carry, plus the secrets it must not.
  const full: Row = {
    ...base,
    id: 'obj-1', machineId: 'm-full', userId: 'u1', apiKey: API_KEY, managerId: 'mgr-1', computerId: 'cmp-1',
    workspaceId: 'ws-1', planId: 'plan-1', autonomousEnv: 'prod', authMode: 'remote', billingStatus: 'active',
    name: 'Studio', hostname: 'studio.local', sessionKind: 'team', hostMachineId: 'm-host', credentialCiphertext: 'secret',
    externalSubscriptionId: 'sub-1', createdAt: new Date('2026-03-01'),
  }

  it('gives every caller the same fields as before, and never an api key', async () => {
    findMany.mockImplementation(async (args: Parameters<typeof answer>[1]) => answer([full], args))
    planFindMany.mockResolvedValue([{ id: 'plan-1', name: 'Remote' }])
    groupBy.mockResolvedValue([{ machineId: 'm-full', _count: { _all: 3 } }])
    readAgentPresence.mockResolvedValue(true)

    const [machine] = await machineService.listForUser('u1')

    expect(machine).toEqual({
      machineId: 'm-full', computerId: 'cmp-1', workspaceId: 'ws-1', planId: 'plan-1', autonomousEnv: 'prod',
      authMode: 'remote', planName: 'Remote', billingStatus: 'active', createdAt: new Date('2026-03-01'),
      status: 'running', agentCount: 3, engine: 'claude', name: 'Studio', hostname: 'studio.local',
      sessionKind: 'team', hostMachineId: 'm-host',
    })
    expect(JSON.stringify(machine)).not.toContain(API_KEY)
  })

  it('does not read the api key or other secrets from the database', async () => {
    let read: Row[] = []
    findMany.mockImplementation(async (args: Parameters<typeof answer>[1]) => (read = answer([full], args)))

    await machineService.listForUser('u1')

    expect(read).toHaveLength(1)
    expect(read[0]).not.toHaveProperty('apiKey')
    expect(read[0]).not.toHaveProperty('credentialCiphertext')
    expect(read[0]).not.toHaveProperty('externalSubscriptionId')
  })

  it('reads at most MACHINE_LIST_MAX machines, the newest, and says so in the log', async () => {
    const many = Array.from({ length: MACHINE_LIST_MAX + 5 }, (_, i) => ({
      ...base, machineId: `m-${i}`, userId: 'u1', createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
    }))
    findMany.mockImplementation(async (args: Parameters<typeof answer>[1]) => answer(many, args))

    const listed = (await machineService.listForUser('u1')).map((m) => m.machineId)

    expect(listed).toHaveLength(MACHINE_LIST_MAX)
    expect(listed[0]).toBe(`m-${MACHINE_LIST_MAX + 4}`)
    expect(listed).not.toContain('m-0')
    expect(warn).toHaveBeenCalledWith('machine list cut at its limit', expect.objectContaining({ userId: 'u1', limit: MACHINE_LIST_MAX }))
  })

  it('logs nothing for an account under the limit', async () => {
    await machineService.listForUser('u1')
    expect(warn).not.toHaveBeenCalled()
  })
})
