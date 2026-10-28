import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }))

const db = vi.hoisted(() => ({
  productUsagePreference: { findUnique: vi.fn(), upsert: vi.fn() },
  analyticsMachineState: { findFirst: vi.fn() },
  productUsageReceipt: { create: vi.fn(), findUnique: vi.fn() },
  productUsageTotal: { upsert: vi.fn(), update: vi.fn(), groupBy: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
  userDailyPresence: { deleteMany: vi.fn() }, userDailyClientPresence: { deleteMany: vi.fn() },
  userDailyRemoteUsage: { deleteMany: vi.fn() }, userDailyDevicePresence: { deleteMany: vi.fn() },
  machineDailyPresence: { deleteMany: vi.fn() }, agentDailyPresence: { deleteMany: vi.fn() },
  productUsageActivity: { upsert: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  user: { findUnique: vi.fn() },
  $transaction: vi.fn(), $runCommandRaw: vi.fn(),
}))
vi.mock('./prisma.js', () => ({ prisma: db }))
// A configured key, so deletion through setProductUsageChoice and the legacy delete path is real.
vi.mock('../config/env.js', () => ({ env: { PRODUCT_USAGE_SUBJECT_KEY: 'k'.repeat(32) } }))
import { activitySubject, deleteActivity, deleteLegacyProductUsage, ensureProductUsageExpiry, markActivity, resetActivityMarksForTests, resetStaffAccountsForTests, ingestProductUsage, ingestSetupUsage, productUsageChoice, recordRelayUsage, setProductUsageChoice } from './productUsage.js'
import { LAUNCH_ERROR_CODES, LAUNCH_ERROR_FAMILIES, PRODUCT_USAGE_METRICS, type ProductUsageReport } from '../types/productUsage.js'

it('commits release and platform margins under the same unlinked receipt and discards development reports', async () => {
  const context = { surface: 'desktop', release: '1.2.73', platform: 'macos', channel: 'production' } as const
  expect(await ingestProductUsage('PRIVATE_ACCOUNT', { ...report, context }, now)).toEqual({ accepted: true })
  expect(db.$transaction).toHaveBeenCalledOnce()
  expect(db.$runCommandRaw.mock.calls[0][0].updates).toHaveLength(6)
  const stored = JSON.stringify([db.productUsageReceipt.create.mock.calls, db.$runCommandRaw.mock.calls])
  expect(stored).not.toContain('PRIVATE_ACCOUNT')
  expect(stored).not.toContain('1.2.73:macos')
  expect(stored).toContain('breakdown:release:desktop:1.2.73:turns_started')
  db.$transaction.mockClear()
  expect(await ingestProductUsage('PRIVATE_ACCOUNT', { ...report, context: { ...context, channel: 'development' } }, now)).toMatchObject({ accepted: true, reason: 'DEVELOPMENT' })
  expect(db.$transaction).not.toHaveBeenCalled()
})

const report: ProductUsageReport = { schemaVersion: 1, revision: 0, id: 'cf1c5a03-388c-4265-b5fb-a4c3d47e407f', day: '2026-10-13', counters: { turns_started: 4, turns_ended: 3 } }
const now = new Date('2026-10-13T12:00:00Z')
beforeEach(() => {
  vi.resetAllMocks()
  db.$runCommandRaw.mockImplementation(async command => ({ ok: 1, n: command.updates?.length ?? 0 }))
  db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db))
  db.productUsagePreference.findUnique.mockResolvedValue(null)
  db.analyticsMachineState.findFirst.mockResolvedValue(null)
  resetActivityMarksForTests()
  resetStaffAccountsForTests()
  db.user.findUnique.mockResolvedValue({ createdAt: new Date('2026-10-01T08:00:00Z'), email: 'person@example.com' })
})

