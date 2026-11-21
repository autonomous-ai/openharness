import { ChildProcess, spawn } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeSetup } from '../engines/kit/nativeSetup.js'
import * as local from './nativeSetup.js'
import { runEngineSetupService } from './engineSetupProcess.js'
import type { ServiceProcessOptions } from './process.js'

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(() => {
    const child = Object.assign(new actual.ChildProcess(), { connected: true })
    child.send = ((message: { cancel?: boolean }) => {
      queueMicrotask(() => child.emit('message', { error: message.cancel ? { code: 'SETUP_PROBE_CANCELLED' } : null, stdout: 'ready', stderr: '' }))
      return true
    }) as ChildProcess['send']
    return child
  }) }
})

let service: ReturnType<typeof runEngineSetupService>, options: ServiceProcessOptions
let release: Array<() => void>
beforeEach(() => {
  release = []
  vi.spyOn(local, 'createLocalNativeSetup').mockImplementation((_directory, execute): NativeSetup => ({
    probe: async () => null, downloading: async () => false, opencodeMajor: async () => null,
    // The metadata methods await imports/selection before they call their captured executor.
    hermesKeepsRecord: async () => {
      await new Promise<void>(done => release.push(done))
      return new Promise(resolve => execute!('/fixture/engine', ['--version'], {}, error => resolve(error ? null : true)))
    },
    installations: { status: async () => null, ensure: async () => ({ complete: true }) },
  }))
  service = runEngineSetupService({ dataDir: '/fixture', socketPath: '/fixture/socket', machineId: 'm', token: 't',
    run: value => { options = value; return { stop() {} } } })
})
afterEach(() => { service.stop(); vi.restoreAllMocks(); vi.clearAllMocks() })
const version = () => Promise.resolve(options.requests!.setup_version!({ engine: 'hermes' }, { local: true, owner: true }))

it('revokes delayed metadata from the old connection while admitting work after reconnect', async () => {
  const old = version()
  options.onDisconnected!()
  const fresh = version()
  release[1]!()
  expect(await fresh).toEqual({ keepsRecord: true })
  release[0]!()
  expect(await old).toEqual({ keepsRecord: null })
  expect(spawn).toHaveBeenCalledOnce()
})

it('rejects delayed metadata and new requests after final stop, including a later socket-close callback', async () => {
  const old = version()
  service.stop()
  options.onDisconnected!()
  release[0]!()
  expect(await old).toEqual({ keepsRecord: null })
  expect(await version()).toMatchObject({ error: 'SETUP_STOPPED' })
  expect(spawn).not.toHaveBeenCalled()
})

it('retains all eight actual child slots through disconnect until those children exit', async () => {
  const old = Array.from({ length: 8 }, version)
  for (const done of release) done()
  expect(await Promise.all(old)).toEqual(Array(8).fill({ keepsRecord: true }))
  options.onDisconnected!()
  const blocked = version(); release[8]!()
  expect(await blocked).toEqual({ keepsRecord: null })
  expect(spawn).toHaveBeenCalledTimes(8)
  for (const result of vi.mocked(spawn).mock.results) (result.value as ChildProcess).emit('exit', 0)
  const fresh = version(); release[9]!()
  expect(await fresh).toEqual({ keepsRecord: true })
  expect(spawn).toHaveBeenCalledTimes(9)
})
