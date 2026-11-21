import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync, type BigIntStats } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStoppedCatalog } from './stoppedCatalog.js'
import { createSessionImageCodec } from './sessionImage.js'
import { sessionFileIdentity, SessionStorageUnavailable, type SessionImage } from '../lib/sessionStorageWire.js'

vi.mock('node:fs', async original => ({ ...await original<object>() }))
let root: string, directory: string, file: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stopped-catalog-'))
  directory = join(root, 'stopped-agents'); mkdirSync(directory, { mode: 0o700 })
  file = join(directory, 'fixture.json')
  writeFileSync(file, '{}', { mode: 0o600 })
})
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
const image = (id = 'fixture', title = 'First', stat = lstatSync(file, { bigint: true })): SessionImage => ({
  state: 'image', json: true, proof: { document: { kind: 'stopped', agentId: id }, identity: sessionFileIdentity(stat), bytes: 2, sha256: 'a'.repeat(64) },
  value: { version: 1, session: { agentId: id, title, nested: { title: 'First' } } },
})
const title = (image: SessionImage) => image.state === 'image' && image.json ? (image.value as { session: { title: string } }).session.title : null

describe('bounded child display reuse', () => {
  it('rechecks metadata on hits, returns owned graphs, and expires from the read rather than extending on hits', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const inspect = vi.fn(() => lstatSync(file, { bigint: true })), load = vi.fn(async () => image())
    const read = createStoppedCatalog(), first = await read('fixture', inspect, load)
    if (first.state !== 'image' || !first.json) throw Error('fixture image missing')
    ;(first.value as { session: { nested: { title: string } } }).session.nested.title = 'caller mutation'
    now = 29_999
    const hit = await read('fixture', inspect, load)
    expect(hit).toMatchObject({ value: { session: { nested: { title: 'First' } } } })
    expect(load).toHaveBeenCalledTimes(1); expect(inspect).toHaveBeenCalledTimes(2)
    now = 30_000
    await read('fixture', inspect, load)
    expect(load).toHaveBeenCalledTimes(2)
    now = 29_000
    await read('fixture', inspect, load)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it.each(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs', 'mode', 'uid', 'gid', 'nlink'] as const)
    ('revokes reuse when the complete metadata changes at %s', async field => {
      const initial = lstatSync(file, { bigint: true }), changed = { ...initial, [field]: initial[field] + 1n } as BigIntStats
      let stat = initial, value = 'First'
      const load = vi.fn(async () => image('fixture', value, stat)), read = createStoppedCatalog()
      await read('fixture', () => stat, load)
      value = 'Replacement'; stat = changed
      expect(title(await read('fixture', () => stat, load))).toBe('Replacement')
      expect(load).toHaveBeenCalledTimes(2)
    })

  it('forgets missing and refused paths and never caches missing or malformed images', async () => {
    const read = createStoppedCatalog(), stat = () => lstatSync(file, { bigint: true }), load = vi.fn(async () => image())
    await read('fixture', stat, load)
    expect(await read('fixture', () => null, load)).toEqual({ state: 'missing' })
    await read('fixture', stat, load)
    const failure = new SessionStorageUnavailable('unsafe')
    await expect(read('fixture', () => { throw failure }, load)).rejects.toBe(failure)
    await read('fixture', stat, load)
    expect(load).toHaveBeenCalledTimes(3)
    const missing = vi.fn(async (): Promise<SessionImage> => ({ state: 'missing' }))
    await read('absent', stat, missing); await read('absent', stat, missing)
    expect(missing).toHaveBeenCalledTimes(2)
    const good = image()
    if (good.state !== 'image') throw Error('fixture image missing')
    const malformed = vi.fn(async (): Promise<SessionImage> => ({ state: 'image', json: false, proof: good.proof }))
    await read('malformed', stat, malformed); await read('malformed', stat, malformed)
    expect(malformed).toHaveBeenCalledTimes(2)
    await expect(read('failed', stat, async () => { throw failure })).rejects.toBe(failure)
  })

  it('keeps all 2049 requested records visible while only 2048 can reuse a cached image', async () => {
    const read = createStoppedCatalog(), stat = () => lstatSync(file, { bigint: true })
    const load = vi.fn(async (id: string) => image(id))
    for (let pass = 0; pass < 2; pass++) {
      const rows: SessionImage[] = []
      for (let index = 0; index < 2049; index++) {
        const id = `row-${index}`
        rows.push(await read(id, stat, () => load(id)))
      }
      expect(rows).toHaveLength(2049)
    }
    expect(load).toHaveBeenCalledTimes(2050)
  })

  it('keeps all supported large rows visible beyond the four-MiB retention bound', async () => {
    const read = createStoppedCatalog(), stat = () => lstatSync(file, { bigint: true })
    const loads = new Map<string, number>()
    const load = async (id: string, size = 512 * 1024) => { loads.set(id, (loads.get(id) ?? 0) + 1); return image(id, 'x'.repeat(size)) }
    for (let pass = 0; pass < 2; pass++) {
      for (let index = 0; index < 10; index++) {
        const id = `row-${index}`
        expect(title(await read(id, stat, () => load(id)))?.length).toBe(512 * 1024)
      }
    }
    expect([...loads.values()].some(count => count === 1)).toBe(true)
    expect([...loads.values()].some(count => count === 2)).toBe(true)
  })
})

describe('the catalog uses the same guarded private image reader', () => {
  const write = (title: string) => writeFileSync(file, JSON.stringify({ version: 1, session: { agentId: 'fixture', registeredAt: 1, title,
    gridLaunch: { networkId: 'fixture', networkName: 'Display Grid', baseUrl: 'https://grid.example.test/v1', apiKey: randomUUID() } } }), { mode: 0o600 })

  it('reuses only sanitized display rows while fresh reads retain exact selected credential proofs', async () => {
    write('First')
    const codec = createSessionImageCodec(root), open = vi.spyOn(fs, 'openSync')
    const read = () => codec.readStoppedCatalogPage(reader => reader({ kind: 'stopped', agentId: 'fixture' }))
    expect(title(await read())).toBe('First'); expect(title(await read())).toBe('First')
    expect(open.mock.calls.filter(([path]) => path === file)).toHaveLength(1)
    const catalog = await read()
    expect(JSON.stringify(catalog).includes('gridLaunch')).toBe(false)
    const selected = await codec.read({ kind: 'stopped', agentId: 'fixture' })
    expect(selected).toMatchObject({ value: { session: { gridLaunch: { credential: { version: 1 } } } } })
    expect(open.mock.calls.filter(([path]) => path === file)).toHaveLength(2)
    write('Replacement')
    expect(title(await read())).toBe('Replacement')
    expect(open.mock.calls.filter(([path]) => path === file)).toHaveLength(3)
    rmSync(file)
    expect(await read()).toEqual({ state: 'missing' })
  })

  it.skipIf(process.platform === 'win32')('revokes an unsafe file, symlink and container despite a previously cached row', async () => {
    write('First')
    const codec = createSessionImageCodec(root)
    const read = () => codec.readStoppedCatalogPage(reader => reader({ kind: 'stopped', agentId: 'fixture' }))
    await read(); chmodSync(file, 0o666)
    await expect(read()).rejects.toMatchObject({ code: 'unsafe' })
    chmodSync(file, 0o600); await read()
    renameSync(file, file + '-old'); symlinkSync(file + '-old', file)
    await expect(read()).rejects.toMatchObject({ code: 'unsafe' })
    rmSync(file); renameSync(file + '-old', file); await read()
    chmodSync(directory, 0o777)
    await expect(read()).rejects.toMatchObject({ code: 'unsafe' })
  })

  it('refuses a non-archive document through the catalog reader', async () => {
    const codec = createSessionImageCodec(root)
    await expect(codec.readStoppedCatalogPage(read => read({ kind: 'registry' }))).rejects.toMatchObject({ code: 'invalid' })
  })
})
