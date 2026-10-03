import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultPlateRenderer, PlateService, WorkerPlateRenderer, type PlateJob, type PlateRenderer, type PlateUnit } from './plateService.js'

const roots: string[] = []
const services: PlateService[] = []
const renderers: PlateRenderer[] = []
const unit = (): PlateUnit => ({ idle: [{ rows: ' o ', mats: ' . ' }], work: [{ rows: ' x ', mats: ' m ' }] })
const request = (seed = 13, extra: Record<string, unknown> = {}) => ({
  uid: 'a'.repeat(24), id: 'tim', seed, size: 'portrait', version: '0.1', mood: 'idle', ...extra,
})
async function service(opts: Partial<ConstructorParameters<typeof PlateService>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'plate-service-'))
  roots.push(root)
  const renderer: PlateRenderer = { kind: 'worker', render: vi.fn(async () => unit()), close: vi.fn() }
  const s = new PlateService({ dir: join(root, 'plates'), source: 'a'.repeat(64), renderer, log: () => {}, ...opts })
  services.push(s)
  return { s, root, renderer }
}
afterEach(async () => {
  services.splice(0).forEach((s) => s.setOn(false))
  renderers.splice(0).forEach((r) => r.close())
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('individual plates', () => {
  it('stays dark without creating a folder or starting a render', async () => {
    const { s, root, renderer } = await service()
    s.observeZoo({ daemons: [{ ...request(), hatched: new Date().toISOString() }] })
    expect(await s.get(request())).toMatchObject({ error: 'DAEMONS_OFF' })
    expect(renderer.render).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
  })

  it('rejects malformed requests and species without a model before rendering', async () => {
    const { s, renderer } = await service()
    s.setOn(true)
    for (const bad of [{ id: '../tim' }, { seed: -1 }, { seed: 2 ** 32 }, { seed: 0.5 }, { size: 'huge' }, { version: '3.0' }, { mood: 'constructor' }]) {
      expect(await s.get(request(13, bad))).toMatchObject({ error: 'BAD_REQUEST' })
    }
    expect(await s.get(request(0, { id: 'fish' }))).toMatchObject({ error: 'NO_ART' })
    expect(renderer.render).not.toHaveBeenCalled()
  })

  it('shares one render across individuals and moods, then reads the private disk cache after restart', async () => {
    const { s, root, renderer } = await service()
    s.setOn(true)
    const [one, two] = await Promise.all([s.get(request()), s.get(request(13, { uid: 'b'.repeat(24), mood: 'work' }))])
    expect(one).toMatchObject({ uid: 'a'.repeat(24), frames: unit().idle, frameMs: 170 })
    expect(two).toMatchObject({ uid: 'b'.repeat(24), frames: unit().work })
    expect(renderer.render).toHaveBeenCalledTimes(1)
    const folder = join(root, 'plates', 'a'.repeat(64))
    expect((await stat(folder)).mode & 0o777).toBe(0o700)
    expect((await stat(join(folder, 'tim-13.json.gz'))).mode & 0o777).toBe(0o600)
    s.setOn(false)
    const restarted = await service({ dir: join(root, 'plates') })
    restarted.s.setOn(true)
    expect(await restarted.s.get(request())).toEqual(one)
    expect(restarted.renderer.render).not.toHaveBeenCalled()
    expect((await readFile(join(folder, 'tim-13.json.gz'))).length).toBeGreaterThan(0)
  })

  it('recovers a corrupt cache and keeps units for both sizes in the same entry', async () => {
    const { s, root } = await service()
    s.setOn(true)
    await s.get(request())
    s.setOn(false)
    await writeFile(join(root, 'plates', 'a'.repeat(64), 'tim-13.json.gz'), 'broken')
    const next = await service({ dir: join(root, 'plates') })
    next.s.setOn(true)
    await Promise.all([next.s.get(request()), next.s.get(request(13, { size: 'reveal' }))])
    expect(next.renderer.render).toHaveBeenCalledTimes(2)
    next.s.setOn(false)
    const last = await service({ dir: join(root, 'plates') })
    last.s.setOn(true)
    await Promise.all([last.s.get(request()), last.s.get(request(13, { size: 'reveal' }))])
    expect(last.renderer.render).not.toHaveBeenCalled()
  })

  it('treats the first zoo read as a baseline and draws subsequent hatches ahead of time', async () => {
    const now = Date.parse('2026-10-01T00:00:00Z')
    const { s, renderer } = await service({ now: () => now })
    s.setOn(true)
    const old = { ...request(), hatched: '2026-09-27T00:00:00Z' }
    s.observeZoo({ daemons: [old] })
    await new Promise((resolve) => setImmediate(resolve))
    expect(renderer.render).not.toHaveBeenCalled()
    const fresh = { ...request(17, { uid: 'b'.repeat(24) }), hatched: '2026-10-01T00:00:00Z' }
    s.observeZoo({ daemons: [old, fresh] })
    await vi.waitFor(() => expect(s.stats().renders).toBe(2))
    await s.get(request(17)) // also joins persistence, before removing the temporary directory
    expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({ seed: 17, size: 'portrait' }))
    expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({ seed: 17, size: 'reveal' }))
    s.observeZoo({ daemons: [old, fresh] })
    expect(renderer.render).toHaveBeenCalledTimes(2)
  })

  it('discards an in-flight response when disabled, and can serve it after re-enabling', async () => {
    let finish: (u: PlateUnit) => void = () => {}
    const renderer: PlateRenderer = { kind: 'worker', render: vi.fn(() => new Promise<PlateUnit>((resolve) => { finish = resolve })), close: vi.fn() }
    const { s, root } = await service({ renderer })
    s.setOn(true)
    const first = s.get(request())
    await vi.waitFor(() => expect(renderer.render).toHaveBeenCalledOnce())
    s.setOn(false)
    s.setOn(true)
    finish(unit())
    expect(await first).toMatchObject({ error: 'DAEMONS_OFF' })
    expect(await readdir(root)).toEqual([])
    vi.mocked(renderer.render).mockResolvedValue(unit())
    expect(await s.get(request())).toHaveProperty('frames')
    expect(renderer.render).toHaveBeenCalledTimes(2)
  })

  it('bounds the waiting queue and promotes a requested unit above pre-renders', async () => {
    const pending: Array<{ job: PlateJob; resolve: (u: PlateUnit) => void }> = []
    const renderer: PlateRenderer = {
      kind: 'worker', render: vi.fn((job: PlateJob) => new Promise<PlateUnit>((resolve) => pending.push({ job, resolve }))), close: vi.fn(),
    }
    const { s } = await service({ renderer, maxQueue: 2 })
    s.setOn(true)
    const job = (seed: number): PlateJob => ({ id: 'tim', seed, size: 'portrait', version: '0.1' })
    const one = s.unit(job(1), 'prerender')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    const two = s.unit(job(2), 'prerender')
    const three = s.unit(job(3), 'prerender')
    await vi.waitFor(() => expect(s.stats().waiting).toBe(2))
    const promoted = s.get(request(3))
    expect(await s.get(request(4))).toMatchObject({ error: 'BUSY' })
    pending[0].resolve(unit())
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    expect(pending[1].job.seed).toBe(3)
    pending[1].resolve(unit())
    await vi.waitFor(() => expect(pending).toHaveLength(3))
    expect(pending[2].job.seed).toBe(2)
    pending[2].resolve(unit())
    await Promise.all([one, two, three, promoted])
  })

  it('recovers from synchronous renderer failures and a cache that cannot be written', async () => {
    const { s, root, renderer } = await service()
    s.setOn(true)
    vi.mocked(renderer.render).mockImplementationOnce(() => { throw new Error('worker unavailable') })
    expect(await s.get(request())).toMatchObject({ error: 'RENDER_FAILED' })
    await writeFile(join(root, 'plates'), 'not a directory')
    expect(await s.get(request())).toHaveProperty('frames')
    expect(renderer.render).toHaveBeenCalledTimes(2)
  })

  it('evicts art when the cache exceeds its byte limit', async () => {
    const { s, root } = await service({ maxBytes: 1 })
    s.setOn(true)
    expect(await s.get(request())).toHaveProperty('frames')
    expect(s.stats().evicted).toBe(1)
    expect(await readdir(join(root, 'plates', 'a'.repeat(64)))).toEqual([])
  })
})

