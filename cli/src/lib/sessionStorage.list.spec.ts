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
const collect = async () => { const rows: SessionImage[] = []; await storage.stoppedList(row => rows.push(row)); return rows }
function holdFirstPage() {
  const entered = deferred(), release = deferred(), request = owner().request.bind(storage)
  let first = true
  vi.spyOn(owner(), 'request').mockImplementation(async operation => {
    const reply = await request(operation)
    if (operation.kind === 'stopped-list-page' && first) { first = false; entered.resolve(); await release.promise }
    return reply
  })
  return { entered, release }
}

describe('stopped listing transport ownership', () => {
  it.each(['same-page', 'later-page'])('rejects a duplicate selected image in the %s before returning a catalog', async kind => {
    const selected = await storage.read({ kind: 'stopped', agentId: 'row-000' })
    const request = owner().request.bind(storage)
    vi.spyOn(owner(), 'request').mockImplementation(async operation => {
      const reply = await request(operation)
      if (operation.kind !== 'stopped-list-page') return reply
      const page = reply as StoppedListPage
      if (kind === 'same-page' && operation.cursor === null) return { ...page, images: [selected, selected] }
      if (kind === 'later-page' && operation.cursor !== null) return { ...page, images: [selected] }
      return reply
    })
    await expect(collect()).rejects.toMatchObject({ code: 'invalid' })
    expect(owner().child).toBeUndefined()
    vi.restoreAllMocks()
    expect(await collect()).toHaveLength(65)
  })

  it('serializes complete fresh listings while unrelated storage requests continue between pages', async () => {
    const hold = holdFirstPage()
    const first = collect()
    await hold.entered.promise
    const second = collect()
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
      if (operation.kind === 'stopped-list-page' && operation.cursor) {
        cursor = operation.cursor
        const child = owner().child!, exit = new Promise<void>(resolve => child.once('exit', () => resolve()))
        child.kill('SIGKILL'); await exit
      }
      return request(operation)
    })
    await expect(collect()).rejects.toMatchObject({ code: 'changed' })
    expect(typeof cursor).toBe('string')
    vi.restoreAllMocks()
    expect(await collect()).toHaveLength(65)
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
    const failing = storage.stoppedList(() => { throw new Error('fixture caller stopped') }).catch(error => error)
    await closeAttempt.promise
    const waiting = collect()
    await Promise.resolve(); await Promise.resolve()
    expect(owner().listWaiters).toHaveLength(1)
    expect(owner().child).toBe(child)
    expect(signal).toHaveBeenCalledTimes(1)
    signal.mockRestore(); kill('SIGKILL'); await exited.promise
    expect(await failing).toMatchObject({ code: 'disconnected' })
    expect(await waiting).toHaveLength(65)
  })

  it('bounds concurrent list admission and expires queued owners without a whole-list deadline', async () => {
    const hold = holdFirstPage(), first = collect()
    await hold.entered.promise
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const queued = Array.from({ length: 64 }, () => collect().catch(error => error))
    await expect(collect()).rejects.toMatchObject({ code: 'busy' })
    await vi.advanceTimersByTimeAsync(5000)
    expect((await Promise.all(queued)).every(error => error.code === 'expired')).toBe(true)
    expect(owner().listWaiters).toHaveLength(0)
    vi.useRealTimers()
    hold.release.resolve()
    expect(await first).toHaveLength(65)
  })

  it('checks the queued monotonic deadline again before ownership even when its timer has not run', async () => {
    const hold = holdFirstPage(), first = collect()
    await hold.entered.promise
    const waiting = collect().catch(error => error)
    owner().listWaiters[0].expires = 0
    hold.release.resolve()
    expect(await first).toHaveLength(65)
    expect(await waiting).toMatchObject({ code: 'expired' })
  })

  it('settles active and queued listing owners before closing storage', async () => {
    const hold = holdFirstPage(), first = collect().catch(error => error)
    await hold.entered.promise
    const waiting = collect().catch(error => error), closing = storage.close()
    hold.release.resolve()
    await closing
    expect(await first).toMatchObject({ code: 'disconnected' })
    expect(await waiting).toMatchObject({ code: 'disconnected' })
    await expect(collect()).rejects.toMatchObject({ code: 'disconnected' })
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
    await expect(collect()).rejects.toMatchObject({ code: 'invalid' })
    await exited.promise
    expect(owner().child).toBeUndefined()
    expect(await collect()).toHaveLength(65)
  })
})