describe('kept apart', () => {
  const stored = (): string[] => db.$runCommandRaw.mock.calls.flatMap(([command]) =>
    (command as { updates: Array<{ q: { metric: string } }> }).updates.map(update => update.q.metric))

  it('keeps the team\'s own accounts under staff:, with their margins and late marks', async () => {
    db.user.findUnique.mockResolvedValue({ createdAt: new Date('2026-10-01T08:00:00Z'), email: 'Dee@Autonomous.AI' })
    const context = { surface: 'phone', release: '1.0.7', platform: 'ios', channel: 'production' } as const
    expect(await ingestProductUsage('team-account', { ...report, day: '2026-10-12', context }, now)).toEqual({ accepted: true })
    expect(stored()).toEqual(expect.arrayContaining(['staff:turns_started', 'staff:breakdown:release:phone:1.0.7:turns_started',
      'staff:health_phone_report_late']))
    expect(stored().every(metric => metric.startsWith('staff:'))).toBe(true)
  })

  it('keeps a tester\'s build under testing:, without margins, whoever signed in', async () => {
    const context = { surface: 'phone', release: '1.0.7', platform: 'ios', channel: 'testing' } as const
    expect(await ingestProductUsage('someone', { ...report, context }, now)).toEqual({ accepted: true })
    expect(stored()).toEqual(['testing:turns_started', 'testing:turns_ended'])
    // A build's channel decides it: no account is read for it.
    expect(db.user.findUnique).not.toHaveBeenCalled()
  })

  it('leaves everyone else\'s totals as they were, and asks for an account once', async () => {
    const context = { surface: 'phone', release: '1.0.7', platform: 'ios', channel: 'production' } as const
    await ingestProductUsage('person', { ...report, context }, now)
    await ingestProductUsage('person', { ...report, id: 'cf1c5a03-388c-4265-b5fb-a4c3d47e4080', context }, now)
    expect(stored().filter(metric => metric.includes(':') && !metric.startsWith('breakdown:'))).toEqual([])
    expect(stored()).toContain('turns_started')
    expect(db.user.findUnique).toHaveBeenCalledOnce()
  })

  it('reads no account for signed-out setup counts', async () => {
    expect(await ingestSetupUsage({ id: 'cf1c5a03-388c-4265-b5fb-a4c3d47e4081', day: '2026-10-13',
      counters: { setup_phone_first_open: 1 } }, now)).toEqual({ accepted: true })
    expect(stored()).toEqual(['setup_phone_first_open'])
    expect(db.user.findUnique).not.toHaveBeenCalled()
  })
})

it('keeps the client and server vocabulary identical', () => {
  expect(readFileSync(new URL('../../../cli/src/lib/productUsageContract.ts', import.meta.url), 'utf8'))
    .toBe(readFileSync(new URL('../types/productUsage.ts', import.meta.url), 'utf8'))
})

it('names launch refusals and agent-started launches', () => {
  const metrics = new Set<string>(PRODUCT_USAGE_METRICS)
  for (const m of ['launch_refused', 'launch_agent_started', 'launch_agent_created', 'launch_agent_failed', 'launch_agent_refused',
    'launch_refused_code_session_in_harness', 'launch_refused_code_invalid_request']) expect(metrics.has(m), m).toBe(true)
})

it('names every launch code in each of its families, once, as a fixed word that can carry no message', () => {
  const metrics = new Set<string>(PRODUCT_USAGE_METRICS)
  expect(metrics.size).toBe(PRODUCT_USAGE_METRICS.length)
  for (const family of LAUNCH_ERROR_FAMILIES) for (const code of LAUNCH_ERROR_CODES) expect(metrics.has(`${family}_${code}`), `${family}_${code}`).toBe(true)
  for (const code of LAUNCH_ERROR_CODES) expect(code).toMatch(/^[a-z][a-z0-9_]{1,39}$/)
  expect(new Set(LAUNCH_ERROR_CODES).size).toBe(LAUNCH_ERROR_CODES.length)
  expect(LAUNCH_ERROR_CODES).toEqual(expect.arrayContaining(['unlisted', 'none']))
  for (const name of ['launch_late_failed', 'first_launch_engine_opencode', 'first_launch_engine_other', 'first_launch_codex_signed_out']) expect(metrics.has(name), name).toBe(true)
})

it('stores launch codes as day totals like any other counter', async () => {
  const counters = { launch_failed_other: 2, launch_failed_code_invalid_prompt: 1, launch_failed_code_unlisted: 1, first_launch_claude_signed_in: 1 }
  expect(await ingestProductUsage('private-account', { ...report, counters }, now)).toEqual({ accepted: true })
  expect(db.$runCommandRaw.mock.calls[0][0].updates.map((u: { q: { metric: string }; u: unknown }) => [u.q.metric, u.u]))
    .toEqual(Object.entries(counters).map(([metric, value]) => [metric, { $inc: { value } }]))
})

