import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeProfile } from '../lib/claudeProfiles.js'
import { appendPmMove, readPmPool, setPmPool } from '../lib/pmAccountPool.js'
import { fakeCore } from '../testing/fakeCore.js'
import { pmAccountsRequests, realPmAccountsDeps, type PmAccountsDeps } from './pmAccountsRequests.js'
import type { SuperTabHost } from './host.js'
import { superTabService } from './service.js'

const dir = process.env.ADAPTER_DATA_DIR!
afterEach(() => { for (const f of ['pm-account-pool.json', 'pm-account-moves.jsonl']) rmSync(join(dir, f), { force: true }) })

const owner = { local: true, owner: true }, guest = { local: false, owner: false }
const profile = (id: string, over: Partial<ClaudeProfile> = {}): ClaudeProfile => ({ id, path: `/p/${id}`, label: id.toUpperCase(), reportLabel: id, offered: false, ...over })
const FIVE = { name: '5-hour' as const, leftPercent: 40, resetsAt: '2026-11-06T20:00:00.000Z' }, WEEK = { name: 'weekly' as const, leftPercent: 70 }

function setup(over: Partial<PmAccountsDeps> = {}) {
  const deps: PmAccountsDeps = { profiles: () => [profile('d', { default: true, path: '/home' }), profile('a'), profile('b')], email: f => f === '/p/a' ? 'a@x.test' : undefined,
    windows: id => id === 'default' ? [FIVE, WEEK] : id === 'a' ? [WEEK] : [], signedIn: async home => home !== '/p/b', pmHere: id => id === 'a' ? ['Ana'] : [], ...over }
  return pmAccountsRequests(fakeCore({ daemon: { machineId: () => 'm1' } as never }), deps)
}

describe('pm_accounts_list', () => {
  it('lists this machine\'s accounts with the pool, both windows, the email and who is on them', async () => {
    setPmPool(['a', 'gone'])
    expect(await setup().pm_accounts_list({}, owner)).toEqual({ accounts: [
      { id: 'd', label: 'D', default: true, pmMayUse: false, pmHere: [], signedIn: true, windows: [FIVE, WEEK] },
      { id: 'a', label: 'A', email: 'a@x.test', pmMayUse: true, pmHere: ['Ana'], signedIn: true, windows: [WEEK] },
      { id: 'b', label: 'B', pmMayUse: false, pmHere: [], signedIn: false, windows: [] },
    ] })
  })
  it('says a failed scan', async () => {
    expect(await setup({ profiles: () => { throw new Error('disk') } }).pm_accounts_list({}, owner)).toEqual({ error: 'PM_ACCOUNTS_FAILED' })
  })
})

describe('pm_accounts_use', () => {
  it('ticks and unticks, keeping the order and dropping duplicates', async () => {
    const s = setup()
    expect(await s.pm_accounts_use({ ids: ['a', 'b'], on: true }, owner)).toEqual({ pool: ['a', 'b'] })
    expect(await s.pm_accounts_use({ ids: ['a'], on: true }, owner)).toEqual({ pool: ['a', 'b'] })
    expect(await s.pm_accounts_use({ ids: ['a'], on: false }, owner)).toEqual({ pool: ['b'] })
    expect(readPmPool()).toEqual(['b'])
  })
  it('refuses to tick an id that is not an account here, and changes nothing', async () => {
    setPmPool(['a'])
    expect(await setup().pm_accounts_use({ ids: ['b', 'nope'], on: true }, owner)).toEqual({ error: 'NOT_FOUND' })
    expect(readPmPool()).toEqual(['a'])
  })
  it('lets the owner untick an id whose folder is gone', async () => {
    setPmPool(['gone', 'a'])
    expect(await setup().pm_accounts_use({ ids: ['gone'], on: false }, owner)).toEqual({ pool: ['a'] })
  })
  it.each([[{ ids: 'a', on: true }], [{ ids: ['a'] }], [{ ids: [1], on: true }], [{ ids: [''], on: true }], [{ ids: Array(65).fill('a'), on: false }]])('refuses %j', async (payload) => {
    expect(await setup().pm_accounts_use(payload, owner)).toEqual({ error: 'INVALID_REQUEST' })
  })
  it('says a pool it could not write', async () => {
    // A directory where the file belongs: the atomic rename onto it fails.
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, 'pm-account-pool.json'))
    try { expect(await setup().pm_accounts_use({ ids: ['a'], on: true }, owner)).toEqual({ error: 'PM_ACCOUNTS_FAILED' }) }
    finally { rmSync(join(dir, 'pm-account-pool.json'), { recursive: true, force: true }) }
  })
})

