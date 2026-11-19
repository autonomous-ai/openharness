import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PasteClipboardResult } from '../core/api.js'
import { createPasteClipboard } from './pasteClipboard.js'
import { openPreparedPaste, PasteArtifactCleanupUnconfirmed } from '../lib/pasteArtifact.js'
import { startClipboardOwner } from './pasteClipboardNative.js'
import type { ClipboardReservation } from './pasteClipboardReservation.js'

vi.mock('../lib/pasteArtifact.js', async (original) => {
  const module = await original<typeof import('../lib/pasteArtifact.js')>()
  return { ...module, openPreparedPaste: vi.fn(module.openPreparedPaste) }
})
vi.mock('./pasteClipboardNative.js', async (original) => {
  const module = await original<typeof import('./pasteClipboardNative.js')>()
  return { ...module, startClipboardOwner: vi.fn(module.startClipboardOwner) }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const request = (index: number, connection = 'client') => ({ generation: `generation-${index}`, connection,
  streamId: `stream-${index}`, artifact: { name: `image-${index}.png`, version: 'version' } })
function fixture(busy?: (connection: string) => { total: number; connection: number }, reservation?: ClipboardReservation) {
  const owners: Array<{ ready: ReturnType<typeof deferred<PasteClipboardResult>>; settled: ReturnType<typeof deferred<void>>; cancel: ReturnType<typeof vi.fn> }> = []
  const admissions = Array.from({ length: 32 }, () => deferred<void>())
  const open = vi.fn((_generation: string, artifact: { name: string }) => ({ path: artifact.name, descriptor: 0, current: () => true, close() {} }))
  const start = vi.fn(() => {
    const owner = { ready: deferred<PasteClipboardResult>(), settled: deferred<void>(), cancel: vi.fn() }
    owners.push(owner); admissions[owners.length - 1].resolve()
    return { ready: owner.ready.promise, settled: owner.settled.promise, cancel: owner.cancel }
  })
  const clipboard = createPasteClipboard('/private-fixture', { open, start, busy,
    reservation: reservation ?? { claim: async () => ({ release: async () => {} }), release: async () => {} } })
  return { clipboard, owners, open, start, admitted: (index = 0) => admissions[index].promise }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('paste clipboard reservation', () => {
  it('retains an uncertain validation-close owner through release, cancel and stop', async () => {
    vi.useFakeTimers()
    const release = vi.fn(async () => {})
    const f = fixture(undefined, { claim: async () => ({ release }), release })
    f.open.mockImplementation(() => { throw new PasteArtifactCleanupUnconfirmed() })
    expect(await f.clipboard.prepare(request(1))).toEqual({ state: 'failed', reason: 'PASTE_FILE_CLOSE_FAILED' })
    expect(f.clipboard.usage('client')).toEqual({ total: 1, connection: 1 })
    await f.clipboard.release(request(1).generation)
    f.clipboard.cancel(request(1).generation)
    let stopped = false
    void f.clipboard.stop().then(() => { stopped = true })
    await vi.runAllTimersAsync()
    expect(stopped).toBe(false)
    expect(release).not.toHaveBeenCalled()
    expect(f.open).toHaveBeenCalledOnce()
    expect(f.start).not.toHaveBeenCalled()
    expect(f.clipboard.usage('client')).toEqual({ total: 1, connection: 1 })
  })

  it.skipIf(process.platform === 'win32')('keeps a replacement worker from overwriting A before A final input settles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'paste-replacement-'))
    await mkdir(join(root, 'paste-drops'), { mode: 0o700 })
    const starts: string[] = []
    const deps = {
      open: (_generation: string, artifact: { name: string }) => ({ path: artifact.name, descriptor: 0, current: () => true, close() {} }),
      start: (file: { path: string }) => {
        starts.push(file.path)
        return { ready: Promise.resolve({ state: 'written' as const }), settled: Promise.resolve(), cancel() {} }
      },
    }
    const first = createPasteClipboard(root, deps), replacement = createPasteClipboard(root, deps)
    const a = { ...request(1), generation: randomUUID() }, b = { ...request(2), generation: randomUUID() }
    try {
      expect(await first.prepare(a)).toEqual({ state: 'written' })
      await first.stop() // Losing the component is not an acknowledgement of the still-pending core input.
      expect(await replacement.prepare(b)).toEqual({ state: 'unavailable', reason: 'PASTE_CLIPBOARD_HELD' })
      expect(starts).toEqual([a.artifact.name])
      await replacement.release(a.generation)
      const c = { ...request(3), generation: randomUUID() }
      expect(await replacement.prepare(c)).toEqual({ state: 'written' })
      await first.release(a.generation)
      const another = createPasteClipboard(root, deps)
      expect(await another.prepare({ ...request(4), generation: randomUUID() }))
        .toEqual({ state: 'unavailable', reason: 'PASTE_CLIPBOARD_HELD' })
      await another.stop(); await replacement.release(c.generation)
    } finally {
      await first.release(a.generation); await replacement.release(b.generation)
      await first.stop(); await replacement.stop(); await rm(root, { recursive: true, force: true })
    }
  })

  it('holds cancellation during marker creation and cleanup until OS work settles, without resurrecting A', async () => {
    const claiming = deferred<{ release(): Promise<void> } | null>(), removing = deferred<void>(), removalStarted = deferred<void>()
    const release = vi.fn(() => { removalStarted.resolve(); return removing.promise })
    const reservation: ClipboardReservation = { claim: vi.fn().mockReturnValueOnce(claiming.promise)
      .mockResolvedValue({ release: async () => {} }), release: async () => {} }
    const f = fixture(undefined, reservation), a = f.clipboard.prepare(request(1)), b = f.clipboard.prepare(request(2))
    f.clipboard.cancel(request(1).generation); void f.clipboard.release(request(1).generation)
    expect(await a).toEqual({ state: 'failed', reason: 'PASTE_CANCELLED' })
    expect(f.clipboard.usage('client')).toEqual({ total: 2, connection: 2 })
    expect(f.start).not.toHaveBeenCalled(); expect(reservation.claim).toHaveBeenCalledOnce()
    claiming.resolve({ release }); await removalStarted.promise
    expect(f.start).not.toHaveBeenCalled(); expect(reservation.claim).toHaveBeenCalledOnce()
    removing.resolve(); await f.admitted()
    expect(f.open.mock.calls[0][0]).toBe(request(2).generation)
    f.owners[0].ready.resolve({ state: 'written' }); f.owners[0].settled.resolve(); await b
    await f.clipboard.release(request(2).generation); await f.clipboard.stop()
  })

  it('admits B without mutating clipboard until A final input releases its generation', async () => {
    const f = fixture(), a = f.clipboard.prepare(request(1)), b = f.clipboard.prepare(request(2))
    await f.admitted()
    expect(f.start).toHaveBeenCalledOnce()
    f.owners[0].ready.resolve({ state: 'written' }); f.owners[0].settled.resolve()
    expect(await a).toEqual({ state: 'written' })
    expect(f.start).toHaveBeenCalledOnce()
    f.clipboard.release('unknown')
    expect(f.start).toHaveBeenCalledOnce()
    await f.clipboard.release(request(1).generation)
    await f.admitted(1)
    expect(f.start).toHaveBeenCalledTimes(2)
    f.clipboard.release(request(1).generation)
    f.owners[1].ready.resolve({ state: 'written' }); f.owners[1].settled.resolve()
    expect(await b).toEqual({ state: 'written' })
    f.clipboard.release(request(2).generation)
    await f.clipboard.stop()
  })

  it('retains a cancelled native owner until real settlement, then ignores its late release', async () => {
    const f = fixture(), a = f.clipboard.prepare(request(1)), b = f.clipboard.prepare(request(2))
    await f.admitted()
    f.owners[0].ready.resolve({ state: 'written' }); await a
    f.clipboard.cancel(request(1).generation); f.clipboard.release(request(1).generation)
    expect(f.owners[0].cancel).toHaveBeenCalledOnce()
    expect(f.start).toHaveBeenCalledOnce()
    expect(f.clipboard.usage('client')).toEqual({ total: 2, connection: 2 })
    f.owners[0].settled.resolve(); await f.admitted(1)
    expect(f.start).toHaveBeenCalledTimes(2)
    f.clipboard.release(request(1).generation)
    f.owners[1].ready.resolve({ state: 'written' }); await b
    const c = f.clipboard.prepare(request(3))
    expect(f.start).toHaveBeenCalledTimes(2)
    await f.clipboard.release(request(2).generation)
    await f.admitted(2)
    expect(f.start).toHaveBeenCalledTimes(3)
    f.owners[1].settled.resolve(); f.owners[2].ready.resolve({ state: 'written' }); f.owners[2].settled.resolve()
    await c; f.clipboard.release(request(3).generation); await f.clipboard.stop()
  })

  it('counts a forked owner after dispatch releases until its serving process actually exits', async () => {
    const f = fixture(), a = f.clipboard.prepare(request(1))
    await f.admitted()
    f.owners[0].ready.resolve({ state: 'written' }); await a
    await f.clipboard.release(request(1).generation)
    expect(f.clipboard.usage('client')).toEqual({ total: 1, connection: 1 })
    const b = f.clipboard.prepare(request(2))
    await f.admitted(1)
    expect(f.start).toHaveBeenCalledTimes(2)
    f.clipboard.cancel(null)
    expect(f.owners.every((owner) => owner.cancel.mock.calls.length === 1)).toBe(true)
    f.owners[0].settled.resolve(); f.owners[1].ready.resolve({ state: 'failed', reason: 'PASTE_CANCELLED' }); f.owners[1].settled.resolve()
    expect(await b).toMatchObject({ state: 'failed' }); await f.clipboard.stop()
    expect(f.clipboard.usage('client')).toEqual({ total: 0, connection: 0 })
  })

  it('bounds total and per-connection preparations together with uploads, without queuing refused work', async () => {
    const f = fixture(), pending: Promise<PasteClipboardResult>[] = []
    for (let index = 0; index < 4; index++) pending.push(f.clipboard.prepare(request(index)))
    expect(await f.clipboard.prepare(request(5))).toEqual({ state: 'failed', reason: 'PASTE_CAPACITY' })
    expect(await f.clipboard.prepare(request(0))).toEqual({ state: 'failed', reason: 'PASTE_CLIPBOARD_BUSY' })
    for (let index = 4; index < 32; index++) pending.push(f.clipboard.prepare(request(index, `client-${index}`)))
    expect(await f.clipboard.prepare(request(33, 'other'))).toEqual({ state: 'failed', reason: 'PASTE_CAPACITY' })
    await f.admitted()
    f.clipboard.cancel(null)
    f.owners[0].ready.resolve({ state: 'failed', reason: 'PASTE_CANCELLED' }); f.owners[0].settled.resolve()
    await Promise.all(pending); await f.clipboard.stop()
    expect(await f.clipboard.prepare(request(40))).toEqual({ state: 'failed', reason: 'PASTE_UNAVAILABLE' })
    const full = fixture(() => ({ total: 32, connection: 4 }))
    expect(await full.clipboard.prepare(request(1))).toEqual({ state: 'failed', reason: 'PASTE_CAPACITY' })
    expect(full.start).not.toHaveBeenCalled(); await full.clipboard.stop()
  })

  it('does not free a timed-out preparation just because its response deadline passed', async () => {
    vi.useFakeTimers()
    const f = fixture(), a = f.clipboard.prepare(request(1)), b = f.clipboard.prepare(request(2))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await a).toEqual({ state: 'failed', reason: 'PASTE_CLIPBOARD_TIMEOUT' })
    expect(await b).toEqual({ state: 'failed', reason: 'PASTE_CLIPBOARD_TIMEOUT' })
    expect(f.start).toHaveBeenCalledOnce()
    expect(f.clipboard.usage('client')).toEqual({ total: 1, connection: 1 })
    f.clipboard.release(request(1).generation)
    f.owners[0].ready.resolve({ state: 'written' }); f.owners[0].settled.resolve()
    await f.clipboard.stop()
  })

  it('drops a cancelled waiter and waits for every active owner on stop', async () => {
    const f = fixture(), a = f.clipboard.prepare(request(1)), b = f.clipboard.prepare(request(2))
    await f.admitted()
    f.clipboard.release(request(2).generation)
    expect(await b).toEqual({ state: 'failed', reason: 'PASTE_CANCELLED' })
    let stopped = false
    const stop = f.clipboard.stop().then(() => { stopped = true })
    expect(stopped).toBe(false)
    expect(await a).toMatchObject({ state: 'failed' })
    f.owners[0].ready.resolve({ state: 'unavailable', reason: 'PASTE_CLIPBOARD_UNAVAILABLE' }); f.owners[0].settled.resolve()
    await stop; expect(stopped).toBe(true)
  })

  it('refuses changed artifact authority without starting a native helper', async () => {
    const f = fixture()
    f.open.mockImplementation(() => { throw new Error('changed') })
    expect(await f.clipboard.prepare(request(1))).toEqual({ state: 'failed', reason: 'PASTE_INVALID_ARTIFACT' })
    expect(f.start).not.toHaveBeenCalled()
    await f.clipboard.stop()
  })
  it.each([new Error('PASTE_CLIPBOARD_UNSAFE_RESERVATION'), new Error('private details'), 'private details'])('makes marker preparation failure visible without exposing its content', async (error) => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = fixture(undefined, { claim: async () => { throw error }, release: async () => {} })
    const reason = error instanceof Error && error.message.startsWith('PASTE_') ? error.message : 'PASTE_CLIPBOARD_RESERVATION_FAILED'
    expect(await f.clipboard.prepare(request(1))).toEqual({ state: 'failed', reason })
    expect(log).toHaveBeenCalledWith(`[paste] PASTE_CLIPBOARD_RESERVATION_FAILED · ${error instanceof Error ? 'Error' : 'string'}`)
    await f.clipboard.stop()
  })

  it('reports failed token release, ignores another core, and does not replay native preparation', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const release = vi.fn(async () => { throw new Error('private') })
    const f = fixture(undefined, { claim: async () => ({ release }), release })
    const a = f.clipboard.prepare(request(1)); await f.admitted()
    await f.clipboard.release(request(1).generation, process.pid + 1)
    expect(release).not.toHaveBeenCalled()
    f.owners[0].ready.resolve({ state: 'written' }); f.owners[0].settled.resolve(); await a
    await f.clipboard.release(request(1).generation)
    await f.clipboard.release('not-local')
    f.clipboard.cancel('not-local')
    expect(log).toHaveBeenCalledTimes(2); expect(f.start).toHaveBeenCalledOnce()
    await f.clipboard.stop()
  })

  it.each(['win32', 'linux'] as const)('uses path fallback on %s before opening a file or probing identity', async (platform) => {
    vi.stubGlobal('process', { ...process, platform, env: { ...process.env, WSL_DISTRO_NAME: 'private-fixture' } })
    const claim = vi.fn(), clipboard = createPasteClipboard('/fixture', { reservation: { claim, release: async () => {} } })
    expect(await clipboard.prepare(request(1))).toMatchObject({ state: 'unavailable' })
    expect(claim).not.toHaveBeenCalled(); await clipboard.stop()
  })

  it('uses the shared artifact proof and native owner when no test owner is supplied', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    const file = { path: '/fixture', descriptor: 0, current: () => true, close() {} }
    vi.mocked(openPreparedPaste).mockReturnValueOnce(file)
    vi.mocked(startClipboardOwner).mockReturnValueOnce({ ready: Promise.resolve({ state: 'written' }), settled: Promise.resolve(), cancel() {} })
    const clipboard = createPasteClipboard('/fixture', { reservation: { claim: async () => ({ release: async () => {} }), release: async () => {} } })
    expect(await clipboard.prepare(request(1))).toEqual({ state: 'written' })
    expect(startClipboardOwner).toHaveBeenLastCalledWith(file)
    await clipboard.release(request(1).generation); await clipboard.stop()
  })

})