it('accepts the Windows and Git helper refusals that older launch reports called unlisted', async () => {
  const codes = ['engine_launch_refused', 'pty_host_unavailable', 'git_project_unavailable', 'branch_exists',
    'invalid_branch', 'branch_switch_failed', 'branch_in_use', 'worktree_failed']
  const counters = Object.fromEntries(codes.map(code => [`launch_failed_code_${code}`, 1]))
  expect(await ingestProductUsage('private-account', { ...report, counters }, now)).toEqual({ accepted: true })
  expect(db.$runCommandRaw.mock.calls[0][0].updates.map((u: { q: { metric: string } }) => u.q.metric))
    .toEqual(Object.keys(counters))
})

it('stores setup reasons in separate families without reinterpreting the other-failure totals', async () => {
  const counters = {
    launch_failed_setup: 2, launch_failed_setup_code_tmux_unavailable: 1, launch_failed_setup_code_native_launch_held: 1,
    create_error_setup: 2, create_error_setup_code_tmux_unavailable: 1, create_error_setup_code_pty_host_unavailable: 1,
    request_phone_create_error_setup: 1, phone_create_error_setup_code_tmux_unavailable: 1,
    launch_failed_other: 1, launch_failed_code_worktree_failed: 1,
  }
  expect(await ingestProductUsage('private-account', { ...report, counters }, now)).toEqual({ accepted: true })
  const stored = db.$runCommandRaw.mock.calls[0][0].updates.map((u: { q: { metric: string }; u: unknown }) => [u.q.metric, u.u])
  expect(stored).toEqual(Object.entries(counters).map(([metric, value]) => [metric, { $inc: { value } }]))
  expect(JSON.stringify(stored)).not.toContain('private-account')
})

describe('preference', () => {
  it('defaults on but preserves a prior off choice', async () => {
    expect(await productUsageChoice('private-account')).toEqual({ enabled: true, revision: 0 })
    db.analyticsMachineState.findFirst.mockResolvedValue({ id: 'old-setting' })
    expect(await productUsageChoice('private-account')).toEqual({ enabled: false, revision: 0 })
    db.productUsagePreference.findUnique.mockResolvedValue({ enabled: false, revision: 9 })
    expect(await productUsageChoice('private-account')).toEqual({ enabled: false, revision: 9 })
  })
  it('advances the queue generation on every saved choice', async () => {
    await setProductUsageChoice('account', false)
    expect(db.productUsagePreference.upsert.mock.calls[0][0]).toMatchObject({
      create: { userId: 'account', enabled: false, revision: 1 }, update: { enabled: false, revision: { increment: 1 } },
    })
  })
})

