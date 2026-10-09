import { afterEach, expect, it, vi } from 'vitest'
import { loadEngine } from '../../engines/inProcess.js'
import { engineHooks } from '../../engines/hooks.js'
import { buildEngineCommandArgv, refusePermissionFlagIfUnsupported } from '../../lib/engineLaunch.js'
import { workspaceMissing } from '../../lib/workspaceCheck.js'
import { createExternalPreflight } from './externalPreflight.js'
vi.mock('../../engines/inProcess.js', () => ({ loadEngine: vi.fn(async () => ({})) }))
vi.mock('../../engines/hooks.js', () => ({ engineHooks: { codex: { installIn: vi.fn() } } }))
vi.mock('../../lib/engineLaunch.js', () => ({ buildEngineCommandArgv: vi.fn(() => []), refusePermissionFlagIfUnsupported: vi.fn(async () => null) }))
vi.mock('../../lib/workspaceCheck.js', () => ({ workspaceMissing: vi.fn(() => null) }))
afterEach(() => { vi.clearAllMocks() })
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
