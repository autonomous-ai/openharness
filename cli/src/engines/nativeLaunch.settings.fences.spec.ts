import { existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { inspectNativeLaunch, type NativeLaunch } from './nativeLaunch.js'
import { inspectHookFile } from './kit/nativeHookFiles.js'
import { launchSettingsArgs } from './kit/launchValues.js'
import { prepareNativeLaunchSettings } from '../services/nativeLaunchSettings.js'
import type { NativeSetup } from './kit/nativeSetup.js'
import type { LaunchSettingsInput } from './kit/launchSettingsWire.js'

const fixture = vi.hoisted(() => ({ home: '', data: '', executable: '', epoch: 'epoch-a',
  nativeCurrent: (): boolean => true, onSync: undefined as ((fd: number) => void) | undefined,
  reads: undefined as Map<string, number> | undefined }))
vi.mock('./kit/launchExecutable.js', () => ({ captureLaunchExecutable: async () => ({ state: 'ready',
  executable: { command: fixture.executable, identity: 'fixture', current: () => fixture.nativeCurrent() },
  environment: { HOME: fixture.home, PATH: join(fixture.home, 'bin') },
}) }))
vi.mock('../config/env.js', async original => {
  const module = await original<typeof import('../config/env.js')>()
  return { ...module, env: { ...module.env, get ADAPTER_DATA_DIR() { return fixture.data } } }
})
vi.mock('../lib/authSession.js', async original => ({ ...await original<typeof import('../lib/authSession.js')>(),
  readAuthSession: () => ({ machineId: 'machine', signInAcct: 'account', signInEpoch: fixture.epoch }),
}))
vi.mock('../lib/nodeRuntime.js', async original => ({ ...await original<typeof import('../lib/nodeRuntime.js')>(),
  managedNodePath: () => process.execPath,
}))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    const file = String(args[0])
    if (fixture.reads) fixture.reads.set(file, (fixture.reads.get(file) ?? 0) + 1)
    return fs.lstatSync(...args)
  }, fsync: (fd: number, callback: (error: Error | null) => void) => fs.fsync(fd, error => {
    try { fixture.onSync?.(fd) } catch (cause) { callback(cause as Error); return }
    callback(error)
  }) }
})

let root: string, source: string, script: string, dependency: string
let nativeReads: ReturnType<typeof vi.fn<() => boolean>>
const sourceBytes = '{"statusLine":{"type":"command","command":"echo owner","padding":3}}'
const setup: Pick<NativeSetup, 'probe' | 'opencodeMajor' | 'hermesKeepsRecord' | 'prepareFiles'> = {
  probe: async () => ({ code: 0, stdout: '--permission-mode', stderr: '' }),
  opencodeMajor: async () => null, hermesKeepsRecord: async () => null,
  prepareFiles: async (input, _request, current) => prepareNativeLaunchSettings(input as LaunchSettingsInput, current),
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'launch-settings-fences-'))
  fixture.home = join(root, 'home'); fixture.data = join(root, 'data')
  fixture.executable = join(root, 'engine'); fixture.epoch = 'epoch-a'
  fixture.onSync = undefined; fixture.reads = undefined
  mkdirSync(fixture.home); mkdirSync(fixture.data); mkdirSync(join(fixture.home, '.claude'))
  source = join(fixture.home, '.claude', 'settings.json')
  script = join(fixture.data, 'statusline', 'statusline.mjs'); dependency = join(root, 'required-dependency')
  writeFileSync(source, sourceBytes); writeFileSync(fixture.executable, 'selected executable'); writeFileSync(dependency, 'selected dependency')
  writeFileSync(join(fixture.data, 'agent-settings.json'), '{"machineId":"machine","accountId":"account","agentsStartAgents":true}')
  const native = inspectHookFile(fixture.executable)
  nativeReads = vi.fn(() => { try { native.verify(); return true } catch { return false } })
  fixture.nativeCurrent = nativeReads
})
afterEach(() => { fixture.onSync = undefined; fixture.reads = undefined; rmSync(root, { recursive: true, force: true }) })
const prepared = async (): Promise<NativeLaunch> => {
  const result = await inspectNativeLaunch('claude', {}, { setup })
  if (!result.ok) throw Error('fixture native inspection held')
  expect(await result.launch.prepareHooks(0, () => true)).toBe(true)
  const proof = inspectHookFile(dependency)
  expect(result.launch.retain!({ files: [], current: () => { try { proof.verify(); return true } catch { return false } } })).toBe(true)
  return result.launch
}