describe('aggregate ingestion', () => {
  it('rechecks permission after waiting for another report without caching an enabled choice', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    // Four reports fill this process's write slots; the fifth waits for one.
    for (let i = 0; i < 4; i++) db.$transaction.mockImplementationOnce(async fn => { await gate; return fn(db) })
    const first = [0, 1, 2, 3].map(i => ingestProductUsage(`account-${i}`, { ...report, id: `receipt-${i}` }, now))
    const queued = ingestProductUsage('opted-out-while-queued', { ...report, id: 'another-receipt' }, now)
    await Promise.resolve()
    expect(db.$transaction).toHaveBeenCalledTimes(4)
    for (let i = 0; i < 4; i++) db.productUsagePreference.findUnique.mockResolvedValueOnce({ enabled: true, revision: 0 })
    db.productUsagePreference.findUnique.mockResolvedValueOnce({ enabled: false, revision: 1 })
    release()
    expect(await Promise.all(first)).toEqual(Array(4).fill({ accepted: true }))
    expect(await queued).toMatchObject({ accepted: false, reason: 'CHOICE_CHANGED' })
    expect(db.productUsageReceipt.create).toHaveBeenCalledTimes(4)
  })
  it('stores only totals and an unlinked receipt, in one transaction', async () => {
    expect(await ingestProductUsage('private-account', report, now)).toEqual({ accepted: true })
    expect(db.$transaction).toHaveBeenCalledOnce()
    expect(db.$runCommandRaw).toHaveBeenCalledOnce()
    expect(db.$runCommandRaw.mock.calls[0][0]).toEqual({
      update: 'product_usage_totals', ordered: true, updates: [
        { q: { dayUtc: { $date: '2026-10-13T00:00:00.000Z' }, metric: 'turns_started' }, u: { $inc: { value: 4 } }, upsert: true },
        { q: { dayUtc: { $date: '2026-10-13T00:00:00.000Z' }, metric: 'turns_ended' }, u: { $inc: { value: 3 } }, upsert: true },
      ],
    })
    const stored = JSON.stringify([db.$runCommandRaw.mock.calls, db.productUsageReceipt.create.mock.calls])
    for (const forbidden of ['private-account', 'userId', 'machineId', 'agentId', 'revision', 'counters', 'receivedAt']) expect(stored).not.toContain(forbidden)
  })
  it('rejects opted-out and stale queued uploads without receipts or counters', async () => {
    db.productUsagePreference.findUnique.mockResolvedValue({ enabled: false, revision: 1 })
    expect(await ingestProductUsage('a', report, now)).toMatchObject({ accepted: false, reason: 'CHOICE_CHANGED' })
    db.productUsagePreference.findUnique.mockResolvedValue({ enabled: true, revision: 2 })
    expect(await ingestProductUsage('a', report, now)).toMatchObject({ accepted: false, reason: 'CHOICE_CHANGED' })
    expect(db.productUsageReceipt.create).not.toHaveBeenCalled()
    expect(db.$runCommandRaw).not.toHaveBeenCalled()
  })
  it.each(['2026-09-08', '2026-10-14', '2026-02-30', 'bad'])('refuses expired/future/invalid day %s', async day => {
    expect(await ingestProductUsage('a', { ...report, day }, now)).toEqual({ accepted: false, reason: 'EXPIRED' })
    expect(db.$transaction).not.toHaveBeenCalled()
  })
  it('accepts a previously committed receipt without incrementing again', async () => {
    db.productUsageReceipt.create.mockRejectedValue({ code: 'P2002' })
    db.productUsageReceipt.findUnique.mockResolvedValue({ id: report.id })
    expect(await ingestProductUsage('a', report, now)).toEqual({ accepted: true })
    expect(db.$runCommandRaw).not.toHaveBeenCalled()
  })
  it('does not mistake a rolled-back aggregate creation race for a received report', async () => {
    db.$runCommandRaw.mockRejectedValue({ code: 'P2002' })
    db.productUsageReceipt.findUnique.mockResolvedValue(null)
    await expect(ingestProductUsage('a', report, now)).rejects.toMatchObject({ code: 'P2002' })
    expect(db.$transaction).toHaveBeenCalledTimes(4)
    expect(delay).toHaveBeenCalledTimes(3)
  })
  it.each(['P2034', 'P2002'])('retries a fast %s conflict with the same receipt and a fresh permission check', async code => {
    db.$runCommandRaw.mockRejectedValueOnce({ code })
    expect(await ingestProductUsage('private-account', report, now)).toEqual({ accepted: true })
    expect(db.$transaction).toHaveBeenCalledTimes(2)
    expect(db.productUsagePreference.findUnique).toHaveBeenCalledTimes(2)
    expect(db.productUsageReceipt.create.mock.calls[0]).toEqual(db.productUsageReceipt.create.mock.calls[1])
    expect(delay).toHaveBeenCalledExactlyOnceWith(expect.any(Number))
    expect(vi.mocked(delay).mock.calls[0][0]).toBeGreaterThanOrEqual(25)
    expect(vi.mocked(delay).mock.calls[0][0]).toBeLessThan(75)
  })
  it('retries a Mongo lock wait like a conflict, with the same receipt', async () => {
    db.$runCommandRaw.mockRejectedValueOnce(new Error('Error code 24 (LockTimeout): Unable to acquire IX lock, labels: {"TransientTransactionError"}'))
    expect(await ingestProductUsage('a', report, now)).toEqual({ accepted: true })
    expect(db.$transaction).toHaveBeenCalledTimes(2)
    expect(db.productUsageReceipt.create.mock.calls[0]).toEqual(db.productUsageReceipt.create.mock.calls[1])
    expect(delay).toHaveBeenCalledOnce()
  })
  it('rechecks a sharing-off choice before retrying the transaction', async () => {
    db.$runCommandRaw.mockRejectedValueOnce({ code: 'P2034' })
    db.productUsagePreference.findUnique.mockResolvedValueOnce({ enabled: true, revision: 0 })
      .mockResolvedValueOnce({ enabled: false, revision: 1 })
    expect(await ingestProductUsage('a', report, now)).toMatchObject({ accepted: false, reason: 'CHOICE_CHANGED' })
    expect(db.$transaction).toHaveBeenCalledTimes(2)
    expect(db.productUsageReceipt.create).toHaveBeenCalledOnce()
  })
  it('bounds persistent conflicts and does not retry unrelated storage errors', async () => {
    db.$transaction.mockRejectedValue({ code: 'P2034' })
    await expect(ingestProductUsage('a', report, now)).rejects.toMatchObject({ code: 'P2034' })
    expect(db.$transaction).toHaveBeenCalledTimes(4)
    expect(delay).toHaveBeenCalledTimes(3)
    vi.mocked(delay).mockClear(); db.$transaction.mockClear().mockRejectedValue({ code: 'P2028' })
    await expect(ingestProductUsage('a', report, now)).rejects.toMatchObject({ code: 'P2028' })
    expect(db.$transaction).toHaveBeenCalledOnce(); expect(delay).not.toHaveBeenCalled()
  })
  it('does not extend an already slow conflict with another transaction', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(1000)
    try {
      db.$transaction.mockRejectedValue({ code: 'P2034' })
      await expect(ingestProductUsage('a', report, now)).rejects.toMatchObject({ code: 'P2034' })
      expect(db.$transaction).toHaveBeenCalledOnce(); expect(delay).not.toHaveBeenCalled()
    } finally { clock.mockRestore() }
  })
  it('checks the retry window again after a delayed timer wakes', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1000)
    try {
      db.$transaction.mockRejectedValue({ code: 'P2034' })
      await expect(ingestProductUsage('a', report, now)).rejects.toMatchObject({ code: 'P2034' })
      expect(db.$transaction).toHaveBeenCalledOnce(); expect(delay).toHaveBeenCalledOnce()
    } finally { clock.mockRestore() }
  })
  it('fails closed when the preference cannot be checked', async () => {
    db.productUsagePreference.findUnique.mockRejectedValue(new Error('unavailable'))
    await expect(ingestProductUsage('a', report, now)).rejects.toThrow()
    expect(db.productUsageReceipt.create).not.toHaveBeenCalled()
  })
})