describe('pm_accounts_history', () => {
  it('lists the moves newest first, up to the limit', async () => {
    for (const at of [1, 2, 3]) appendPmMove({ at, pm: 'Ana', from: 'a', to: 'b', why: 'low', ok: true })
    const s = setup()
    expect(((await s.pm_accounts_history({}, owner)).moves as Array<{ at: number }>).map(m => m.at)).toEqual([3, 2, 1])
    expect(((await s.pm_accounts_history({ limit: 2 }, owner)).moves as Array<{ at: number }>).map(m => m.at)).toEqual([3, 2])
    expect(((await s.pm_accounts_history({ limit: -1 }, owner)).moves as unknown[])).toHaveLength(3)
  })
})

describe('owner only', () => {
  it.each(['pm_accounts_list', 'pm_accounts_use', 'pm_accounts_history'] as const)('%s refuses a guest and a device, with the answer claude_profiles_list gives', async (type) => {
    const s = setup()
    expect(await s[type]({ ids: ['a'], on: true }, guest)).toEqual({ error: 'OWNER_REQUIRED' })
    expect(await s[type]({ ids: ['a'], on: true }, { local: false, owner: false, guest: 'g' })).toEqual({ error: 'OWNER_REQUIRED' })
    expect(readPmPool()).toEqual([])
  })
})

describe('machine share', () => {
  it.each(['pm_accounts_list', 'pm_accounts_use', 'pm_accounts_history'] as const)('%s refuses a machine-share asker, and answers the account owner', async (type) => {
    const s = setup()
    const share = { local: false, owner: true, accountOwner: false }
    expect(await s[type]({ ids: ['a'], on: true }, share)).toEqual({ error: 'OWNER_REQUIRED' })
    expect(await s[type]({ ids: ['a'], on: true }, { local: false, owner: true })).toEqual({ error: 'OWNER_REQUIRED' })
    expect(readPmPool()).toEqual([])
    expect(await s[type]({ ids: ['a'], on: true }, { local: false, owner: true, accountOwner: true })).not.toEqual({ error: 'OWNER_REQUIRED' })
  })
})

describe('served by the Super Tab service', () => {
  it('answers through the service with the host\'s windows, and with none while no host runs', async () => {
    const core = fakeCore({ daemon: { machineId: () => 'm1' } as never })
    const accountWindows = vi.fn((id: string) => id === 'a' ? [WEEK] : [])
    const service = superTabService(core, { host: () => ({ machineId: 'm1', start: vi.fn(), stop: vi.fn(), accountWindows }) as unknown as SuperTabHost,
      pmAccounts: { profiles: () => [profile('d', { default: true }), profile('a')], email: () => undefined, signedIn: async () => true } })
    expect(Object.keys(service.requests)).toEqual(expect.arrayContaining(['pm_accounts_list', 'pm_accounts_use', 'pm_accounts_history']))
    const first = await service.requests.pm_accounts_list({}, owner, new AbortController().signal) as { accounts: Array<{ windows: unknown[] }> }
    expect(first.accounts.map(a => a.windows)).toEqual([[], []])
    expect(accountWindows).not.toHaveBeenCalled()
    // Once the host runs (any Super Tab action wakes it), the list carries what it has read.
    await service.requests.super_tabs({ action: 'wake' }, owner, new AbortController().signal)
    const second = await service.requests.pm_accounts_list({}, owner, new AbortController().signal) as { accounts: Array<{ id: string; windows: unknown[] }> }
    expect(second.accounts.map(a => a.windows)).toEqual([[], [WEEK]])
    expect(accountWindows.mock.calls).toEqual([['default'], ['a']])
  })
  it('reads the real defaults without touching a machine: no host means no windows and nobody listed', async () => {
    const deps = realPmAccountsDeps(() => [])
    expect(deps.pmHere('x')).toEqual([])
    expect(deps.windows('x')).toEqual([])
    expect(typeof deps.profiles).toBe('function')
    expect(typeof deps.email).toBe('function')
    expect(typeof deps.signedIn).toBe('function')
  })
})
