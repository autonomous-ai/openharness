import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fingerprint } from '../harnessd/bundleFingerprint.js'
import { SessionStorage } from './sessionStorage.js'
import { SessionStorageUnavailable, type SessionImage, type SessionStorageOperation, type StoppedListPage } from './sessionStorageWire.js'

let root: string, storage: SessionStorage
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
type Owner = { request<T>(operation: SessionStorageOperation): Promise<T>; child?: ChildProcess; listWaiters: Array<{ expires: number }> }
const owner = () => storage as unknown as Owner
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'session-list-'))
  mkdirSync(join(root, 'stopped-agents'), { mode: 0o700 })
  for (let index = 0; index < 65; index++) {
    const agentId = `row-${String(index).padStart(3, '0')}`
    writeFileSync(join(root, 'stopped-agents', `${agentId}.json`), JSON.stringify({ version: 1, session: { agentId, registeredAt: 1 } }), { mode: 0o600 })
  }
  const file = fileURLToPath(new URL('../storage/entry.ts', import.meta.url))
  storage = new SessionStorage(root, () => ({ file, sha256: fingerprint(file)!, execArgv: ['--import', import.meta.resolve('tsx')] }))
})
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks()
  await storage.close()
  rmSync(root, { recursive: true, force: true })
})
const collect = async (catalog = false) => {
  const rows: SessionImage[] = []
  await (catalog ? storage.stoppedCatalog.bind(storage) : storage.stoppedList.bind(storage))(row => rows.push(row))
  return rows
}
function holdFirstPage(kind: 'stopped-list-page' | 'stopped-catalog-page') {
  const entered = deferred(), release = deferred(), request = owner().request.bind(storage)
  let first = true
  vi.spyOn(owner(), 'request').mockImplementation(async operation => {
    const reply = await request(operation)
    if (operation.kind === kind && first) { first = false; entered.resolve(); await release.promise }
    return reply
  })
  return { entered, release }
}

describe('catalog reply boundary', () => {
  it.each([null, { credential: { version: 1 } }])('rejects any credential field in a display reply before delivery (%#)', async gridLaunch => {
    const request = owner().request.bind(storage)
    vi.spyOn(owner(), 'request').mockImplementation(async operation => {
      const reply = await request(operation)
      if (operation.kind !== 'stopped-catalog-page') return reply
      const page = reply as StoppedListPage, image = page.images[0]
      if (image.state !== 'image' || !image.json) throw new Error('fixture image missing')
      return { ...page, images: [{ ...image, value: { version: 1, session: { agentId: 'row-000', registeredAt: 1, gridLaunch } } }] }
    })
    const accept = vi.fn()
    await expect(storage.stoppedCatalog(accept)).rejects.toMatchObject({ code: 'invalid' })
    expect(accept).not.toHaveBeenCalled()
    expect(owner().child).toBeUndefined()
    vi.restoreAllMocks()
    expect(await collect(true)).toHaveLength(65)
  })

  it('shares admission between display and selected listings without sharing their credential purpose', async () => {
    writeFileSync(join(root, 'stopped-agents', 'row-000.json'), JSON.stringify({ version: 1, session: {
      agentId: 'row-000', registeredAt: 1, gridLaunch: null,
    } }), { mode: 0o600 })
    const hold = holdFirstPage('stopped-catalog-page'), display = collect(true)
    await hold.entered.promise
    const selected = collect()
    expect(owner().listWaiters).toHaveLength(1)
    hold.release.resolve()
    const rows = await display, fresh = await selected
    const first = rows[0], selectedFirst = fresh[0]
    expect(first).toMatchObject({ value: { session: { agentId: 'row-000' } } })
    expect(JSON.stringify(first).includes('gridLaunch')).toBe(false)
    expect(selectedFirst).toMatchObject({ value: { session: { gridLaunch: null } } })
  })
})