it('the legacy relay respects off and writes only an aggregate counter when on', async () => {
  db.productUsagePreference.findUnique.mockResolvedValue({ enabled: false, revision: 1 })
  await recordRelayUsage('private-account', now, 'relay_turns_started')
  expect(db.productUsageTotal.upsert).not.toHaveBeenCalled()
  db.productUsagePreference.findUnique.mockResolvedValue({ enabled: true, revision: 2 })
  await recordRelayUsage('private-account', now, 'relay_turns_started')
  expect(JSON.stringify(db.productUsageTotal.upsert.mock.calls)).not.toContain('private-account')
})

it('one relay event adds to each total it names under a single preference read', async () => {
  db.productUsagePreference.findUnique.mockResolvedValue({ enabled: true, revision: 2 })
  await recordRelayUsage('private-account', now, 'relay_mobile_opens', ['breakdown:release:phone:1.0.8:relay_mobile_opens'])
  expect(db.productUsagePreference.findUnique).toHaveBeenCalledOnce()
  expect(db.productUsageTotal.upsert.mock.calls.map(([call]) => [call.where.dayUtc_metric.metric, call.create.value, call.update.value])).toEqual([
    ['relay_mobile_opens', 1, { increment: 1 }], ['breakdown:release:phone:1.0.8:relay_mobile_opens', 1, { increment: 1 }]])
  expect(JSON.stringify(db.productUsageTotal.upsert.mock.calls)).not.toContain('private-account')
  db.productUsageTotal.upsert.mockClear()
  db.productUsagePreference.findUnique.mockResolvedValue({ enabled: false, revision: 3 })
  await recordRelayUsage('private-account', now, 'relay_mobile_opens', ['relay_mobile_debug_opens'])
  expect(db.productUsageTotal.upsert).not.toHaveBeenCalled()
})

it('a relay metrics failure cannot interrupt work or log an identity or database error', async () => {
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
  db.productUsagePreference.findUnique.mockRejectedValue(new Error('PRIVATE_DATABASE_CANARY'))
  await expect(recordRelayUsage('PRIVATE_ACCOUNT_CANARY', now, 'relay_turns_started')).resolves.toBeUndefined()
  expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_')
  expect(db.productUsageTotal.upsert).not.toHaveBeenCalled()
  log.mockRestore()
})

it('the legacy delete path erases all six linked activity collections', async () => {
  await deleteLegacyProductUsage('account')
  for (const name of ['userDailyPresence', 'userDailyClientPresence', 'userDailyRemoteUsage', 'userDailyDevicePresence', 'machineDailyPresence', 'agentDailyPresence'] as const)
    expect(db[name].deleteMany).toHaveBeenCalledWith({ where: { userId: 'account' } })
  expect(db.productUsageActivity.deleteMany).toHaveBeenCalledWith({ where: { subject: activitySubject('account', 'k'.repeat(32)) } })
})

