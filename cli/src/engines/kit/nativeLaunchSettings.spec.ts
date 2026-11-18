import { afterEach, expect, it, vi } from 'vitest'
import { prepareLaunchSettings } from './nativeLaunchSettings.js'
import type { LaunchSettingsOptions } from './nativeLaunchSettings.js'
import type { NativeSetup } from './nativeSetup.js'

const values = { instructions: 'optional', settings: null }
const options = (): LaunchSettingsOptions => ({ runtimeNode: '/fixture/node', platform: 'darwin', gitBash: null,
  owner: { machineId: 'machine', accountId: 'account', epoch: 'a' }, current: () => true, nativeCurrent: () => true })
const setup = (): Pick<NativeSetup, 'prepareSettings'> => ({ prepareSettings: vi.fn(async () => ({ version: 2 as const, values })) })
afterEach(() => { vi.restoreAllMocks() })

it.each(['terminal', 'opencode'])('does not ask optional setup for %s', async engine => {
  const given = setup()
  expect(await prepareLaunchSettings(engine, { HOME: '/fixture' }, null, given, options())).toBeNull()
  expect(given.prepareSettings).not.toHaveBeenCalled()
})
it('omits missing optional setup', async () => {
  expect(await prepareLaunchSettings('codex', {}, null, {}, options())).toBeNull()
})
it.each(['owner', 'native'] as const)('refuses stale %s before optional preparation', async kind => {
  const given = setup(), opts = options()
  opts[kind === 'owner' ? 'current' : 'nativeCurrent'] = () => false
  expect(await prepareLaunchSettings('codex', {}, null, given, opts)).toBeNull()
  expect(given.prepareSettings).not.toHaveBeenCalled()
})
it('checks owner again after native filesystem authority can revoke it', async () => {
  const given = setup(); let owner = true
  expect(await prepareLaunchSettings('codex', {}, null, given, { ...options(), current: () => owner,
    nativeCurrent: () => { owner = false; return true } })).toBeNull()
  expect(given.prepareSettings).not.toHaveBeenCalled()
})
it('refuses invalid context before asking the component', async () => {
  const given = setup()
  expect(await prepareLaunchSettings('codex', {}, null, given, { ...options(), runtimeNode: 'bad\0node' })).toBeNull()
  expect(given.prepareSettings).not.toHaveBeenCalled()
})
it.each([null, { version: 1, values }, { version: 2 as const, values, files: [] }, { version: 2 as const, values: { ...values, argv: [] } }])(
  'omits unavailable or incompatible optional replies %j', async answer => {
    const given = { prepareSettings: vi.fn(async () => answer) } as unknown as NativeSetup
    expect(await prepareLaunchSettings('codex', {}, null, given, options())).toBeNull()
  },
)
it.each(['owner', 'native'] as const)('rejects %s revocation while awaiting the component', async kind => {
  let active = true
  const given: Pick<NativeSetup, 'prepareSettings'> = { prepareSettings: async () => { active = false; return { version: 2 as const, values } } }
  expect(await prepareLaunchSettings('codex', {}, null, given, { ...options(),
    [kind === 'owner' ? 'current' : 'nativeCurrent']: () => active })).toBeNull()
})
it('returns immutable values and preserves selected context without retaining caller objects', async () => {
  const given = setup(), environment = { HOME: '/fixture' }, opts = options()
  const prepared = await prepareLaunchSettings('codex', environment, null, given, opts)
  expect(prepared?.current()).toBe(true)
  expect(Object.isFrozen(prepared?.values)).toBe(true)
  const input = vi.mocked(given.prepareSettings!).mock.calls[0][0]
  expect(input.environment).not.toBe(environment); expect(input.owner).not.toBe(opts.owner)
  expect(input).not.toHaveProperty('dataDir'); expect(input).not.toHaveProperty('sources'); expect(input).not.toHaveProperty('files')
})
it('names optional failure without source contents', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(await prepareLaunchSettings('claude', {}, null, { prepareSettings: async () => { throw Error('private contents') } }, options())).toBeNull()
  expect(warn).toHaveBeenCalledExactlyOnceWith('[launch-settings] OPTIONAL_PREPARATION_UNAVAILABLE')
})
