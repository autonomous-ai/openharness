import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PastePort } from '../core/api.js'
import { runPasteService } from './pasteProcess.js'
import { runServiceProcess, type ServiceProcessOptions } from './process.js'
import { createPasteFiles } from './paste.js'

vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))
vi.mock('./paste.js', () => ({ createPasteFiles: vi.fn(() => ({ begin: vi.fn(), chunk: vi.fn(), clipboard: vi.fn(), releaseClipboard: vi.fn(), cancel: vi.fn(), stop: vi.fn() })) }))

const request = { generation: '00000000-0000-0000-0000-000000000001', streamId: '00000000-0000-0000-0000-000000000002', connection: 'client', filename: 'x', totalBytes: 2 }
function fixture() {
  let options!: ServiceProcessOptions
  const files: PastePort = { begin: vi.fn(async () => ({ accepted: true as const })),
    chunk: vi.fn(async () => ({ bytesWritten: 2, totalBytes: 2 })),
    clipboard: vi.fn(async () => ({ state: 'written' as const })), releaseClipboard: vi.fn(), cancel: vi.fn(), stop: vi.fn() }
  const stop = vi.fn()
  const process = runPasteService({ dataDir: '/fixture', socketPath: '/unused', machineId: 'fixture', token: 'fixture', files,
    run: (configured) => { options = configured; return { stop } } })
  const ask = (type: string, payload: Record<string, unknown>) => options.requests[type](payload, { local: true, owner: true }, new AbortController().signal)
  return { files, stop, process, ask, event: (payload: Record<string, unknown>) => options.onEvent!({ deadline: Date.now() + 30_000, ...payload }),
    binary: (bytes: Uint8Array) => options.onBinary!(bytes), disconnect: () => options.onDisconnected!() }
}
afterEach(() => vi.useRealTimers())
describe('paste process protocol', () => {
  it('forwards image metadata and its one owned clipboard operation over the existing service link', async () => {
    const f = fixture()
    f.event({ kind: 'begin', uploadKind: 'image', ...request })
    expect(await f.ask('begin', { generation: request.generation })).toEqual({ accepted: true })
    expect(f.files.begin).toHaveBeenCalledWith({ ...request, kind: 'image' })
    const selected = { generation: request.generation, streamId: request.streamId, connection: request.connection,
      artifact: { name: 'image.png', version: 'fixture' }, corePid: 123, deadline: Date.now() + 30_000 }
    expect(await f.ask('clipboard', selected)).toEqual({ state: 'written' })
    const { deadline: _deadline, ...owned } = selected
    expect(f.files.clipboard).toHaveBeenCalledWith(owned)
    f.event({ kind: 'clipboard_release', generation: request.generation, corePid: 123 })
    expect(f.files.releaseClipboard).toHaveBeenCalledWith(request.generation, 123)
    f.event({ kind: 'clipboard_release', generation: 123, corePid: 123 })
    f.event({ kind: 'clipboard_release', generation: request.generation, corePid: 0 })
    expect(f.files.releaseClipboard).toHaveBeenCalledOnce()
    await f.process.stop()
  })

  it('refuses malformed clipboard requests before the component can open a file or start a native helper', async () => {
    const f = fixture(), selected = { generation: request.generation, streamId: request.streamId, connection: request.connection,
      artifact: { name: 'image.png', version: 'fixture' }, corePid: 123, deadline: Date.now() + 30_000 }
    for (const change of [{ generation: 1 }, { generation: 'short' }, { streamId: 1 }, { streamId: 'short' },
      { connection: 1 }, { connection: 'x'.repeat(513) }, { corePid: '123' }, { corePid: 0 }, { corePid: 0x80000000 },
      { artifact: undefined }, { artifact: { name: 1 } }, { artifact: { name: 'x'.repeat(201), version: 'v' } },
      { artifact: { name: 'x', version: 1 } }, { artifact: { name: 'x', version: 'v'.repeat(201) } },
      { deadline: 'future' }, { deadline: Date.now() - 1 }]) {
      expect(await f.ask('clipboard', { ...selected, ...change })).toEqual({ state: 'unavailable', reason: 'PASTE_UPLOAD_UNAVAILABLE' })
    }
    expect(f.files.clipboard).not.toHaveBeenCalled(); await f.process.stop()
  })

  it('returns the owned file cleanup promise when the process is stopped', async () => {
    const f = fixture()
    let finish!: () => void
    const cleanup = new Promise<void>((resolve) => { finish = resolve })
    vi.mocked(f.files.stop).mockImplementation(() => cleanup)
    const stopped = f.process.stop()
    expect(stopped).toBeInstanceOf(Promise)
    finish()
    await stopped
    expect(f.stop).toHaveBeenCalledOnce()
  })

  it('refuses a begin whose sender deadline elapsed before dispatch', async () => {
    const f = fixture()
    f.event({ kind: 'begin', ...request, deadline: Date.now() - 1 })
    expect(f.files.begin).not.toHaveBeenCalled()
    expect(await f.ask('begin', { generation: request.generation })).toEqual({ error: 'PASTE_UPLOAD_TIMEOUT' })
    f.process.stop()
  })

  it('refuses an expired chunk header before accepting its body', async () => {
    const f = fixture()
    f.event({ kind: 'chunk', ...request, seq: 0, operation: 'expired', length: 2, deadline: Date.now() - 1 })
    f.binary(new Uint8Array(2))
    expect(f.files.chunk).not.toHaveBeenCalled()
    expect(await f.ask('chunk', { operation: 'expired' })).toEqual({ error: 'PASTE_UPLOAD_TIMEOUT' })
    f.process.stop()
  })

  it('expires an unpaired header without accepting a body arriving after its deadline', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.event({ kind: 'chunk', ...request, seq: 0, operation: 'late-body', length: 2, deadline: Date.now() + 500 })
    await vi.advanceTimersByTimeAsync(500)
    f.binary(new Uint8Array(2))
    expect(f.files.chunk).not.toHaveBeenCalled()
    expect(await f.ask('chunk', { operation: 'late-body' })).toEqual({ error: 'PASTE_UPLOAD_TIMEOUT' })
    f.process.stop()
  })

  it('checks the sender deadline on a body even before a delayed timer callback has run', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.event({ kind: 'chunk', ...request, seq: 0, operation: 'clock-advanced', length: 2, deadline: Date.now() + 500 })
    vi.setSystemTime(Date.now() + 501)
    f.binary(new Uint8Array(2))
    expect(f.files.chunk).not.toHaveBeenCalled()
    expect(await f.ask('chunk', { operation: 'clock-advanced' })).toEqual({ error: 'PASTE_UPLOAD_TIMEOUT' })
    f.process.stop()
  })

  it('forgets an unpaired header when that generation is cancelled', () => {
    const f = fixture()
    f.event({ kind: 'chunk', ...request, seq: 0, operation: 'cancelled', length: 2 })
    f.event({ kind: 'cancel', generation: request.generation })
    f.binary(new Uint8Array(2))
    expect(f.files.chunk).not.toHaveBeenCalled()
    f.process.stop()
  })
  it('uses the production component and process factories when none are injected', () => {
    const service = runPasteService({ dataDir: 'fixture', socketPath: 'unused', machineId: 'fixture', token: 'fixture' })
    expect(createPasteFiles).toHaveBeenCalledWith('fixture')
    expect(runServiceProcess).toHaveBeenCalledWith(expect.objectContaining({ name: 'paste' }))
    service.stop()
  })
  it('registers begin synchronously and pairs the exact next payload view with its header', async () => {
    const f = fixture()
    f.event({ kind: 'begin', ...request })
    expect(f.files.begin).toHaveBeenCalledWith(request)
    expect(await f.ask('begin', { generation: request.generation })).toEqual({ accepted: true })
    const view = new Uint8Array(8).subarray(3, 5)
    f.event({ kind: 'chunk', ...request, seq: 0, operation: 'op', length: 2 })
    f.binary(view)
    expect(vi.mocked(f.files.chunk).mock.calls[0][1]).toBe(view)
    expect(await f.ask('chunk', { operation: 'op' })).toEqual({ bytesWritten: 2, totalBytes: 2 })
    expect(await f.ask('chunk', { operation: 'op' })).toEqual({ error: 'PASTE_UNAVAILABLE' })
    f.process.stop()
  })
  it('fails an unpaired predecessor and never assigns its bytes to a later operation', async () => {
    const f = fixture()
    f.event({ kind: 'chunk', ...request, seq: 0, operation: 'lost', length: 2 })
    f.event({ kind: 'chunk', ...request, seq: 1, operation: 'next', length: 2 })
    f.binary(new Uint8Array(2))
    expect(await f.ask('chunk', { operation: 'lost' })).toHaveProperty('error')
    expect(await f.ask('chunk', { operation: 'next' })).toHaveProperty('bytesWritten', 2)
    expect(f.files.chunk).toHaveBeenCalledTimes(1)
    expect(f.files.cancel).toHaveBeenCalledWith(request.generation)
    f.process.stop()
  })
  it('refuses body length mismatch, orphan bodies and malformed metadata', async () => {
    const f = fixture()
    f.binary(new Uint8Array(2))
    f.event({ kind: 'begin' })
    f.event({ kind: 'chunk' })
    f.event({ kind: 'chunk', ...request, seq: 0, operation: 'bad', length: 2 })
    f.binary(new Uint8Array(1))
    expect(await f.ask('chunk', { operation: 'bad' })).toEqual({ error: 'PASTE_INVALID_CHUNK' })
    expect(f.files.chunk).not.toHaveBeenCalled()
    f.process.stop()
  })
  it('bounds unclaimed results and cancels them on expiry, disconnect and stop', async () => {
    vi.useFakeTimers()
    const f = fixture()
    for (let index = 0; index < 161; index++) f.event({ kind: 'begin', ...request, generation: `generation-${index}` })
    expect(f.files.begin).toHaveBeenCalledTimes(160)
    expect(f.files.cancel).toHaveBeenCalledWith('generation-160')
    f.event({ kind: 'begin', ...request, generation: 'generation-0' })
    expect(f.files.begin).toHaveBeenCalledTimes(160)
    f.event({ kind: 'chunk', ...request, seq: 0, operation: 'overflow-1', length: 2 })
    f.event({ kind: 'chunk', ...request, seq: 0, operation: 'overflow-2', length: 2 })
    f.binary(new Uint8Array(2))
    expect(f.files.chunk).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await f.ask('begin', { generation: 'generation-0' })).toHaveProperty('error')
    f.event({ kind: 'cancel', generation: request.generation })
    f.event({ kind: 'cancel' })
    f.event({ kind: 'begin', ...request })
    f.disconnect()
    f.event({ kind: 'stop' })
    f.process.stop()
    expect(f.files.cancel).toHaveBeenCalledWith(null)
    expect(f.files.stop).toHaveBeenCalledOnce()
    expect(f.stop).toHaveBeenCalledOnce()
  })
})