it('installs required unique keys independently of schema push, then expiry for all histories', async () => {
  await ensureProductUsageExpiry()
  expect(db.$runCommandRaw).toHaveBeenCalledTimes(14)
  expect(db.$runCommandRaw.mock.calls[12][0]).toMatchObject({ createIndexes: 'product_usage_activity', indexes: [{ key: { expiresAt: 1 }, expireAfterSeconds: 0 }] })
  expect(db.$runCommandRaw.mock.calls[13][0]).toMatchObject({ createIndexes: 'product_usage_activity', indexes: [{ key: { subject: 1, dayUtc: 1 }, unique: true }] })
  expect(db.$runCommandRaw.mock.calls[0][0]).toMatchObject({ createIndexes: 'product_usage_preferences', indexes: [{ key: { userId: 1 }, unique: true }] })
  expect(db.$runCommandRaw.mock.calls[1][0]).toMatchObject({ createIndexes: 'product_usage_totals', indexes: [{ key: { dayUtc: 1, metric: 1 }, unique: true }] })
  expect(db.$runCommandRaw.mock.calls[2][0]).toMatchObject({ createIndexes: 'product_usage_receipts', indexes: [{ expireAfterSeconds: 0 }] })
  expect(db.$runCommandRaw.mock.calls[4][0]).toMatchObject({ createIndexes: 'user_daily_presence', indexes: [{ expireAfterSeconds: 35 * 86400 }] })
  expect(db.productUsageTotal.groupBy).not.toHaveBeenCalled()
})

it('merges duplicate counters transactionally before installing their unique key', async () => {
  db.$runCommandRaw.mockResolvedValueOnce({}).mockRejectedValueOnce({ meta: { message: 'E11000 duplicate key' } })
  db.productUsageTotal.groupBy.mockResolvedValue([{ dayUtc: now, metric: 'relay_turns_started' }])
  db.productUsageTotal.findMany.mockResolvedValue([{ id: 'keep', value: 2 }, { id: 'duplicate', value: 5 }])
  await ensureProductUsageExpiry()
  expect(db.$transaction).toHaveBeenCalledOnce()
  expect(db.productUsageTotal.update).toHaveBeenCalledWith({ where: { id: 'keep' }, data: { value: { increment: 5 } } })
  expect(db.productUsageTotal.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['duplicate'] } } })
})

it('retries a conflicting repair but fails startup for unrelated database failures', async () => {
  db.$runCommandRaw.mockResolvedValueOnce({}).mockRejectedValueOnce({ meta: { code: 11000 } })
  db.$transaction.mockRejectedValueOnce({ code: 'P2034' })
  await expect(ensureProductUsageExpiry()).resolves.toBeUndefined()
  db.$runCommandRaw.mockRejectedValueOnce(new Error('permission denied'))
  await expect(ensureProductUsageExpiry()).rejects.toThrow('permission denied')
})

it('bounds duplicate repair work and refuses to claim readiness without a unique key', async () => {
  db.$runCommandRaw.mockResolvedValueOnce({}).mockRejectedValue({ meta: { code: 11000 } })
  db.productUsageTotal.groupBy.mockResolvedValue([])
  await expect(ensureProductUsageExpiry()).rejects.toThrow('aggregate key is not ready')
  expect(db.$transaction).toHaveBeenCalledTimes(10)
})

it('setup ingestion never reads an account and expires after yesterday', async () => {
  const setup = { id: report.id, day: report.day, counters: { setup_desktop_sign_in_ok: 1 } }
  expect(await ingestSetupUsage(setup, now)).toEqual({ accepted: true })
  expect(db.productUsagePreference.findUnique).not.toHaveBeenCalled()
  expect(db.analyticsMachineState.findFirst).not.toHaveBeenCalled()
  expect(JSON.stringify(db.productUsageReceipt.create.mock.calls)).not.toContain('setup_desktop')
  expect(await ingestSetupUsage({ ...setup, day: '2026-10-11' }, now)).toMatchObject({ reason: 'EXPIRED' })
  expect(await ingestSetupUsage({ ...setup, day: '2026-10-12' }, now)).toMatchObject({ accepted: true })
})

