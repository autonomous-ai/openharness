import { describe, expect, it, vi } from 'vitest'
import { sessionStorageFrames } from './sessionStorageFrames.js'
import { SESSION_STORAGE_FRAME_BYTES, SESSION_STORAGE_PAGE_CHARS } from './sessionStorageWire.js'

const frame = (kind: string, sequence = 0, extra: Record<string, unknown> = {}) => ({
  protocol: 'session-storage-1', incarnation: 'fixture', id: 1, kind, sequence, ...extra,
})
const fixture = () => {
  const write = vi.fn(async (_frame: unknown) => {}), receive = vi.fn(), failed = vi.fn()
  return { write, receive, failed, link: sessionStorageFrames('fixture', write, receive, failed) }
}

describe('credited session image frames', () => {
  it('keeps the send slot owned between credit delivery and the next page', async () => {
    const { link, write } = fixture()
    const first = link.send(1, { value: true }).catch(error => error)
    expect(write).toHaveBeenCalledTimes(1)
    link.message(frame('credit'))
    const second = link.send(2, {}).catch(error => error)
    try { expect(write.mock.calls.filter(([value]) => (value as { id: number }).id === 2)).toHaveLength(0) }
    finally { link.close() }
    expect(await second).toMatchObject({ code: 'disconnected' })
    expect(await first).toMatchObject({ code: 'disconnected' })
  })

  it('reconstructs a supported large image using one credited page at a time', async () => {
    const received = vi.fn(), failed = vi.fn(), sent: unknown[] = []
    let left!: ReturnType<typeof sessionStorageFrames>, right!: ReturnType<typeof sessionStorageFrames>
    left = sessionStorageFrames('fixture', async value => { sent.push(value); right.message(value) }, vi.fn(), failed)
    right = sessionStorageFrames('fixture', async value => left.message(value), received, failed)
    const value = { title: '🙂'.repeat(SESSION_STORAGE_PAGE_CHARS) }
    await left.send(1, value)
    expect(received).toHaveBeenCalledWith(1, value)
    expect(failed).not.toHaveBeenCalled()
    expect(sent.every(value => Buffer.byteLength(JSON.stringify(value)) <= SESSION_STORAGE_FRAME_BYTES)).toBe(true)
    expect(sent.filter(value => (value as { kind: string }).kind === 'page')).toHaveLength(3)
    await left.send(2, {})
    expect(received).toHaveBeenLastCalledWith(2, {})
    left.close(); right.close()
  })

  it.each([
    null, [], {}, frame('begin', 0, { incarnation: 'retired' }), frame('begin', 0, { id: 0 }),
    frame('begin', -1), frame('begin', 0, { extra: 'x'.repeat(SESSION_STORAGE_FRAME_BYTES) }),
    frame('credit'), frame('page', 1, { text: '{}' }), frame('begin', 1), frame('begin', 0, { text: '' }),
  ])('fails closed on an invalid first frame %#', value => {
    const { link, failed, receive } = fixture()
    link.message(value); link.message(frame('begin')); link.close()
    expect(failed).toHaveBeenCalledTimes(1)
    expect(receive).not.toHaveBeenCalled()
  })

  it.each([
    frame('begin'), frame('page', 1, { id: 2, text: '{}' }), frame('page', 2, { text: '{}' }),
    frame('page', 1), frame('page', 1, { text: 'x'.repeat(SESSION_STORAGE_PAGE_CHARS + 1) }),
    frame('end', 1, { text: '{}' }), frame('unknown', 1), frame('end', 1),
  ])('rejects duplicate, out-of-order and malformed image frames %#', value => {
    const { link, failed, receive } = fixture()
    link.message(frame('begin')); link.message(value)
    expect(failed).toHaveBeenCalledTimes(1)
    expect(receive).not.toHaveBeenCalled()
  })

  it('settles a pending send after transport write failure and refuses later sends', async () => {
    const { link, write, failed } = fixture()
    write.mockRejectedValue(new Error('fixture write failed'))
    await expect(link.send(1, {})).rejects.toThrow()
    await expect(link.send(2, {})).rejects.toMatchObject({ code: 'disconnected' })
    expect(failed).toHaveBeenCalledTimes(1)
  })

  it('observes a failed receive credit without an unhandled rejection', async () => {
    const { link, write, failed } = fixture()
    write.mockRejectedValue(new Error('fixture credit failed'))
    link.message(frame('begin'))
    await Promise.resolve(); await Promise.resolve()
    expect(failed).toHaveBeenCalledTimes(1)
  })
})
