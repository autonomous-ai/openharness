import { describe, expect, it, vi } from 'vitest'
import { createPasteLink, PASTE_LINK_BYTES } from './pasteLink.js'
import type { ServiceFrame } from './serviceLinks.js'

const request = { generation: '00000000-0000-0000-0000-000000000001', streamId: '00000000-0000-0000-0000-000000000002', connection: 'client' }
function fixture() {
  const order: string[] = []
  const link = { notify: vi.fn((_service: string, frame: ServiceFrame) => { order.push(String(frame.payload?.kind)); return true }),
    notifyBinary: vi.fn((_service: string, _bytes: Uint8Array) => { order.push('body'); return true }),
    call: vi.fn(async () => { order.push('rpc'); return { bytesWritten: 2, totalBytes: 2 } as Record<string, unknown> }),
    buffered: vi.fn(() => 0) }
  return { link, order, port: createPasteLink(link) }
}
describe('paste service link', () => {
  it('binds clipboard preparation and token release to this core, and validates only bounded result codes', async () => {
    const { port, link } = fixture(), selected = { ...request, artifact: { name: 'image.png', version: 'fixture' } }
    link.call.mockResolvedValueOnce({ state: 'written' })
    expect(await port.clipboard({ ...selected, corePid: 123 })).toEqual({ state: 'written' })
    expect(link.call).toHaveBeenCalledWith('paste', 'clipboard', expect.objectContaining({ ...selected, corePid: process.pid }), 30_000)
    for (const [reply, expected] of [
      [{ state: 'failed', reason: 'PASTE_CANCELLED' }, { state: 'failed', reason: 'PASTE_CANCELLED' }],
      [{ state: 'unavailable', reason: 'PASTE_CLIPBOARD_HELD' }, { state: 'unavailable', reason: 'PASTE_CLIPBOARD_HELD' }],
      [{ state: 'failed', reason: 'private native stderr' }, { state: 'failed', reason: 'PASTE_UNAVAILABLE' }],
      [{}, { state: 'unavailable', reason: 'PASTE_UNAVAILABLE' }],
    ]) {
      link.call.mockResolvedValueOnce(reply)
      expect(await port.clipboard(selected)).toEqual(expected)
    }
    port.releaseClipboard(request.generation, 123)
    expect(link.notify.mock.calls.at(-1)?.[1].payload).toEqual({ kind: 'clipboard_release', generation: request.generation, corePid: process.pid })
  })

  it('does not enqueue a clipboard RPC beyond the existing paste transport bounds', async () => {
    const { port, link } = fixture(), selected = { ...request, artifact: { name: 'image.png', version: 'fixture' } }
    link.buffered.mockReturnValueOnce(PASTE_LINK_BYTES)
    expect(await port.clipboard(selected)).toEqual({ state: 'unavailable', reason: 'PASTE_UNAVAILABLE' })
    expect(await port.clipboard({ ...selected, artifact: { name: 'x'.repeat(2048), version: 'v' } }))
      .toEqual({ state: 'unavailable', reason: 'PASTE_UNAVAILABLE' })
    expect(link.call).not.toHaveBeenCalled()
  })

  it('sends header, original payload view and RPC synchronously without changing other links', async () => {
    const { link, order, port } = fixture()
    const whole = new Uint8Array(8), view = whole.subarray(2, 4)
    const pending = port.chunk({ ...request, seq: 0 }, view)
    expect(order).toEqual(['chunk', 'body', 'rpc'])
    expect(link.notifyBinary).toHaveBeenCalledWith('paste', view)
    expect(link.notifyBinary.mock.calls[0][1]).toBe(view)
    expect(await pending).toEqual({ bytesWritten: 2, totalBytes: 2 })
  })
  it('allows all 32 reserved windows but refuses a send beyond the paste-only ceiling', async () => {
    const { link, port } = fixture()
    link.buffered.mockReturnValue(32 * 1024 * 1024 + 256 * 1024)
    await port.chunk({ ...request, seq: 0 }, new Uint8Array(256 * 1024))
    expect(link.notifyBinary).toHaveBeenCalledTimes(1)
    link.buffered.mockReturnValue(PASTE_LINK_BYTES)
    expect(await port.chunk({ ...request, seq: 1 }, new Uint8Array(2))).toEqual({ error: 'PASTE_UNAVAILABLE' })
    expect(link.notifyBinary).toHaveBeenCalledTimes(1)
  })
  it('does not send an unpaired body after a refused header and cancels a refused body', async () => {
    const { link, port } = fixture()
    link.notify.mockReturnValueOnce(false)
    expect(await port.chunk({ ...request, seq: 0 }, new Uint8Array(2))).toHaveProperty('error')
    expect(link.notifyBinary).not.toHaveBeenCalled()
    link.notifyBinary.mockReturnValueOnce(false)
    expect(await port.chunk({ ...request, seq: 0 }, new Uint8Array(2))).toHaveProperty('error')
    expect(link.notify.mock.calls.at(-1)?.[1].payload).toEqual({ kind: 'cancel', generation: request.generation })
  })
  it('bounds worker replies and refuses content-bearing error text', async () => {
    const { link, port } = fixture()
    for (const answer of [{}, { bytesWritten: 3, totalBytes: 2 }, { bytesWritten: 1, totalBytes: 1, artifact: { name: 4 } }]) {
      link.call.mockResolvedValueOnce(answer)
      expect(await port.chunk({ ...request, seq: 0 }, new Uint8Array(2))).toEqual({ error: 'PASTE_INVALID_RESULT' })
    }
    link.call.mockResolvedValueOnce({ error: 'secret path and content' })
    expect(await port.chunk({ ...request, seq: 0 }, new Uint8Array(2))).toEqual({ error: 'PASTE_UNAVAILABLE' })
    link.call.mockResolvedValueOnce({ ignored: true })
    expect(await port.chunk({ ...request, seq: 0 }, new Uint8Array(2))).toEqual({ ignored: true })
  })
  it('registers begin before its RPC, handles refusal, and sends cancellation without replay', async () => {
    const { link, port, order } = fixture()
    link.call.mockImplementationOnce(async () => { order.push('rpc'); return { accepted: true } })
    expect(await port.begin({ ...request, filename: 'x', totalBytes: 1 })).toEqual({ accepted: true })
    expect(order).toEqual(['begin', 'rpc'])
    link.call.mockResolvedValueOnce({ error: 'PASTE_CAPACITY' })
    expect(await port.begin({ ...request, filename: 'x', totalBytes: 1 })).toEqual({ error: 'PASTE_CAPACITY' })
    port.cancel(request.generation); port.stop()
    expect(link.notify.mock.calls.at(-1)?.[1].payload).toEqual({ kind: 'stop' })
    expect(await port.begin({ ...request, filename: 'x'.repeat(2048), totalBytes: 1 })).toHaveProperty('error')
  })
  it('rejects each malformed reply bound and preserves a valid prepared result', async () => {
    const { port, link } = fixture()
    for (const answer of [{ error: 'PASTE_CAPACITY' }, { bytesWritten: 1, totalBytes: NaN }, { bytesWritten: -1, totalBytes: 1 },
      { bytesWritten: 0, totalBytes: 0 }, { bytesWritten: 1, totalBytes: 2, artifact: { name: 'x', version: 'v' } },
      { bytesWritten: 1, totalBytes: 21 * 1024 * 1024 }, { bytesWritten: 1, totalBytes: 1, artifact: { name: 'x'.repeat(201), version: 'v' } },
      { bytesWritten: 1, totalBytes: 1, artifact: { name: 'x', version: 4 } },
      { bytesWritten: 1, totalBytes: 1, artifact: { name: 'x', version: 'v'.repeat(201) } }]) {
      link.call.mockResolvedValueOnce(answer)
      expect(await port.chunk({ ...request, seq: 0 }, new Uint8Array(2))).toHaveProperty('error')
    }
    const valid = { bytesWritten: 1, totalBytes: 1, artifact: { name: 'x', version: 'v' } }
    link.call.mockResolvedValueOnce(valid)
    expect(await port.chunk({ ...request, seq: 0 }, new Uint8Array(2))).toEqual(valid)
    expect(await port.chunk({ ...request, seq: 0 }, new Uint8Array(256 * 1024 + 1))).toHaveProperty('error')
    expect(await port.chunk({ ...request, connection: 'x'.repeat(2048), seq: 0 }, new Uint8Array(2))).toHaveProperty('error')
  })
  it('refuses busy or missing begin transport and maps an invalid reply to unavailable', async () => {
    const { port, link } = fixture()
    link.buffered.mockReturnValueOnce(PASTE_LINK_BYTES)
    expect(await port.begin({ ...request, filename: 'x', totalBytes: 1 })).toHaveProperty('error')
    link.notify.mockReturnValueOnce(false)
    expect(await port.begin({ ...request, filename: 'x', totalBytes: 1 })).toHaveProperty('error')
    for (const answer of [{}, { error: 'content is not an error code' }]) {
      link.call.mockResolvedValueOnce(answer)
      expect(await port.begin({ ...request, filename: 'x', totalBytes: 1 })).toEqual({ error: 'PASTE_UNAVAILABLE' })
    }
  })
})
