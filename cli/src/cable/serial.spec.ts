import { EventEmitter } from 'node:events'
import { constants } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), configure: vi.fn(), stream: vi.fn() }))
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), openSync: io.open, closeSync: io.close }))
vi.mock('node:tty', () => ({ ReadStream: io.stream }))
vi.mock('node:child_process', () => ({ execFile: io.configure }))

import { SerialLink } from './serial.js'

function port(nativeFd = 43) {
  const stream = Object.assign(new EventEmitter(), {
    _handle: { fd: nativeFd },
    destroyed: false,
    write: vi.fn((_bytes: Uint8Array, done: (error?: Error) => void) => { queueMicrotask(() => done()); return true }),
    destroy: vi.fn(() => { queueMicrotask(() => stream.emit('close')); return stream }),
  })
  io.stream.mockImplementation(function () { return stream })
  return stream
}
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

describe('event-driven serial link', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    io.open.mockReturnValue(42)
    io.configure.mockImplementation((_cmd, _args, callback) => callback(null, '', ''))
  })
  afterEach(() => { vi.useRealTimers(); vi.resetAllMocks() })

  it('stays idle without a timer, preserves raw bytes, and closes the duplicate descriptor', async () => {
    const stream = port(), received = vi.fn(), closed = vi.fn()
    const link = await SerialLink.open('/dev/fake', received, closed)
    expect(io.open).toHaveBeenCalledWith('/dev/fake', constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK)
    expect(io.close).toHaveBeenCalledExactlyOnceWith(42)
    expect(io.stream).toHaveBeenCalledWith(42, { readable: true, writable: true })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(received).not.toHaveBeenCalled()
    expect(stream.write).not.toHaveBeenCalled()
    const bytes = Buffer.from([0, 3, 13, 10, 127, 128, 255])
    stream.emit('data', bytes)
    expect(received).toHaveBeenCalledExactlyOnceWith(bytes)
    await link.close()
    expect(closed).toHaveBeenCalledExactlyOnceWith('closed')
    expect(stream.destroy).toHaveBeenCalledTimes(1)
  })

  it('does not close a descriptor adopted directly by the native stream', async () => {
    const stream = port(42)
    const link = await SerialLink.open('/dev/fake', vi.fn(), vi.fn())
    expect(io.close).not.toHaveBeenCalled()
    await link.close()
    expect(io.close).not.toHaveBeenCalled()
    expect(stream.destroy).toHaveBeenCalledTimes(1)
  })

  it('closes the descriptor if native stream construction fails', async () => {
    io.stream.mockImplementation(function () { throw new Error('TTY unavailable') })
    await expect(SerialLink.open('/dev/fake', vi.fn(), vi.fn())).rejects.toThrow('TTY unavailable')
    expect(io.close).toHaveBeenCalledExactlyOnceWith(42)
  })

  it('releases the native stream if closing the original descriptor fails', async () => {
    const stream = port()
    io.close.mockImplementation(() => { throw new Error('close failed') })
    await expect(SerialLink.open('/dev/fake', vi.fn(), vi.fn())).rejects.toThrow('close failed')
    expect(io.close).toHaveBeenCalledTimes(1)
    expect(stream.destroy).toHaveBeenCalledTimes(1)
  })

  it('does not open a port that could not be configured raw', async () => {
    io.configure.mockImplementation((_cmd, _args, callback) => callback(new Error('stty failed')))
    await expect(SerialLink.open('/dev/fake', vi.fn(), vi.fn())).rejects.toThrow('stty failed')
    expect(io.open).not.toHaveBeenCalled()
    expect(io.stream).not.toHaveBeenCalled()
  })

  it('preserves frame order and waits for the backpressured frame to finish', async () => {
    const stream = port(), completions: Array<(error?: Error) => void> = []
    stream.write.mockImplementation((_bytes, done) => { completions.push(done); return false })
    const link = await SerialLink.open('/dev/fake', vi.fn(), vi.fn())
    const first = Buffer.from([1, 2, 3]), second = Buffer.from([4, 5])
    const writes = Promise.all([link.write(first), link.write(second)])
    await tick()
    expect(stream.write.mock.calls.map(([bytes]) => bytes)).toEqual([first])
    completions.shift()!()
    await tick()
    expect(stream.write.mock.calls.map(([bytes]) => bytes)).toEqual([first, second])
    completions.shift()!()
    await writes
    await link.close()
  })

  it('rejects interrupted and queued frames on close without issuing another write', async () => {
    const stream = port()
    let writing!: (error?: Error) => void
    stream.write.mockImplementation((_bytes, done) => { writing = done; return false })
    stream.destroy.mockImplementation(() => {
      queueMicrotask(() => { writing(new Error('port closed')); stream.emit('close') })
      return stream
    })
    const closed = vi.fn(), link = await SerialLink.open('/dev/fake', vi.fn(), closed)
    const writes = Promise.allSettled([link.write(Buffer.from('first')), link.write(Buffer.from('second'))])
    await tick()
    const closing = link.close('user closed')
    expect(link.isOpen).toBe(false)
    expect(link.close('duplicate')).toBe(closing)
    await closing
    expect((await writes).map(result => result.status)).toEqual(['rejected', 'rejected'])
    expect(stream.write).toHaveBeenCalledTimes(1)
    expect(stream.destroy).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledExactlyOnceWith('user closed')
    await expect(link.write(Buffer.from('late'))).rejects.toThrow('port closed')
  })

  it.each(['end', 'close'])('handles unexpected %s once and ignores late data', async event => {
    const stream = port(), closed = vi.fn(), received = vi.fn()
    const link = await SerialLink.open('/dev/fake', received, closed)
    stream.emit(event)
    stream.emit('data', Buffer.from('late'))
    await link.close('duplicate')
    expect(closed).toHaveBeenCalledExactlyOnceWith('end of stream')
    expect(received).not.toHaveBeenCalled()
    expect(stream.destroy).toHaveBeenCalledTimes(event === 'end' ? 1 : 0)
  })

  it.each(['requested', 'native'])('rejects a cancelled write with no callback error after %s close', async mode => {
    const stream = port()
    let complete!: (error?: Error) => void
    stream.write.mockImplementation((_bytes, done) => { complete = done; return false })
    const link = await SerialLink.open('/dev/fake', vi.fn(), vi.fn())
    const writing = expect(link.write(Buffer.from('interrupted'))).rejects.toThrow('port closed')
    await tick()
    if (mode === 'requested') await link.close('user closed')
    else stream.destroyed = true // Native destruction can precede the error/close events.
    complete()
    await writing
    await link.close()
  })

  it.each(['EIO', undefined])('preserves disconnect error %s and does not deliver data after close', async code => {
    const stream = port(), closed = vi.fn(), received = vi.fn()
    const link = await SerialLink.open('/dev/fake', received, closed)
    stream.emit('error', Object.assign(new Error('unplugged'), { code }))
    stream.emit('data', Buffer.from('late'))
    await link.close()
    expect(closed).toHaveBeenCalledExactlyOnceWith(code ?? 'Error: unplugged')
    expect(received).not.toHaveBeenCalled()
  })

  it('closes when a data consumer throws, preserving the original behavior', async () => {
    const stream = port(), closed = vi.fn()
    const link = await SerialLink.open('/dev/fake', () => { throw new Error('bad frame') }, closed)
    stream.emit('data', Buffer.from('broken'))
    await link.close()
    expect(closed).toHaveBeenCalledExactlyOnceWith('Error: bad frame')
  })

  it('propagates a write failure without stranding the next queued frame', async () => {
    const stream = port()
    stream.write.mockImplementationOnce((_bytes, done) => { queueMicrotask(() => done(new Error('write failed'))); return false })
    const link = await SerialLink.open('/dev/fake', vi.fn(), vi.fn())
    const writes = await Promise.allSettled([link.write(Buffer.from('first')), link.write(Buffer.from('second'))])
    expect(writes[0]).toMatchObject({ status: 'rejected', reason: new Error('write failed') })
    expect(writes[1].status).toBe('fulfilled')
    await link.close()
  })
})
