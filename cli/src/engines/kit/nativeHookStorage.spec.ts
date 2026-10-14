import { buildSync } from 'esbuild'
import { beforeEach, expect, it, vi } from 'vitest'
import { probeNativeProcessControl } from '../../lib/nativeProcessControlProbe.js'
import { createNativeHookCatalog } from './nativeHookCatalog.js'
import { createNativeHookStagePool } from './nativeHookStaging.js'
import { captureNativeHookWriter, nativeHookWriterDead } from './nativeHookWriter.js'
import { openNativeHookStorage } from './nativeHookStorage.js'

vi.mock('../../lib/nativeProcessControlProbe.js', () => ({ probeNativeProcessControl: vi.fn() }))
vi.mock('./nativeHookWriter.js', () => ({ captureNativeHookWriter: vi.fn(), nativeHookWriterDead: vi.fn() }))
vi.mock('./nativeHookStaging.js', () => ({ createNativeHookStagePool: vi.fn() }))
vi.mock('./nativeHookCatalog.js', () => ({ createNativeHookCatalog: vi.fn() }))
const root = '/fixture/private-hook-storage'
const helpers = { prepare: vi.fn(), invalidate: vi.fn() }
const identity = { boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', namespace: 'linux:4:5', pid: 8100, birth: '12345' }
const proof = { writer: identity, verifyWriter: vi.fn(), closeWriter: vi.fn() }
const pool = { acquire: vi.fn(), close: vi.fn(async () => { proof.closeWriter() }) }
const catalog = { effects: vi.fn(), readEffects: vi.fn(), readOutbox: vi.fn(), outbox: vi.fn(), close: vi.fn(async () => {}) }
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(captureNativeHookWriter).mockResolvedValue(proof)
  vi.mocked(nativeHookWriterDead).mockResolvedValue(false)
  vi.mocked(createNativeHookStagePool).mockReturnValue(pool)
  vi.mocked(createNativeHookCatalog).mockReturnValue(catalog)
})

it('wires current writer, exact death proof and the sealed catalog to one root', async () => {
  const storage = await openNativeHookStorage(root, helpers)
  expect(captureNativeHookWriter).toHaveBeenCalledWith(root, expect.anything(), expect.any(Function), helpers)
  const options = vi.mocked(createNativeHookStagePool).mock.calls[0][0]
  expect(options).toMatchObject({ root, ...proof })
  expect(createNativeHookCatalog).toHaveBeenCalledWith({ root, verifyRoot: proof.verifyWriter, pool })
  const captureBudget = vi.mocked(captureNativeHookWriter).mock.calls[0][1]
  await vi.mocked(captureNativeHookWriter).mock.calls[0][2]([8100], captureBudget)
  expect(probeNativeProcessControl).toHaveBeenCalledWith([8100], 0, captureBudget, false, helpers)
  await options.dead(identity); await options.dead(identity)
  expect(nativeHookWriterDead).toHaveBeenCalledTimes(2)
  const calls = vi.mocked(nativeHookWriterDead).mock.calls
  expect(calls[0]).toEqual([root, identity, expect.anything(), expect.any(Function), helpers])
  expect(calls[0][2]).not.toBe(calls[1][2])
  const current = () => true
  await storage.effects('process-key', current); await storage.outbox(3, current)
  await storage.readEffects(['process-key'], current)
  await storage.readOutbox(3, current)
  expect(catalog.effects).toHaveBeenCalledWith('process-key', current)
  expect(catalog.outbox).toHaveBeenCalledWith(3, current)
  expect(catalog.readEffects).toHaveBeenCalledWith(['process-key'], current)
  expect(catalog.readOutbox).toHaveBeenCalledWith(3, current)
  await storage.close()
})

it('revokes immediately and retains the writer until catalog I/O and pool cleanup finish', async () => {
  let finishCatalog!: () => void, finishPool!: () => void
  catalog.close.mockImplementationOnce(() => new Promise(done => { finishCatalog = done }))
  pool.close.mockImplementationOnce(() => new Promise(done => { finishPool = () => { proof.closeWriter(); done() } }))
  const storage = await openNativeHookStorage(root, helpers), closing = storage.close()
  expect(storage.close()).toBe(closing)
  expect(catalog.close).toHaveBeenCalledTimes(1)
  expect(pool.close).not.toHaveBeenCalled(); expect(proof.closeWriter).not.toHaveBeenCalled()
  finishCatalog(); await Promise.resolve()
  expect(pool.close).toHaveBeenCalledTimes(1); expect(proof.closeWriter).not.toHaveBeenCalled()
  finishPool(); await closing
  expect(proof.closeWriter).toHaveBeenCalledTimes(1)
})

it('retries failed cleanup without prematurely closing writer authority', async () => {
  pool.close.mockRejectedValueOnce(Error('fixture retained stage'))
  const storage = await openNativeHookStorage(root, helpers)
  await expect(storage.close()).rejects.toThrow('retained stage')
  expect(proof.closeWriter).not.toHaveBeenCalled()
  await storage.close()
  expect(proof.closeWriter).toHaveBeenCalledTimes(1)
})

it('holds unavailable writer proof without constructing a pool or catalog', async () => {
  vi.mocked(captureNativeHookWriter).mockRejectedValueOnce(Error('fixture process evidence unavailable'))
  await expect(openNativeHookStorage(root, helpers)).rejects.toThrow('evidence unavailable')
  expect(createNativeHookStagePool).not.toHaveBeenCalled(); expect(createNativeHookCatalog).not.toHaveBeenCalled()
  expect(proof.closeWriter).not.toHaveBeenCalled()
})

it.each(['pool', 'catalog'])('closes owned resources when %s construction fails', async failing => {
  const factory = failing === 'pool' ? createNativeHookStagePool : createNativeHookCatalog
  vi.mocked(factory).mockImplementationOnce(() => { throw Error('fixture damaged storage') })
  await expect(openNativeHookStorage(root, helpers)).rejects.toThrow('damaged storage')
  expect(pool.close).toHaveBeenCalledTimes(failing === 'pool' ? 0 : 1)
  expect(proof.closeWriter).toHaveBeenCalledTimes(1)
})

it('bundles without daemon configuration, services or dynamically loaded control code', () => {
  const built = buildSync({ entryPoints: ['src/engines/kit/nativeHookStorage.ts'], bundle: true, write: false,
    metafile: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const inputs = Object.keys(built.metafile.inputs)
  expect(inputs.every(path => path.startsWith('src/engines/kit/') || [
    'src/lib/childLocale.ts', 'src/lib/nativeProcessControlProbe.ts', 'src/lib/secureState.ts',
  ].includes(path))).toBe(true)
  expect(built.metafile.outputs[Object.keys(built.metafile.outputs)[0]].imports.every(entry => entry.external)).toBe(true)
  expect(built.outputFiles[0].text).not.toMatch(/\bimport\s*\(/)
})
