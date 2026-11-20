import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CheckpointStages, type CheckpointStage } from './checkpointStages.js'

const io = vi.hoisted(() => ({ drains: [] as Promise<void>[] }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    if (!String(args[0]).endsWith('history.tmp')) return fs.open(...args)
    let finish!: () => void
    io.drains.push(new Promise<void>(resolve => { finish = resolve }))
    try {
      const handle = await fs.open(...args), close = handle.close.bind(handle)
      handle.close = async () => { try { await close() } finally { finish() } }
      return handle
    } catch (error) { finish(); throw error }
  } }
})
let root: string
const stages: CheckpointStage[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'checkpoint-writer-lease-'))
  vi.stubEnv('ADAPTER_DATA_DIR', root)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  io.drains.length = 0
})
afterEach(async () => {
  for (const stage of stages.splice(0)) await stage.close()
  await Promise.all(io.drains)
  await new Promise<void>(resolve => setImmediate(resolve))
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
const directory = () => join(root, '.stages')
const destination = () => join(root, `${'a'.repeat(64)}-${'b'.repeat(36)}.history`)
const manager = () => new CheckpointStages(directory())
const owner = async () => JSON.parse(await readFile(join(directory(), '0', 'owner.json'), 'utf8'))
async function acquire() {
  const stage = await manager().acquire(destination(), process.pid, performance.now() + 30_000)
  stages.push(stage); return stage
}

it('persists the attested writer in the first owner without exposing a worker path', async () => {
  const stage = await acquire()
  expect(await owner()).toMatchObject({ version: 2, core: process.pid, writer: process.pid, settled: false })
  expect(stage).not.toHaveProperty('stage')
  expect(stage).not.toHaveProperty('writer')
  expect(stage).not.toHaveProperty('settled')
})

it('hands the durable lease to its writer once', async () => {
  const stage = await acquire(), lease = stage.handoff()
  expect(lease.stage.path).toBe(join(directory(), '0', 'history.tmp'))
  expect(lease.stage.key).toBe((await owner()).key)
  expect(lease.deadline).toBeGreaterThan(performance.now())
  expect(() => stage.handoff()).toThrow()
  await lease.settled()
  await stage.close()
  expect(await readdir(directory())).toEqual([])
})

it('removes an unexposed reservation even while its attested writer lives', async () => {
  const stage = await acquire()
  expect((await owner()).writer).toBe(process.pid)
  await stage.close()
  expect(await readdir(directory())).toEqual([])
})

it('retains an exposed unsettled writer', async () => {
  const stage = await acquire(); stage.handoff()
  await stage.close()
  expect(await readdir(directory())).toEqual(['0'])
  expect(await owner()).toMatchObject({ writer: process.pid, settled: false })
})

it('cannot expose a closed lease', async () => {
  const stage = await acquire(); await stage.close()
  expect(() => stage.handoff()).toThrow()
  expect(await readdir(directory())).toEqual([])
})

it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses writer %s before making a slot', async pid => {
  const request = manager().acquire(destination(), pid, performance.now() + 30_000)
  void request.then(stage => { stages.push(stage) }, () => {})
  await expect(request).rejects.toThrow()
  expect(await readdir(root)).toEqual([])
})

it('refuses an expired reservation before making a slot', async () => {
  const request = manager().acquire(destination(), process.pid, performance.now() - 1)
  void request.then(stage => { stages.push(stage) }, () => {})
  await expect(request).rejects.toMatchObject({ code: 'CHECKPOINT_STAGE_TIMEOUT' })
  expect(await readdir(root)).toEqual([])
})
