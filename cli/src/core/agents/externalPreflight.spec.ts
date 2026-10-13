import { afterEach, expect, it, vi } from 'vitest'
import { loadEngine } from '../../engines/inProcess.js'
import { engineHooks } from '../../engines/hooks.js'
import { buildEngineCommandArgv, refusePermissionFlagIfUnsupported } from '../../lib/engineLaunch.js'
import { workspaceMissing } from '../../lib/workspaceCheck.js'
import { createExternalPreflight } from './externalPreflight.js'
import type { NativeLaunch } from '../../engines/nativeLaunch.js'
vi.mock('../../engines/inProcess.js', () => ({ loadEngine: vi.fn(async () => ({})) }))
vi.mock('../../engines/hooks.js', () => ({ engineHooks: { codex: { installIn: vi.fn(async () => true) } } }))
vi.mock('../../lib/engineLaunch.js', () => ({ buildEngineCommandArgv: vi.fn(() => []), refusePermissionFlagIfUnsupported: vi.fn(async () => null) }))
vi.mock('../../lib/workspaceCheck.js', () => ({ workspaceMissing: vi.fn(() => null) }))
afterEach(() => { vi.clearAllMocks(); vi.mocked(refusePermissionFlagIfUnsupported).mockReset().mockResolvedValue(null) })
const session = { sessionId: 'conversation', cwd: '/fixture/work', launchArgs: ['-p', 'work'] } as never
const row = (engine = 'claude', extra = {}) => ({ engine, permissionMode: 'ask', bypassPermission: false, ...extra }) as never
function setup(over = {}) {
  const deps = { blocksFolder: vi.fn(() => false), hooksDisabled: false, hookPort: 4242,
    installOpencodePlugin: vi.fn(async () => true), ...over }
  return { deps, prepare: createExternalPreflight(deps) }
}
it('refuses a missing or changing folder or unsupported permissions before engine preparation', async () => {
  vi.mocked(workspaceMissing).mockReturnValueOnce({ ok: false, error: 'CWD_NOT_FOUND', detail: 'folder gone' })
  expect(await setup().prepare(row(), session)).toMatchObject({ detail: 'folder gone' })
  expect(await setup({ blocksFolder: () => true }).prepare(row(), session)).toMatchObject({ detail: expect.stringContaining('workspace operation') })
  vi.mocked(refusePermissionFlagIfUnsupported).mockResolvedValueOnce({ error: 'PERMISSION_MODE_UNSUPPORTED', detail: 'permission unsupported' } as never)
  expect(await setup().prepare(row(), session)).toMatchObject({ detail: 'permission unsupported' })
  expect(buildEngineCommandArgv).not.toHaveBeenCalled()
})
it('requires OpenCode launch support and hooks before any external owner can be stopped', async () => {
  vi.mocked(loadEngine).mockResolvedValueOnce(null)
  expect(await setup().prepare(row('opencode'), session)).toBeNull()
  expect(loadEngine).not.toHaveBeenCalled()
  expect(await setup({ installOpencodePlugin: async () => false }).prepare(row('opencode'), session)).not.toBeNull()
  const enabled = setup()
  expect(await enabled.prepare(row('opencode'), session)).toBeNull()
  expect(enabled.deps.installOpencodePlugin).toHaveBeenCalledWith(4242)
  const disabled = setup({ hooksDisabled: true })
  expect(await disabled.prepare(row('opencode'), session)).toBeNull()
  expect(disabled.deps.installOpencodePlugin).not.toHaveBeenCalled()
})
it('prepares a custom Codex hook home only when hooks are enabled, and verifies exact resume argv', async () => {
  for (const engine of ['claude', 'codex']) expect(await setup().prepare(row(engine), session)).toBeNull()
  expect(engineHooks.codex.installIn).not.toHaveBeenCalled()
  expect(await setup({ hooksDisabled: true }).prepare(row('codex', { codexHome: '/fixture/profile' }), session)).toBeNull()
  expect(engineHooks.codex.installIn).not.toHaveBeenCalled()
  expect(await setup().prepare(row('codex', { codexHome: '/fixture/profile' }), session)).toBeNull()
  expect(engineHooks.codex.installIn).toHaveBeenCalledWith(4242, '/fixture/profile')
  expect(buildEngineCommandArgv).toHaveBeenLastCalledWith('codex', expect.objectContaining({ resumeSessionId: 'conversation', extraArgs: ['-p', 'work'] }))
})

