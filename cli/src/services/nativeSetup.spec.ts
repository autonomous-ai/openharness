import { execFile } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { captureLaunchExecutable } from '../engines/kit/launchExecutable.js'
import { engineDownloading } from '../engines/kit/downloadMarker.js'
import { createNativeInstallations } from '../engines/kit/nativeInstall.js'
import { createWindowsInstallations } from '../engines/kit/windowsInstall.js'
import { nativeVersionProbe } from '../engines/kit/nativeVersion.js'
import { helpOf, readNativeProbe } from '../engines/kit/nativeProbe.js'
import { hermesKeepsRecord } from '../engines/hermesRecord.js'
import { opencodeMajorVersion } from '../engines/opencode/version.js'
import { OPENCODE_VERSION } from '../engines/opencode/contract.js'
import { createLocalNativeSetup, nativeSetupProbes } from './nativeSetup.js'

vi.mock('../engines/kit/launchExecutable.js', () => ({ captureLaunchExecutable: vi.fn() }))
vi.mock('../engines/kit/downloadMarker.js', () => ({ engineDownloading: vi.fn(() => false) }))
vi.mock('../engines/kit/nativeInstall.js', () => ({ createNativeInstallations: vi.fn(() => ({ kind: 'posix' })) }))
vi.mock('../engines/kit/windowsInstall.js', () => ({ createWindowsInstallations: vi.fn(() => ({ kind: 'windows' })) }))
vi.mock('../engines/kit/nativeVersion.js', () => ({ nativeVersionProbe: vi.fn(() => ({ identity: () => 'fixture' })) }))
vi.mock('../engines/kit/nativeProbe.js', () => ({ helpOf: vi.fn(() => null), readNativeProbe: vi.fn(() => null) }))
vi.mock('../engines/hermesRecord.js', () => ({ hermesKeepsRecord: vi.fn(() => true) }))
vi.mock('../engines/opencode/version.js', () => ({ opencodeMajorVersion: vi.fn(() => 2) }))
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })
const executable = { command: '/fixture/engine', identity: 'fixture', current: () => true }, environment = { HOME: '/fixture' }

it.each(['linux', 'win32'] as const)('keeps explicit inline setup and the %s installer composition', async platform => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  const setup = createLocalNativeSetup('/fixture')
  expect(platform === 'win32' ? createWindowsInstallations : createNativeInstallations).toHaveBeenCalledWith({ directory: '/fixture' })
  for (const kind of ['help', 'versionHelp', 'runtime', 'version'] as const) await setup.probe(executable, kind, environment)
  expect(helpOf).toHaveBeenCalledWith(executable, environment, undefined)
  expect(helpOf).toHaveBeenCalledWith(executable, environment, ['--version'])
  expect(readNativeProbe).toHaveBeenCalledWith(executable.command, ['--version'], environment)
  expect(await setup.probe({ ...executable, current: () => false }, 'help', environment)).toBeNull()
  expect(await setup.opencodeMajor()).toBe(2); expect(await setup.hermesKeepsRecord()).toBe(true)
  await setup.downloading('codex'); expect(engineDownloading).toHaveBeenCalledWith('codex', undefined, undefined, undefined)
})

it('routes every setup probe through the protected executor and holds absent executables', async () => {
  const execute = vi.fn() as unknown as typeof execFile
  const setup = createLocalNativeSetup('/fixture', execute)
  vi.mocked(captureLaunchExecutable).mockResolvedValue({ state: 'ready', executable, environment })
  for (const kind of ['help', 'versionHelp', 'runtime', 'version'] as const) await setup.probe(executable, kind, environment)
  expect(helpOf).toHaveBeenCalledWith(executable, environment, undefined, execute)
  expect(helpOf).toHaveBeenCalledWith(executable, environment, ['--version'], execute)
  expect(readNativeProbe).toHaveBeenCalledWith(executable.command, ['--version'], environment, execute)
  expect(await setup.probe({ ...executable, current: () => false }, 'help', environment)).toBeNull()
  expect(await setup.opencodeMajor()).toBe(2)
  const [rule, binary, env, runner] = vi.mocked(nativeVersionProbe).mock.calls.at(-1)!
  expect(rule).toBe(OPENCODE_VERSION); expect(binary()).toBe(executable.command); expect(env?.HOME).toBe(environment.HOME); expect(runner).toBe(execute)
  vi.mocked(captureLaunchExecutable).mockResolvedValue({ state: 'held', detail: 'fixture' })
  expect(await setup.opencodeMajor()).toBeNull()
  await setup.hermesKeepsRecord(executable, environment)
  const deps = vi.mocked(hermesKeepsRecord).mock.calls.at(-1)![2]!
  await deps.capture('hermes'); expect(captureLaunchExecutable).toHaveBeenLastCalledWith('hermes', undefined, execute)
  deps.probe(OPENCODE_VERSION, () => executable.command, environment)
  expect(nativeVersionProbe).toHaveBeenLastCalledWith(OPENCODE_VERSION, expect.any(Function), environment, execute)
  await setup.downloading('codex'); expect(engineDownloading).toHaveBeenCalledWith('codex', undefined, undefined, execute)
  expect(nativeSetupProbes).not.toBe(setup)
})
