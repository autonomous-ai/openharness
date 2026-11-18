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
import { env } from '../config/env.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as windows from '../engines/kit/windowsFiles.js'
import { writeBrowserShim } from './browserShim.js'

vi.mock('./browserShim.js', () => ({ writeBrowserShim: vi.fn(() => true) }))
vi.mock('../engines/kit/launchExecutable.js', () => ({ captureLaunchExecutable: vi.fn() }))
vi.mock('../engines/kit/downloadMarker.js', () => ({ engineDownloading: vi.fn(() => false) }))
vi.mock('../engines/kit/nativeInstall.js', () => ({ createNativeInstallations: vi.fn(() => ({ status: vi.fn(async () => null), ensure: vi.fn(async () => ({ complete: true })) })) }))
vi.mock('../engines/kit/windowsInstall.js', () => ({ createWindowsInstallations: vi.fn(() => ({ status: vi.fn(async () => null), ensure: vi.fn(async () => ({ complete: true })) })) }))
vi.mock('../engines/kit/nativeVersion.js', () => ({ nativeVersionProbe: vi.fn(() => ({ identity: () => 'fixture' })) }))
vi.mock('../engines/kit/nativeProbe.js', () => ({ helpOf: vi.fn(() => null), readNativeProbe: vi.fn(() => null) }))
vi.mock('../engines/hermesRecord.js', () => ({ hermesKeepsRecord: vi.fn(() => true) }))
vi.mock('../engines/opencode/version.js', () => ({ opencodeMajorVersion: vi.fn(() => 2) }))
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })
const executable = { command: '/fixture/engine', identity: 'fixture', current: () => true }, environment = { HOME: '/fixture' }

it('prepares the same optional browser shim in inline composition and reports a write failure', () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  createLocalNativeSetup('/fixture/data/native-installations', undefined, { command: 'fixture-cli' })
  expect(writeBrowserShim).toHaveBeenCalledWith('fixture-cli', '/fixture/data/bin/harness-browser')
  expect(warning).not.toHaveBeenCalled()
  vi.mocked(writeBrowserShim).mockReturnValueOnce(false)
  createLocalNativeSetup('/fixture/data/native-installations', undefined, { command: 'fixture-cli' })
  expect(warning).toHaveBeenCalledExactlyOnceWith('[engine-setup] BROWSER_SHIM_UNAVAILABLE')
})

it('composes bounded file rendering without loading installers or publishing native files', async () => {
  vi.spyOn(windows, 'hostPlatform').mockReturnValue('linux')
  const setup = createLocalNativeSetup(env.ADAPTER_DATA_DIR), home = join(env.ADAPTER_DATA_DIR, 'local-file-preparation')
  const input = { engine: 'claude' as const, port: 1234, environment: { HOME: env.ADAPTER_DATA_DIR, CLAUDE_CONFIG_DIR: home },
    files: [{ file: join(home, 'settings.json'), directory: home, content: null },
      { file: join(env.HARNESS_AGENT_MESSAGES_DIR, 'hook.mjs'), directory: env.HARNESS_AGENT_MESSAGES_DIR, content: null }] }
  const candidate = await setup.prepareFiles!(input, 'fixture-files', () => true)
  expect(JSON.parse(candidate!.files[0].content!)).toHaveProperty('hooks.SessionStart')
  expect(candidate!.files[1].content).toContain('Agent Messages')
  expect(await setup.prepareFiles!(input, 'cancelled-files', () => false)).toBeNull()
  expect(existsSync(input.files[0].file)).toBe(false)
  const trust = { engine: 'codex' as const, cwd: home, home,
    files: [{ file: join(home, 'config.toml'), directory: home, content: 'model = "fixture"\n' }] }
  expect((await setup.prepareTrust!(trust, 'fixture-trust', () => true))!.files[0].content).toContain('trust_level = "trusted"')
  expect(await setup.prepareTrust!(trust, 'cancelled-trust', () => false)).toBeNull()
  expect(existsSync(trust.files[0].file)).toBe(false)
  expect(createNativeInstallations).not.toHaveBeenCalled(); expect(createWindowsInstallations).not.toHaveBeenCalled()
})

it.each(['linux', 'win32'] as const)('keeps explicit inline setup and the %s installer composition', async platform => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  const setup = createLocalNativeSetup('/fixture')
  expect(createWindowsInstallations).not.toHaveBeenCalled(); expect(createNativeInstallations).not.toHaveBeenCalled()
  expect(await setup.installations.status('claude', 'request', () => true)).toBeNull()
  expect(platform === 'win32' ? createWindowsInstallations : createNativeInstallations).toHaveBeenCalledWith({ directory: '/fixture' })
  expect(await setup.installations.ensure('claude', {} as never, {}, 'request', () => true)).toEqual({ complete: true })
  for (const kind of ['help', 'versionHelp', 'runtime', 'version'] as const) await setup.probe(executable, kind, environment)
  expect(helpOf).toHaveBeenCalledWith(executable, environment, undefined, undefined)
  expect(helpOf).toHaveBeenCalledWith(executable, environment, ['--version'], undefined)
  expect(readNativeProbe).toHaveBeenCalledWith(executable.command, ['--version'], environment, undefined)
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

it('observes a failed installer preload once and keeps the same failure for a subsequent status request', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(createNativeInstallations).mockImplementationOnce(() => { throw Error('fixture load failed') })
  const setup = createLocalNativeSetup('/fixture')
  await setup.probe(executable, 'help', environment)
  await expect(setup.installations.status('claude', 'request', () => true)).rejects.toThrow('fixture load failed')
  await expect(setup.installations.status('claude', 'request', () => true)).rejects.toThrow('fixture load failed')
  expect(createNativeInstallations).toHaveBeenCalledOnce()
  expect(warning).toHaveBeenCalledExactlyOnceWith('[engine-setup] INSTALLATION_MODULE_UNAVAILABLE')
})

it('keeps optional settings rendering inside explicit local setup with zero publication files', async () => {
  const setup = createLocalNativeSetup('/fixture/data')
  const input = { purpose: 'launchSettings' as const, engine: 'codex' as const,
    environment: { HOME: '/fixture' }, cwd: null, dataDir: '/fixture/data', runtimeNode: '/fixture/node',
    platform: 'linux' as const, gitBash: null, owner: { machineId: 'machine', accountId: 'account' },
    sources: [{ file: '/fixture/data/agent-settings.json', content: '{"machineId":"machine","accountId":"account","agentsStartAgents":true}' },
      { file: '/fixture/.codex/config.toml', content: null }], files: [] }
  expect(await setup.prepareFiles!(input, 'optional-values', () => true)).toMatchObject({ version: 1,
    values: { instructions: expect.stringContaining('You are running in Harness'), settings: null }, files: [] })
  expect(await setup.prepareFiles!(input, 'cancelled-values', () => false)).toBeNull()
  expect(createNativeInstallations).not.toHaveBeenCalled(); expect(createWindowsInstallations).not.toHaveBeenCalled()
})
