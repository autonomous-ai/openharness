import { afterEach, expect, it, vi } from 'vitest'

const seen = vi.hoisted(() => ({ loaded: [] as string[], constructed: 0, inspected: 0, installed: 0,
  finish: undefined as undefined | ((value: { code: number; stdout: string; stderr: string }) => void) }))
vi.mock('../engines/kit/nativeInstall.js', () => {
  seen.loaded.push('posix')
  return { createNativeInstallations: () => { seen.constructed++; return {
    status: async () => { seen.inspected++; return null },
    ensure: async () => { seen.installed++; return { complete: true } },
  } } }
})
vi.mock('../engines/kit/windowsInstall.js', () => {
  seen.loaded.push('windows')
  return { createWindowsInstallations: () => { seen.constructed++; return {
    status: async () => { seen.inspected++; return null },
    ensure: async () => { seen.installed++; return { complete: true } },
  } } }
})
vi.mock('../engines/kit/launchExecutable.js', () => { seen.loaded.push('selection'); return { captureLaunchExecutable: vi.fn() } })
vi.mock('../engines/kit/nativeVersion.js', () => { seen.loaded.push('version'); return { nativeVersionProbe: vi.fn() } })
vi.mock('../engines/hermesRecord.js', () => { seen.loaded.push('hermes'); return { hermesKeepsRecord: vi.fn() } })
vi.mock('../engines/opencode/version.js', () => { seen.loaded.push('opencode'); return { opencodeMajorVersion: vi.fn() } })
vi.mock('../engines/kit/downloadMarker.js', () => ({ engineDownloading: async () => false }))
vi.mock('../engines/kit/nativeProbe.js', () => ({
  helpOf: () => new Promise(resolve => { seen.finish = resolve }), readNativeProbe: vi.fn(),
}))

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); seen.loaded.length = 0; seen.constructed = seen.inspected = seen.installed = 0 })

it.each(['linux', 'win32'] as const)('answers marker reads without loading installers, then loads only the %s installer beside a probe', async platform => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  const { createLocalNativeSetup } = await import('./nativeSetup.js')
  expect(seen.loaded).toEqual([])
  const setup = createLocalNativeSetup('/fixture')
  expect(await setup.downloading('claude')).toBe(false)
  expect(seen.loaded).toEqual([])
  const checking = setup.probe({ command: '/fixture/claude', identity: 'fixture', current: () => true }, 'help', { HOME: '/fixture' })
  await vi.waitFor(() => expect(seen.loaded).toEqual([platform === 'win32' ? 'windows' : 'posix']))
  expect(seen.constructed).toBe(1)
  expect(seen.inspected).toBe(0); expect(seen.installed).toBe(0)
  seen.finish!({ code: 0, stdout: 'help', stderr: '' })
  expect(await checking).toEqual({ code: 0, stdout: 'help', stderr: '' })
  expect(await setup.installations.status('claude', 'request', () => true)).toBeNull()
  expect(seen.constructed).toBe(1); expect(seen.inspected).toBe(1); expect(seen.installed).toBe(0)
})
