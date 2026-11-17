import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { daemonPipe } from '../lib/windows/daemonPipe.js'
import { pipeWebSocket, type PipeTarget } from '../lib/windows/pipeClient.js'
import { serviceConnector } from './localConnection.js'

vi.mock('ws', () => ({ default: vi.fn(function (this: { url: string }, url: string) { this.url = url }) }))
vi.mock('../lib/windows/daemonPipe.js', () => ({ daemonPipe: vi.fn() }))
vi.mock('../lib/windows/pipeClient.js', () => ({ pipeWebSocket: vi.fn((target) => ({ target })) }))
const where = { dataDir: '/private/fixture', port: 1234 }
const target = (id: number): PipeTarget => ({ pipe: `pipe-${id}`, token: Buffer.alloc(32, id) })
const held = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('the service host local connector', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => vi.restoreAllMocks())

  it('keeps the Unix socket path and performs no Windows discovery', () => {
    const signal = new AbortController().signal
    const connect = serviceConnector(where, { platform: 'darwin' })
    const result = connect('ws+unix:///private/socket:/api/local-ws', signal)
    expect(result).not.toBeInstanceOf(Promise)
    expect(WebSocket).toHaveBeenCalledWith('ws+unix:///private/socket:/api/local-ws')
    expect(daemonPipe).not.toHaveBeenCalled()
    expect(pipeWebSocket).not.toHaveBeenCalled()
  })

  it('uses the current platform and existing authenticated endpoint lookup by default', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      vi.mocked(daemonPipe).mockResolvedValue(target(1))
      const connect = serviceConnector(where)
      await connect('unused', new AbortController().signal)
      expect(daemonPipe).toHaveBeenCalledWith(where.dataDir, where.port)
      expect(pipeWebSocket).toHaveBeenCalledWith(target(1))
      expect(WebSocket).not.toHaveBeenCalled()
    } finally { Object.defineProperty(process, 'platform', original) }
  })

  it('shares only an in-flight proof and rediscovers the next core and token after settlement', async () => {
    const lookup = held<PipeTarget | null>()
    const pipe = vi.fn().mockReturnValueOnce(lookup.promise).mockResolvedValueOnce(target(2))
    const connect = serviceConnector(where, { platform: 'win32', pipe })
    const first = connect('unused', new AbortController().signal)
    const second = connect('unused', new AbortController().signal)
    await Promise.resolve()
    expect(pipe).toHaveBeenCalledOnce()
    lookup.resolve(target(1))
    await Promise.all([first, second])
    expect(pipeWebSocket).toHaveBeenCalledTimes(2)
    await connect('unused', new AbortController().signal)
    expect(pipe).toHaveBeenCalledTimes(2)
    expect(pipeWebSocket).toHaveBeenLastCalledWith(target(2))
  })

  it('keeps a stopped caller from opening a socket without releasing the other callers proof', async () => {
    const lookup = held<PipeTarget | null>(), pipe = vi.fn(() => lookup.promise)
    const connect = serviceConnector(where, { platform: 'win32', pipe })
    const cancelled = new AbortController()
    const first = Promise.resolve(connect('unused', cancelled.signal)).catch((error: unknown) => error)
    cancelled.abort()
    const second = connect('unused', new AbortController().signal)
    await Promise.resolve()
    expect(pipe).toHaveBeenCalledOnce()
    lookup.resolve(target(1))
    expect(await first).toMatchObject({ name: 'AbortError' })
    await second
    expect(pipeWebSocket).toHaveBeenCalledOnce()
  })

  it('starts no lookup or socket for an already stopped caller', () => {
    const controller = new AbortController()
    controller.abort()
    const connect = serviceConnector(where, { platform: 'win32' })
    expect(() => connect('unused', controller.signal)).toThrow()
    expect(daemonPipe).not.toHaveBeenCalled()
    expect(pipeWebSocket).not.toHaveBeenCalled()
  })

  it('releases failed or absent discovery only when it settles, without any TCP fallback', async () => {
    const pipe = vi.fn().mockRejectedValueOnce(new Error('discovery failed')).mockResolvedValueOnce(null).mockResolvedValueOnce(target(3))
    const connect = serviceConnector(where, { platform: 'win32', pipe })
    await expect(connect('unused', new AbortController().signal)).rejects.toThrow('discovery failed')
    await expect(connect('unused', new AbortController().signal)).rejects.toThrow('SERVICE_ENDPOINT_UNAVAILABLE')
    expect(WebSocket).not.toHaveBeenCalled()
    expect(pipeWebSocket).not.toHaveBeenCalled()
    await connect('unused', new AbortController().signal)
    expect(pipe).toHaveBeenCalledTimes(3)
    expect(pipeWebSocket).toHaveBeenCalledOnce()
  })
})