it('Hub totals share the setup path: unlinked receipt, atomic totals, a retried receipt counts once', async () => {
  const hub = { id: report.id, day: report.day, counters: { hub_view_harness_visitor: 3, hub_fork: 1 } }
  expect(await ingestSetupUsage(hub, now)).toEqual({ accepted: true })
  expect(db.productUsagePreference.findUnique).not.toHaveBeenCalled()
  expect(db.$runCommandRaw.mock.calls[0][0].updates).toEqual([
    { q: { dayUtc: { $date: '2026-10-13T00:00:00.000Z' }, metric: 'hub_view_harness_visitor' }, u: { $inc: { value: 3 } }, upsert: true },
    { q: { dayUtc: { $date: '2026-10-13T00:00:00.000Z' }, metric: 'hub_fork' }, u: { $inc: { value: 1 } }, upsert: true },
  ])
  db.$runCommandRaw.mockClear()
  db.productUsageReceipt.create.mockRejectedValue({ code: 'P2002' })
  db.productUsageReceipt.findUnique.mockResolvedValue({ id: report.id })
  expect(await ingestSetupUsage(hub, now)).toEqual({ accepted: true })
  expect(db.$runCommandRaw).not.toHaveBeenCalled()
  expect(await ingestSetupUsage({ ...hub, day: '2026-10-11' }, now)).toMatchObject({ reason: 'EXPIRED' })
})

it('keeps anonymous transport and the phone opt-in unchanged while Desktop evolves independently', () => {
  expect(readFileSync(new URL('../../../desktop/lib/measurement/setup_transport.dart', import.meta.url), 'utf8'))
    .toBe(readFileSync(new URL('../../../mobile/lib/measurement/setup_transport.dart', import.meta.url), 'utf8'))
  // Desktop keeps its Settings-only default-on preference; the phone defaults on too, with its opt-out
  // kept on the phone and carried to the account at sign-in — and says so on its signed-out line.
  const choice = (app: string) => readFileSync(new URL(`../../../${app}/lib/measurement/setup_usage_choice.dart`, import.meta.url), 'utf8')
  for (const words of ['Share setup and sign-in counts',
    'On unless you turn it off; off also turns it off for your account when you sign in. Helps us find setup problems without sharing account details, prompts, or files.']) {
    expect(choice('mobile')).toContain(`'${words}'`)
  }
  const mobile = readFileSync(new URL('../../../mobile/lib/measurement/product_measurement.dart', import.meta.url), 'utf8')
  const desktop = readFileSync(new URL('../../../desktop/lib/measurement/product_measurement.dart', import.meta.url), 'utf8')
  const mobileFlows = [...mobile.split('enum ProductOutcome')[0].matchAll(/\w+\('([a-z_]+)'\)/g)].map(m => m[1])
  for (const flow of mobileFlows) expect(desktop).toContain(`'${flow}'`)
  expect(mobile).not.toContain('product_health_contract.dart')
})

