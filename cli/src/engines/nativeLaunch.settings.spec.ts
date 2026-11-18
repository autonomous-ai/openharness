import { beforeEach, expect, it, vi } from 'vitest'
import { inspectNativeLaunch } from './nativeLaunch.js'
import type { NativeLaunch } from './nativeLaunch.js'
import type { NativeSetupProbes } from './kit/nativeSetup.js'
import { prepareLaunchSettings } from './kit/nativeLaunchSettings.js'

const fixture = vi.hoisted(() => ({ epoch: 'epoch-a', accountId: 'account-a' }))
vi.mock('./kit/launchExecutable.js', () => ({ captureLaunchExecutable: async () => ({ state: 'ready',
  executable: { command: '/fixture/codex', identity: 'fixture', current: () => true },
  environment: { HOME: '/fixture/home', CODEX_HOME: '/fixture/a', PATH: '/fixture/bin' },
}) }))
vi.mock('./kit/nativeLaunchSettings.js', async original => ({ ...await original<typeof import('./kit/nativeLaunchSettings.js')>(),
  prepareLaunchSettings: vi.fn(async (_engine, _env, _cwd, _setup, options) => ({ values: { instructions: 'optional', settings: null },
    current: () => options.current() && options.nativeCurrent() })),
}))
vi.mock('../lib/authSession.js', async original => ({ ...await original<typeof import('../lib/authSession.js')>(),
  readAuthSession: () => ({ machineId: 'machine', signInAcct: fixture.accountId, signInEpoch: fixture.epoch }),
}))
const setup = { probe: async () => ({ code: 0, stdout: '--no-daemon', stderr: '' }), opencodeMajor: async () => null, hermesKeepsRecord: async () => null } satisfies NativeSetupProbes
beforeEach(() => { fixture.epoch = 'epoch-a'; fixture.accountId = 'account-a'; vi.clearAllMocks() })
const prepared = async () => {
  const result = await inspectNativeLaunch('codex', {}, { setup })
  if (!result.ok) throw Error('fixture held')
  expect(await result.launch.prepareHooks(0, () => true)).toBe(true)
  return result.launch as NativeLaunch & { prepareSettings(cwd: string | null, current: () => boolean): Promise<{ current(): boolean }> }
}

it('never revives optional values across home A to B to A native preparation revisions', async () => {
  const launch = await prepared(), settings = await launch.prepareSettings('/fixture/work', () => true)
  if (!settings) throw Error('fixture settings unavailable')
  expect(settings.current()).toBe(true)
  expect(await launch.prepareHooks(0, () => true, { CODEX_HOME: '/fixture/b' })).toBe(true)
  expect(launch.current()).toBe(true)
  expect(settings.current()).toBe(false)
  expect(await launch.prepareHooks(0, () => true, { CODEX_HOME: '/fixture/a' })).toBe(true)
  expect(launch.current()).toBe(true)
  expect(settings.current()).toBe(false)
})

it('binds the non-secret sign-in epoch and account in the optional proof only', async () => {
  const launch = await prepared(), settings = await launch.prepareSettings('/fixture/work', () => true)
  if (!settings) throw Error('fixture settings unavailable')
  expect(prepareLaunchSettings).toHaveBeenCalledWith('codex', expect.objectContaining({ CODEX_HOME: '/fixture/a' }), '/fixture/work', setup,
    expect.objectContaining({ owner: { machineId: 'machine', accountId: 'account-a', epoch: 'epoch-a' } }))
  fixture.epoch = 'epoch-b'; fixture.accountId = 'account-b'
  expect(settings.current()).toBe(false)
  expect(launch.current()).toBe(true)
})