it('bounds fresh native and source walks while publishing through owned descriptor waits', async () => {
  const launch = await prepared(), leaf = realpathSync(source)
  nativeReads.mockClear(); const reads = fixture.reads = new Map<string, number>()
  const settings = await launch.prepareSettings!(fixture.home, () => true)
  fixture.reads = undefined
  expect(settings).not.toBeNull()
  // Count selected proof and real source-leaf operations, independent of temporary-folder depth.
  // Full checks remain at effects and acknowledgement; descriptor-only admission does not repeat them.
  expect(nativeReads.mock.calls.length).toBeLessThanOrEqual(32)
  expect(reads.get(leaf) ?? 0).toBeLessThanOrEqual(80)
  expect(settings!.current()).toBe(true)
  expect(readFileSync(script, 'utf8')).toContain('rate_limits')
})

it('refuses a changed required executable before capturing optional files', async () => {
  const launch = await prepared()
  writeFileSync(fixture.executable, 'replacement')
  const reads = fixture.reads = new Map<string, number>()
  expect(await launch.prepareSettings!(fixture.home, () => true)).toBeNull()
  fixture.reads = undefined
  expect(reads.get(source) ?? 0).toBe(0)
  expect(existsSync(script)).toBe(false)
})

it.each(['staged file', 'directory'] as const)('retains every dependency across the %s flush', async phase => {
  // Each variant gets its own captured native launch and private destinations.
  const launch = await prepared(); let changed = false
  fixture.onSync = fd => {
    if (fstatSync(fd).isDirectory() !== (phase === 'directory')) return
    fixture.onSync = undefined; changed = true
    writeFileSync(dependency, 'replacement dependency')
  }
  expect(await launch.prepareSettings!(fixture.home, () => true)).toBeNull()
  expect(changed).toBe(true)
  expect(launch.current()).toBe(false)
  expect(existsSync(script)).toBe(phase === 'directory')
  expect(readdirSync(join(fixture.data, 'statusline')).some(file => file.startsWith('.harness-hook-'))).toBe(false)
})

it.each((['staged file', 'directory'] as const).flatMap(phase =>
  (['source', 'native', 'source ancestor', 'owner', 'sign-in'] as const).map(change => ({ phase, change }))))(
  'omits values when $change changes during $phase flush', async ({ phase, change }) => {
    const launch = await prepared(); let owner = true, changed = false
    fixture.onSync = fd => {
      if (fstatSync(fd).isDirectory() !== (phase === 'directory')) return
      fixture.onSync = undefined; changed = true
      if (change === 'source') writeFileSync(source, '{}')
      else if (change === 'native') writeFileSync(fixture.executable, 'replacement executable')
      else if (change === 'source ancestor') {
        renameSync(join(fixture.home, '.claude'), join(fixture.home, 'displaced'))
        mkdirSync(join(fixture.home, '.claude')); writeFileSync(source, sourceBytes)
      } else if (change === 'owner') owner = false
      else fixture.epoch = 'epoch-b'
    }
    expect(await launch.prepareSettings!(fixture.home, () => owner)).toBeNull()
    expect(changed).toBe(true)
    expect(existsSync(script)).toBe(phase === 'directory')
    expect(readdirSync(join(fixture.data, 'statusline')).some(file => file.startsWith('.harness-hook-'))).toBe(false)
  },
)

it.each(['native', 'source', 'output', 'sign-in'] as const)('rechecks %s after a receipt wait at final argv use', async change => {
  const launch = await prepared(), settings = await launch.prepareSettings!(fixture.home, () => true)
  expect(settings?.current()).toBe(true)
  // A receipt may publish between preparation and the backend's synchronous command factory.
  await Promise.resolve().then(() => {
    if (change === 'native') writeFileSync(fixture.executable, 'replacement executable')
    else if (change === 'source') writeFileSync(source, '{}')
    else if (change === 'output') writeFileSync(script, 'replacement script')
    else fixture.epoch = 'epoch-b'
  })
  const base = ['--settings', '{"hooks":{"keep":[]}}', '--append-system-prompt', 'keep']
  expect(launchSettingsArgs('claude', base, settings)).toEqual(base)
  expect(launch.current()).toBe(change !== 'native')
})
