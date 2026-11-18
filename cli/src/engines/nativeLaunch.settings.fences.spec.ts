import { existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { inspectNativeLaunch, type NativeLaunch } from './nativeLaunch.js'
import { inspectHookFile } from './kit/nativeHookFiles.js'
import { launchSettingsArgs } from './kit/launchValues.js'
import { prepareNativeLaunchSettings } from '../services/nativeLaunchSettings.js'
import type { NativeSetup } from './kit/nativeSetup.js'
import type { LaunchSettingsInput } from './kit/launchSettingsWire.js'
import { statusLineScript } from './kit/statusLine.js'
import { createNativeSetupLink } from './kit/nativeSetupLink.js'
import { startEngineSetup } from '../services/engineSetup.js'
import { createServiceLinks, type ServiceFrame, type ServiceLink } from '../core/serviceLinks.js'
import { runServiceProcess } from '../services/process.js'

const fixture = vi.hoisted(() => ({ home: '', data: '', executable: '', epoch: 'epoch-a',
  nativeCurrent: (): boolean => true, onSync: undefined as ((fd: number) => void) | undefined,
  onStat: undefined as ((file: string) => void) | undefined,
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
    fixture.onStat?.(file)
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
  fixture.onSync = undefined; fixture.onStat = undefined; fixture.reads = undefined
  mkdirSync(fixture.home); mkdirSync(fixture.data); mkdirSync(join(fixture.home, '.claude'))
  source = join(fixture.home, '.claude', 'settings.json')
  script = join(fixture.data, 'statusline', 'statusline.mjs'); dependency = join(root, 'required-dependency')
  writeFileSync(source, sourceBytes); writeFileSync(fixture.executable, 'selected executable'); writeFileSync(dependency, 'selected dependency')
  writeFileSync(join(fixture.data, 'agent-settings.json'), '{"machineId":"machine","accountId":"account","agentsStartAgents":true}')
  const native = inspectHookFile(fixture.executable)
  nativeReads = vi.fn(() => { try { native.verify(); return true } catch { return false } })
  fixture.nativeCurrent = nativeReads
})
afterEach(() => { fixture.onSync = undefined; fixture.onStat = undefined; fixture.reads = undefined; vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
const prepared = async (selected = setup): Promise<NativeLaunch> => {
  const result = await inspectNativeLaunch('claude', {}, { setup: selected })
  if (!result.ok) throw Error('fixture native inspection held')
  expect(await result.launch.prepareHooks(0, () => true)).toBe(true)
  const proof = inspectHookFile(dependency)
  expect(result.launch.retain!({ files: [], current: () => { try { proof.verify(); return true } catch { return false } } })).toBe(true)
  return result.launch
}

it('keeps one full read-only return proof after the output check without an earlier duplicate', async () => {
  mkdirSync(join(fixture.data, 'statusline')); writeFileSync(script, statusLineScript())
  const launch = await prepared()
  nativeReads.mockClear()
  const settings = await launch.prepareSettings!(fixture.home, () => true)
  expect(settings).not.toBeNull()
  // Initial native admission, post-capture proof and the final return proof are all still present.
  expect(nativeReads).toHaveBeenCalledTimes(3)
  expect(settings!.current()).toBe(true) // Preserve the benchmark caller's explicit returned-proof assertion.
  expect(nativeReads).toHaveBeenCalledTimes(4)
  expect(readFileSync(script, 'utf8')).toBe(statusLineScript())
})

it.each(['source', 'native', 'dependency', 'source ancestor', 'owner', 'sign-in'] as const)(
  'keeps the full proof after the final read-only output check changes %s', async change => {
    mkdirSync(join(fixture.data, 'statusline')); writeFileSync(script, statusLineScript())
    const target = realpathSync(script)
    let owner = true, changed = false
    const launch = await prepared({ ...setup, prepareFiles: async (...args) => {
      const candidate = await setup.prepareFiles!(...args)
      fixture.onStat = file => {
        if (file !== target) return
        fixture.onStat = undefined; changed = true
        if (change === 'source') writeFileSync(source, '{}')
        else if (change === 'native') writeFileSync(fixture.executable, 'replacement executable')
        else if (change === 'dependency') writeFileSync(dependency, 'replacement dependency')
        else if (change === 'source ancestor') {
          renameSync(join(fixture.home, '.claude'), join(fixture.home, 'displaced'))
          mkdirSync(join(fixture.home, '.claude')); writeFileSync(source, sourceBytes)
        } else if (change === 'owner') owner = false
        else fixture.epoch = 'epoch-b'
      }
      return candidate
    } })
    expect(await launch.prepareSettings!(fixture.home, () => owner)).toBeNull()
    expect(changed).toBe(true)
    expect(readFileSync(script, 'utf8')).toBe(statusLineScript())
  },
)

it.each(['owner', 'sign-in'] as const)('keeps fresh read-only output admission after %s revocation', async change => {
  mkdirSync(join(fixture.data, 'statusline')); writeFileSync(script, statusLineScript())
  const target = realpathSync(script)
  let owner = true, outputReads = 0
  const launch = await prepared({ ...setup, prepareFiles: async (...args) => {
    const candidate = await setup.prepareFiles!(...args)
    if (change === 'owner') owner = false
    else fixture.epoch = 'epoch-b'
    fixture.onStat = file => { if (file === target) outputReads++ }
    return candidate
  } })
  expect(await launch.prepareSettings!(fixture.home, () => owner)).toBeNull()
  expect(outputReads).toBe(0)
})

it('retains failure reporting when the final read-only output check finds changed bytes', async () => {
  mkdirSync(join(fixture.data, 'statusline')); writeFileSync(script, statusLineScript())
  const target = realpathSync(script), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const launch = await prepared({ ...setup, prepareFiles: async (...args) => {
    const candidate = await setup.prepareFiles!(...args)
    fixture.onStat = file => {
      if (file !== target) return
      fixture.onStat = undefined; writeFileSync(script, 'peer replacement')
    }
    return candidate
  } })
  expect(await launch.prepareSettings!(fixture.home, () => true)).toBeNull()
  expect(warn).toHaveBeenCalledExactlyOnceWith('[launch-settings] OPTIONAL_PREPARATION_UNAVAILABLE')
  expect(readFileSync(script, 'utf8')).toBe('peer replacement')
})

it.each(['native', 'dependency'] as const)('refuses a publishing answer with a changed %s before any output effect', async change => {
  const launch = await prepared({ ...setup, prepareFiles: async (...args) => {
    const candidate = await setup.prepareFiles!(...args)
    writeFileSync(change === 'native' ? fixture.executable : dependency, 'changed')
    return candidate
  } })
  expect(await launch.prepareSettings!(fixture.home, () => true)).toBeNull()
  expect(existsSync(join(fixture.data, 'statusline'))).toBe(false)
})

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

/** Only the socket is in memory; production routers, transport envelopes, setup preparation and commit are real. */
function routedSetup(afterReply: (type: string) => void | Promise<void>, beforeCall: (type: string) => void = () => {}) {
  const render = vi.fn<NonNullable<NativeSetup['prepareFiles']>>(async (input, _request, current) =>
    prepareNativeLaunchSettings(input as LaunchSettingsInput, current))
  const worker: NativeSetup = { ...setup, prepareFiles: render, downloading: async () => false,
    installations: { ensure: vi.fn(), status: vi.fn() } }
  const service = startEngineSetup(fixture.data, worker), routed: ServiceFrame[] = []
  const links = createServiceLinks({ token: 'fixture-token', owned: { engineSetup: ['setup_files_prepare', 'setup_files_commit'] },
    answer: () => ({}), log: () => {} })
  let accepted: ServiceLink | null = null
  class Socket extends EventEmitter {
    readyState: number = WebSocket.CONNECTING
    receive(frame: ServiceFrame): void { this.emit('message', Buffer.from(JSON.stringify(frame)), false) }
    send(text: string): void {
      const frame = JSON.parse(text) as ServiceFrame
      if (frame.type === 'machine_select') {
        accepted = links.accept('engineSetup', 'fixture-token', { sendFrame: message => {
          routed.push(message); this.receive(message); return true
        } }, () => this.close(), () => this.receive({ type: 'connected' }))
        expect(accepted).not.toBeNull()
      } else accepted!.receive(frame)
    }
    close(): void { this.readyState = WebSocket.CLOSED; this.emit('close', 1000); accepted?.closed() }
    terminate(): void { this.close() }
  }
  const socket = new Socket()
  const transport = runServiceProcess({ name: 'engineSetup', socketPath: '/fixture/socket', machineId: 'machine',
    token: 'fixture-token', requests: service.requests, onDisconnected: service.disconnect, env: {}, log: () => {},
    connect: () => socket as unknown as WebSocket })
  socket.readyState = WebSocket.OPEN; socket.emit('open')
  const link = createNativeSetupLink(async (type, payload, wait) => {
    beforeCall(type)
    const answer = await links.call('engineSetup', type, payload, wait)
    await afterReply(type)
    return answer
  })
  return { selected: { ...setup, prepareFiles: link.prepareFiles }, routed, render,
    stop: async () => { try { await transport.stop() } finally { service.stop() } } }
}

it('uses owner admission without native file walks between read-only prepare and commit', async () => {
  mkdirSync(join(fixture.data, 'statusline')); writeFileSync(script, statusLineScript())
  let commitReads = -1
  const routed = routedSetup(type => { if (type === 'setup_files_prepare') nativeReads.mockClear() },
    type => { if (type === 'setup_files_commit') commitReads = nativeReads.mock.calls.length })
  try {
    const launch = await prepared(routed.selected), settings = await launch.prepareSettings!(fixture.home, () => true)
    expect(settings?.current()).toBe(true)
    expect(routed.routed.map(frame => frame.type)).toEqual(['setup_files_prepare', 'setup_files_commit'])
    expect(routed.routed.map(frame => frame.payload?.requestId)).toEqual([expect.any(String), expect.any(String)])
    expect(routed.render).toHaveBeenCalledOnce()
    expect(commitReads).toBe(0)
  } finally { await routed.stop() }
})

it.each(['source', 'native', 'source ancestor', 'owner', 'sign-in', 'revision'] as const)(
  'discards a read-only candidate when %s changes between routed prepare and commit', async change => {
    mkdirSync(join(fixture.data, 'statusline')); writeFileSync(script, statusLineScript())
    let owner = true, launch: NativeLaunch
    const routed = routedSetup(async type => {
      if (type !== 'setup_files_prepare') return
      if (change === 'source') writeFileSync(source, '{}')
      else if (change === 'native') writeFileSync(fixture.executable, 'replacement executable')
      else if (change === 'source ancestor') {
        renameSync(join(fixture.home, '.claude'), join(fixture.home, 'displaced'))
        mkdirSync(join(fixture.home, '.claude')); writeFileSync(source, sourceBytes)
      } else if (change === 'owner') owner = false
      else if (change === 'sign-in') fixture.epoch = 'epoch-b'
      else expect(await launch.prepareHooks(0, () => true, { CLAUDE_CONFIG_DIR: join(fixture.home, 'new-profile') })).toBe(true)
    })
    try {
      launch = await prepared(routed.selected)
      let flushes = 0; fixture.onSync = () => { flushes++ }
      expect(await launch.prepareSettings!(fixture.home, () => owner)).toBeNull()
      const allowed = ['source', 'native', 'source ancestor'].includes(change)
      expect(routed.routed.map(frame => frame.type)).toEqual(['setup_files_prepare', 'setup_files_commit'])
      expect(routed.routed[1].payload).toMatchObject({ allowed })
      // Rendering is read-only and already happened at prepare; commit only releases or discards its candidate.
      expect(routed.render).toHaveBeenCalledOnce()
      expect(flushes).toBe(0)
      expect(readFileSync(script, 'utf8')).toBe(statusLineScript())
    } finally { await routed.stop() }
  },
)