it('waits for profile durability before admitting a takeover and retains an unavailable profile', async () => {
  let finish!: (installed: boolean) => void
  vi.mocked(engineHooks.codex.installIn).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = setup().prepare(row('codex', { codexHome: '/fixture/profile' }), session)
  await vi.waitFor(() => expect(engineHooks.codex.installIn).toHaveBeenCalled())
  expect(buildEngineCommandArgv).not.toHaveBeenCalled()
  finish(false)
  expect(await pending).toMatchObject({ detail: expect.stringContaining('hooks') })
  expect(buildEngineCommandArgv).not.toHaveBeenCalled()
  expect(await setup().prepare(row('codex', { codexHome: '/fixture/profile' }), session)).toBeNull()
})

it('retains a checked native snapshot through takeover instead of starting another version or hook probe', async () => {
  let current = true
  const launch = { current: () => current, prepareHooks: vi.fn(async () => true) } as unknown as NativeLaunch
  const native = vi.fn(async () => ({ ok: true as const, launch }))
  const run = setup({ native })
  const ready = await run.prepare(row('opencode'), session)
  expect(ready).toHaveProperty('current')
  if (!ready || !('current' in ready)) throw Error('fixture held')
  expect(ready.current()).toBe(true)
  expect(run.deps.installOpencodePlugin).not.toHaveBeenCalled()
  expect(refusePermissionFlagIfUnsupported).toHaveBeenCalledWith('opencode', expect.any(Object), undefined, launch)
  expect(buildEngineCommandArgv).toHaveBeenCalledWith('opencode', expect.objectContaining({ native: launch }))
  current = false
  expect(ready.current()).toBe(false)
})

it('keeps a takeover held while native preparation or its original owner is unavailable', async () => {
  const held = { ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail: 'Waiting for installer' }
  const native = vi.fn(async () => held)
  expect(await setup({ native }).prepare(row(), session)).toMatchObject({ detail: held.detail })
  native.mockClear()
  expect(await setup({ native }).prepare(row(), session, () => false)).not.toBeNull()
  expect(native).not.toHaveBeenCalled()
  const launch = { current: () => true, prepareHooks: vi.fn(async () => false) } as unknown as NativeLaunch
  expect(await setup({ native: async () => ({ ok: true, launch }) }).prepare(row(), session)).toMatchObject({ detail: expect.stringContaining('hooks') })
  expect(buildEngineCommandArgv).not.toHaveBeenCalled()
})

it.each(['inspection', 'permission', 'hooks', 'disabled hooks'] as const)('retains owner authority across %s', async stage => {
  let current = true
  const launch = { current: () => current, prepareHooks: vi.fn(async () => { if (stage === 'hooks') current = false; return true }) } as unknown as NativeLaunch
  const native = vi.fn(async () => { if (stage === 'inspection') current = false; return { ok: true as const, launch } })
  vi.mocked(refusePermissionFlagIfUnsupported).mockImplementationOnce(async () => { if (stage === 'permission') current = false; return null })
  const result = await setup({ native, hooksDisabled: stage === 'disabled hooks' }).prepare(row(), session, () => current)
  if (stage === 'disabled hooks') {
    expect(result).toHaveProperty('current')
    expect(launch.prepareHooks).toHaveBeenCalledWith(0, expect.any(Function))
  } else expect(result).toMatchObject({ detail: expect.stringContaining('authority') })
})
