import { execFileSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, rmSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const tty = vi.hoisted(() => ({ ReadStream: vi.fn() }))
vi.mock('node:tty', () => tty)

import { nodePipes, portStream, type PipeWrap } from './portStream.js'

describe('a stream over a dial\'s port', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  /** A descriptor libuv can watch as it watches a port: a FIFO, opened both ways, never blocking. */
  const fifo = (): number => {
    const dir = mkdtempSync(join(tmpdir(), 'port-stream-'))
    dirs.push(dir)
    execFileSync('mkfifo', [join(dir, 'port')])
    return openSync(join(dir, 'port'), constants.O_RDWR | constants.O_NONBLOCK)
  }

  it('reads and writes the descriptor it is given, through Node\'s pipe handle, and owns it', async () => {
    const fd = fifo()
    const stream = portStream(fd)
    expect((stream as unknown as { _handle: { fd: number } })._handle.fd).toBe(fd)
    const heard = new Promise<string>((resolve) => stream.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8'))))
    stream.write('hello')
    expect(await heard).toBe('hello')
    await new Promise<void>((resolve) => { stream.once('close', () => resolve()); stream.destroy() })
    // Closed with the stream: the descriptor is no longer this process's.
    expect(() => closeSync(fd)).toThrow()
    expect(tty.ReadStream).not.toHaveBeenCalled()
  })

  it('says why a descriptor it cannot use is refused, and lets go of the handle', () => {
    const close = vi.fn()
    const pipes: PipeWrap = { Pipe: class { open() { return -9 } close() { close() } } as unknown as PipeWrap['Pipe'], constants: { SOCKET: 0 } }
    expect(() => portStream(7, pipes)).toThrow(expect.objectContaining({ code: 'EBADF', message: 'the port cannot be read: EBADF' }))
    expect(close).toHaveBeenCalledOnce()
  })

  it('is a terminal stream, as before, on a Node without the pipe handle', () => {
    const terminal = { terminal: true }
    tty.ReadStream.mockImplementationOnce(function () { return terminal })
    expect(portStream(7, null)).toBe(terminal)
    expect(tty.ReadStream).toHaveBeenCalledWith(7, { readable: true, writable: true })
  })

  it('finds Node\'s pipe handle, and none where it is missing, half there or refused', () => {
    expect(nodePipes()).toMatchObject({ Pipe: expect.any(Function), constants: { SOCKET: expect.any(Number) } })
    expect(nodePipes(() => undefined)).toBeNull()
    expect(nodePipes(() => ({ Pipe: class {} }))).toBeNull()
    expect(nodePipes(() => { throw new Error('No such module: pipe_wrap') })).toBeNull()
  })
})