describe('plate workers', () => {
  it('starts lazily, stops when idle and rejects an abandoned render', async () => {
    const renderer = new WorkerPlateRenderer(`const {parentPort} = require('node:worker_threads'); parentPort.on('message', ({n, job}) => { if (job.seed !== 99) parentPort.postMessage({n, unit: {idle: [{rows: 'o', mats: '.'}]}}); });`, { idleMs: 10 })
    renderers.push(renderer)
    const job: PlateJob = { id: 'tim', seed: 0, size: 'portrait', version: '0.1' }
    expect(renderer.running()).toBe(false)
    expect(await renderer.render(job)).toHaveProperty('idle')
    await vi.waitFor(() => expect(renderer.running()).toBe(false))
    const pending = renderer.render({ ...job, seed: 99 })
    const rejected = expect(pending).rejects.toThrow('closed')
    renderer.close()
    await rejected
  })

  it('draws real source models in a worker while the event loop stays responsive', async () => {
    const renderer = defaultPlateRenderer()
    renderers.push(renderer)
    expect(renderer.kind).toBe('worker')
    let ticks = 0
    const timer = setInterval(() => ticks++, 5)
    try {
      const drawn = await renderer.render({ id: 'tim', seed: 13, size: 'portrait', version: '0.1' })
      expect(ticks).toBeGreaterThan(5)
      expect(drawn.idle).toHaveLength(8)
      expect(drawn.work).toHaveLength(4)
      for (const loop of Object.values(drawn)) for (const frame of loop) {
        expect(frame.rows.split('\n').map((r) => r.length)).toEqual(frame.mats.split('\n').map((r) => r.length))
        expect(frame.rows).toMatch(/^[\x20-\x7e\n]+$/)
      }
    } finally { clearInterval(timer) }
  }, 60_000)
})