describe('activity marks', () => {
  const KEY = 'k'.repeat(32)
  const at = new Date('2026-10-13T12:00:00Z')

  it('writes one pseudonymous mark per person per day, never the account id', async () => {
    await markActivity('PRIVATE_ACCOUNT', at, { surface: 'desktop' }, KEY)
    expect(db.productUsageActivity.upsert).toHaveBeenCalledOnce()
    const call = db.productUsageActivity.upsert.mock.calls[0][0]
    const subject = activitySubject('PRIVATE_ACCOUNT', KEY)
    expect(subject).toMatch(/^[0-9a-f]{32}$/)
    expect(call).toEqual({
      where: { subject_dayUtc: { subject, dayUtc: new Date('2026-10-13') } },
      update: { surfaces: { push: 'desktop' } },
      create: { subject, dayUtc: new Date('2026-10-13'), surfaces: ['desktop'], worked: false,
        signupDay: new Date('2026-10-01'), staff: false, expiresAt: new Date('2026-10-23') },
    })
    expect(JSON.stringify(call)).not.toContain('PRIVATE_ACCOUNT')
    expect(JSON.stringify(call)).not.toContain('person@example.com')
  })

  it('writes nothing without a key or while sharing is off', async () => {
    await markActivity('a', at, { surface: 'desktop' }, '')
    db.productUsagePreference.findUnique.mockResolvedValue({ enabled: false, revision: 3 })
    await markActivity('a', at, { surface: 'desktop' }, KEY)
    expect(db.productUsageActivity.upsert).not.toHaveBeenCalled()
  })

  it('costs one write per person, surface and kind a day, however often pings arrive', async () => {
    for (let i = 0; i < 5; i++) await markActivity('a', at, { surface: 'desktop' }, KEY)
    await markActivity('a', at, { surface: 'mobile' }, KEY)
    for (let i = 0; i < 3; i++) await markActivity('a', at, { worked: true }, KEY)
    expect(db.productUsageActivity.upsert).toHaveBeenCalledTimes(3)
    expect(db.productUsageActivity.upsert.mock.calls[2][0].update).toEqual({ worked: true })
  })

  it('starts a new day at UTC midnight', async () => {
    await markActivity('a', new Date('2026-10-13T23:59:59.999Z'), { surface: 'web' }, KEY)
    await markActivity('a', new Date('2026-10-14T00:00:00.000Z'), { surface: 'web' }, KEY)
    expect(db.productUsageActivity.upsert.mock.calls.map(c => c[0].where.subject_dayUtc.dayUtc))
      .toEqual([new Date('2026-10-13'), new Date('2026-10-14')])
  })

  it('marks staff so the rollup can leave them out', async () => {
    db.user.findUnique.mockResolvedValue({ createdAt: at, email: 'Someone@Autonomous.AI' })
    await markActivity('a', at, { worked: true }, KEY)
    expect(db.productUsageActivity.upsert.mock.calls[0][0].create).toMatchObject({ staff: true, worked: true, surfaces: [] })
  })

  it('retries a lost first-insert race as an update', async () => {
    db.productUsageActivity.upsert.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }))
    await markActivity('a', at, { surface: 'tui' }, KEY)
    expect(db.productUsageActivity.update).toHaveBeenCalledWith({
      where: { subject_dayUtc: { subject: activitySubject('a', KEY), dayUtc: new Date('2026-10-13') } },
      data: { surfaces: { push: 'tui' } },
    })
  })

  it('deletes the person\'s marks when sharing is turned off, and writes no more that day', async () => {
    await markActivity('a', at, { surface: 'desktop' }, KEY)
    db.productUsagePreference.upsert.mockResolvedValue({ enabled: false, revision: 2 })
    await setProductUsageChoice('a', false)
    expect(db.productUsageActivity.deleteMany).toHaveBeenCalledWith({ where: { subject: activitySubject('a', KEY) } })
    db.productUsagePreference.findUnique.mockResolvedValue({ enabled: false, revision: 2 })
    await markActivity('a', at, { surface: 'desktop' }, KEY)
    expect(db.productUsageActivity.upsert).toHaveBeenCalledOnce()
  })

  it('turning sharing on deletes nothing', async () => {
    db.productUsagePreference.upsert.mockResolvedValue({ enabled: true, revision: 3 })
    await setProductUsageChoice('a', true)
    expect(db.productUsageActivity.deleteMany).not.toHaveBeenCalled()
  })

  it('deletes nothing without a key', async () => {
    await deleteActivity('a', '')
    expect(db.productUsageActivity.deleteMany).not.toHaveBeenCalled()
  })

  it('removes a mark written while sharing was being turned off elsewhere', async () => {
    // Sharing is on when this process checks, then another process saves off and deletes before the upsert lands.
    db.productUsagePreference.findUnique
      .mockResolvedValueOnce({ enabled: true, revision: 1 })
      .mockResolvedValueOnce({ enabled: false, revision: 2 })
    await markActivity('a', at, { surface: 'desktop' }, KEY)
    expect(db.productUsageActivity.upsert).toHaveBeenCalledOnce()
    expect(db.productUsageActivity.deleteMany).toHaveBeenCalledWith({ where: { subject: activitySubject('a', KEY) } })
    db.productUsagePreference.findUnique.mockResolvedValue({ enabled: true, revision: 3 })
    await markActivity('a', at, { surface: 'desktop' }, KEY)
    expect(db.productUsageActivity.upsert).toHaveBeenCalledTimes(2) // not remembered as marked
  })

  it('never throws: a missing user or a database error writes nothing and is retried next time', async () => {
    db.user.findUnique.mockResolvedValueOnce(null)
    await expect(markActivity('gone', at, { surface: 'desktop' }, KEY)).resolves.toBeUndefined()
    db.productUsageActivity.upsert.mockRejectedValueOnce(new Error('PRIVATE_DB_ERROR'))
    await expect(markActivity('a', at, { surface: 'desktop' }, KEY)).resolves.toBeUndefined()
    await markActivity('a', at, { surface: 'desktop' }, KEY)
    expect(db.productUsageActivity.upsert).toHaveBeenCalledTimes(2)
  })
})