describe.each([false, true])('stopped listing transport ownership (catalog=%s)', catalog => {
  const kind = catalog ? 'stopped-catalog-page' : 'stopped-list-page'
  const collectRows = () => collect(catalog)
  it.each(['same-page', 'later-page'])('rejects a duplicate selected image in the %s before returning a catalog', async duplicate => {
    const selected = await storage.read({ kind: 'stopped', agentId: 'row-000' })
    const request = owner().request.bind(storage)
    vi.spyOn(owner(), 'request').mockImplementation(async operation => {
      const reply = await request(operation)
      if (operation.kind !== kind) return reply
      const page = reply as StoppedListPage
      if (duplicate === 'same-page' && operation.cursor === null) return { ...page, images: [selected, selected] }
      if (duplicate === 'later-page' && operation.cursor !== null) return { ...page, images: [selected] }
      return reply
    })
    await expect(collectRows()).rejects.toMatchObject({ code: 'invalid' })
    expect(owner().child).toBeUndefined()
    vi.restoreAllMocks()
    expect(await collectRows()).toHaveLength(65)
  })

  it('serializes complete fresh listings while unrelated storage requests continue between pages', async () => {
    const hold = holdFirstPage(kind)
    const first = collectRows()
    await hold.entered.promise
    const second = collectRows()
    expect(owner().listWaiters).toHaveLength(1)
    expect(await storage.read({ kind: 'names' })).toEqual({ state: 'missing' })
    hold.release.resolve()
    expect(await first).toHaveLength(65)
    expect(await second).toHaveLength(65)
  })

  it('rejects partial listing after child loss and permits a fresh replacement listing', async () => {
    const request = owner().request.bind(storage)
    let cursor: string | undefined
    vi.spyOn(owner(), 'request').mockImplementation(async operation => {
      if (operation.kind === kind && operation.cursor) {
        cursor = operation.cursor
        const child = owner().child!, exit = new Promise<void>(resolve => child.once('exit', () => resolve()))
        child.kill('SIGKILL'); await exit
      }
      return request(operation)
    })
    await expect(collectRows()).rejects.toMatchObject({ code: 'changed' })
    expect(typeof cursor).toBe('string')
    vi.restoreAllMocks()
    expect(await collectRows()).toHaveLength(65)
  })

  it('holds the list slot after a failed close until its child actually exits', async () => {
    await storage.read({ kind: 'names' })
    const child = owner().child!, kill = child.kill.bind(child), exited = deferred(), closeAttempt = deferred()
    child.once('exit', exited.resolve)
    const request = owner().request.bind(storage)
    vi.spyOn(owner(), 'request').mockImplementation(async operation => {
      if (operation.kind === 'stopped-list-close') { closeAttempt.resolve(); throw new SessionStorageUnavailable('disconnected') }
      return request(operation)
    })
    const signal = vi.spyOn(child, 'kill').mockReturnValue(true)
    const failing = (catalog ? storage.stoppedCatalog.bind(storage) : storage.stoppedList.bind(storage))(() => { throw new Error('fixture caller stopped') }).catch(error => error)
    await closeAttempt.promise
    const waiting = collectRows()
    await Promise.resolve(); await Promise.resolve()
    expect(owner().listWaiters).toHaveLength(1)
    expect(owner().child).toBe(child)
    expect(signal).toHaveBeenCalledTimes(1)
    signal.mockRestore(); kill('SIGKILL'); await exited.promise
    expect(await failing).toMatchObject({ code: 'disconnected' })
    expect(await waiting).toHaveLength(65)
  })

  it('bounds concurrent list admission and expires queued owners without a whole-list deadline', async () => {
    const hold = holdFirstPage(kind), first = collectRows()
    await hold.entered.promise
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const queued = Array.from({ length: 64 }, () => collectRows().catch(error => error))
    await expect(collectRows()).rejects.toMatchObject({ code: 'busy' })
    await vi.advanceTimersByTimeAsync(5000)
    expect((await Promise.all(queued)).every(error => error.code === 'expired')).toBe(true)
    expect(owner().listWaiters).toHaveLength(0)
    vi.useRealTimers()
    hold.release.resolve()
    expect(await first).toHaveLength(65)
  })

  it('checks the queued monotonic deadline again before ownership even when its timer has not run', async () => {
    const hold = holdFirstPage(kind), first = collectRows()
    await hold.entered.promise
    const waiting = collectRows().catch(error => error)
    owner().listWaiters[0].expires = 0
    hold.release.resolve()
    expect(await first).toHaveLength(65)
    expect(await waiting).toMatchObject({ code: 'expired' })
  })

  it('settles active and queued listing owners before closing storage', async () => {
    const hold = holdFirstPage(kind), first = collectRows().catch(error => error)
    await hold.entered.promise
    const waiting = collectRows().catch(error => error), closing = storage.close()
    hold.release.resolve()
    await closing
    expect(await first).toMatchObject({ code: 'disconnected' })
    expect(await waiting).toMatchObject({ code: 'disconnected' })
    await expect(collectRows()).rejects.toMatchObject({ code: 'disconnected' })
  })

  it.each([
    null,
    { cursor: 'invalid' },
    { next: 65, total: 65, done: true },
    { next: 0, total: 1, done: false },
    { next: 1, total: 1, done: false },
    { next: 1, total: 1, done: true, images: [{ state: 'missing' }] },
    { offset: 1 },
    { total: -1 },
  ])('refuses malformed page progress and reaps its unknown cursor before another listing (%#)', async changes => {
    await storage.read({ kind: 'names' })
    const child = owner().child!, exited = deferred()
    child.once('exit', exited.resolve)
    const page: StoppedListPage = { cursor: randomUUID(), offset: 0, next: 1, total: 1, images: [], done: true }
    vi.spyOn(owner(), 'request').mockResolvedValueOnce(changes === null ? null : { ...page, ...changes })
    await expect(collectRows()).rejects.toMatchObject({ code: 'invalid' })
    await exited.promise
    expect(owner().child).toBeUndefined()
    expect(await collectRows()).toHaveLength(65)
  })
})
