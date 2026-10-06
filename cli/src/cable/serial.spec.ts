import { EventEmitter } from 'node:events'
import { constants } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), configure: vi.fn(), stream: vi.fn(), readdir: vi.fn(), lstat: vi.fn(), read: vi.fn() }))
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), openSync: io.open, closeSync: io.close, readdirSync: io.readdir, lstatSync: io.lstat, readSync: io.read }))
vi.mock('node:tty', () => ({ ReadStream: io.stream }))
vi.mock('node:child_process', () => ({ execFile: io.configure }))

import { SerialLink, findDialPorts } from './serial.js'

function port(nativeFd = 43) {
  const stream = Object.assign(new EventEmitter(), {
    _handle: { fd: nativeFd },
    destroyed: false,
    write: vi.fn((_bytes: Uint8Array, done: (error?: Error) => void) => { queueMicrotask(() => done()); return true }),
    destroy: vi.fn(() => { queueMicrotask(() => stream.emit('close')); return stream }),
    unshift: vi.fn(),
  })
  io.stream.mockImplementation(function () { return stream })
  return stream
}
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const claimsPort = process.platform === 'darwin'

describe('event-driven serial link', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    io.open.mockReturnValue(42)
    if (claimsPort) io.open.mockReturnValueOnce(41)
    io.configure.mockImplementation((_cmd, _args, callback) => callback(null, '', ''))
    // The far end is there and has said nothing yet.
    io.read.mockImplementation(() => { throw Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' }) })
  })
  afterEach(() => { vi.useRealTimers(); vi.resetAllMocks() })

  it('refuses a port whose far end is gone before the stream reopens it, which would wait for it forever', async () => {
    port()
    io.read.mockReturnValueOnce(0)
    await expect(SerialLink.open('/dev/fake', vi.fn(), vi.fn())).rejects.toMatchObject({ code: 'EOF' })
    expect(io.stream).not.toHaveBeenCalled()
    expect(io.close).toHaveBeenCalledWith(42)
    io.open.mockReturnValue(42)
    if (claimsPort) io.open.mockReturnValueOnce(41)
    io.read.mockImplementationOnce(() => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) })
    await expect(SerialLink.open('/dev/fake', vi.fn(), vi.fn())).rejects.toMatchObject({ code: 'EIO' })
    expect(io.stream).not.toHaveBeenCalled()
  })

  it('hands the stream what the dial said before the port opened, ahead of the rest', async () => {
    const stream = port()
    io.read.mockImplementationOnce((_fd: number, buffer: Buffer) => buffer.write('hello', 0))
    await SerialLink.open('/dev/fake', vi.fn(), vi.fn())
    expect(stream.unshift).toHaveBeenCalledWith(Buffer.from('hello'))
  })

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
    if (claimsPort) expect(io.close).toHaveBeenCalledExactlyOnceWith(41)
    else expect(io.close).not.toHaveBeenCalled()
    expect(stream.destroy).toHaveBeenCalledTimes(1)
  })

  it('closes the descriptor if native stream construction fails', async () => {
    io.stream.mockImplementation(function () { throw new Error('TTY unavailable') })
    await expect(SerialLink.open('/dev/fake', vi.fn(), vi.fn())).rejects.toThrow('TTY unavailable')
    expect(io.close.mock.calls).toEqual(claimsPort ? [[42], [41]] : [[42]])
  })

  it('releases the native stream if closing the original descriptor fails', async () => {
    const stream = port()
    io.close.mockImplementation(() => { throw new Error('close failed') })
    await expect(SerialLink.open('/dev/fake', vi.fn(), vi.fn())).rejects.toThrow('close failed')
    expect(io.close).toHaveBeenCalledTimes(claimsPort ? 2 : 1)
    expect(stream.destroy).toHaveBeenCalledTimes(1)
  })

  it('does not open a port that could not be configured raw', async () => {
    io.configure.mockImplementation((_cmd, _args, callback) => callback(new Error('stty failed')))
    await expect(SerialLink.open('/dev/fake', vi.fn(), vi.fn())).rejects.toThrow('stty failed')
    if (claimsPort) {
      expect(io.open).toHaveBeenCalledTimes(1)
      expect(io.close).toHaveBeenCalledExactlyOnceWith(41)
    } else expect(io.open).not.toHaveBeenCalled()
    expect(io.stream).not.toHaveBeenCalled()
  })

  it.skipIf(!claimsPort)('refuses a competing claim before stty can touch the port', async () => {
    io.open.mockReset().mockImplementation(() => { throw Object.assign(new Error('busy'), { code: 'EAGAIN' }) })
    await expect(SerialLink.open('/dev/fake', vi.fn(), vi.fn())).rejects.toMatchObject({ code: 'EAGAIN' })
    expect(io.configure).not.toHaveBeenCalled()
    expect(io.stream).not.toHaveBeenCalled()
    expect(io.close).not.toHaveBeenCalled()
  })

  it.skipIf(!claimsPort)('holds the kernel claim until the native stream has actually closed', async () => {
    const stream = port()
    stream.destroy.mockImplementation(() => stream)
    const link = await SerialLink.open('/dev/fake', vi.fn(), vi.fn())
    expect(io.open.mock.calls[0]).toEqual(['/dev/fake', constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK | 0x20])
    const closing = link.close()
    await tick()
    expect(io.close.mock.calls).toEqual([[42]])
    stream.emit('close')
    await closing
    expect(io.close.mock.calls).toEqual([[42], [41]])
    await link.close()
    expect(io.close.mock.calls).toEqual([[42], [41]])
  })

  it.skipIf(!claimsPort)('releases the claim if opening the stream descriptor fails', async () => {
    io.open.mockReset().mockReturnValueOnce(41).mockImplementationOnce(() => { throw new Error('port disappeared') })
    await expect(SerialLink.open('/dev/fake', vi.fn(), vi.fn())).rejects.toThrow('port disappeared')
    expect(io.close).toHaveBeenCalledExactlyOnceWith(41)
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

describe('macOS dial discovery wiring', () => {
  const dump = `+-o Tim <class IOUSBHostDevice>
  "idVendor" = 12346
  "idProduct" = 4097
  +-o serial
    "IOCalloutDevice" = "/dev/cu.usbmodem1101"`
  afterEach(() => vi.resetAllMocks())

  it.skipIf(process.platform !== 'darwin')('stats only cu.* entries, gates ioreg on them and keeps the error text', async () => {
    io.readdir.mockReturnValue(['cu.usbmodem1101', 'tty.usbmodem1101', 'null'])
    io.lstat.mockReturnValue({ ino: 900, rdev: 7 })
    io.configure.mockImplementation((_c, _a, _o, cb) => cb(null, { stdout: dump, stderr: '' }))
    await findDialPorts()
    await findDialPorts()
    expect(io.configure).toHaveBeenCalledTimes(1)
    expect(io.configure.mock.calls[0].slice(0, 2)).toEqual(['ioreg', ['-r', '-c', 'IOUSBHostDevice', '-w0', '-l']])
    expect(io.lstat.mock.calls.every(([path]) => path === '/dev/cu.usbmodem1101')).toBe(true)
    expect(io.lstat).toHaveBeenCalled()

    io.lstat.mockReturnValue({ ino: 901, rdev: 7 })
    io.configure.mockImplementation((_c, _a, _o, cb) => cb(new Error('boom')))
    await expect(findDialPorts()).rejects.toThrow('Could not enumerate USB dials')
    io.configure.mockImplementation((_c, _a, _o, cb) => cb(null, { stdout: dump, stderr: '' }))
    await expect(findDialPorts()).resolves.toHaveLength(1)
    expect(io.configure).toHaveBeenCalledTimes(3)
  })
})
