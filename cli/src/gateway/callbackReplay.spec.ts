import http from 'node:http'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CALLBACK_REQUESTS_MAX, createCallbackReplay } from './callbackReplay.js'

const loopbackGet = (url: string, timeoutMs?: number) => createCallbackReplay({ timeoutMs }).run(url, new AbortController().signal).then(answer => answer.status)

/** The replay of a caught sign-in: the program's status, or why it could not be reached. */
let server: http.Server | null = null
afterEach(() => new Promise<void>((done) => { if (server) { server.closeAllConnections(); server.close(() => done()) } else done(); server = null }))

function listen(handler: http.RequestListener): Promise<number> {
  server = http.createServer(handler)
  return new Promise((done) => server!.listen(0, '127.0.0.1', () => done((server!.address() as AddressInfo).port)))
}

describe('callback HTTP requests', () => {
  it('fails a synchronous start without retaining credit and cancels a request aborted during construction', async () => {
    const controller = new AbortController()
    const request = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    const get = vi.fn().mockImplementationOnce(() => { throw new Error('private path') }).mockImplementation(() => { controller.abort(); return request }) as unknown as typeof http.get
    const replay = createCallbackReplay({ get })
    await expect(replay.run('http://127.0.0.1:1', controller.signal)).rejects.toThrow('CALLBACK_NOT_STARTED')
    await expect(replay.run('http://127.0.0.1:1', controller.signal)).rejects.toThrow('CALLBACK_ABORTED')
    expect(request.destroy).toHaveBeenCalledOnce()
    request.emit('close')
    await replay.stop()
  })

  it('keeps stop bounded without releasing outstanding physical requests', async () => {
    vi.useFakeTimers()
    try {
      const request = Object.assign(new EventEmitter(), { destroy: vi.fn() })
      const get = vi.fn(() => request) as unknown as typeof http.get
      const replay = createCallbackReplay({ get })
      const running = replay.run('http://127.0.0.1:1', new AbortController().signal).catch(error => error.message)
      const stopping = replay.stop(), failed = stopping.catch(error => error.message)
      expect(replay.stop()).toBe(stopping)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await failed).toBe('CALLBACK_CLOSE_TIMEOUT')
      await expect(replay.run('http://127.0.0.1:1', new AbortController().signal)).rejects.toThrow('CALLBACK_UNAVAILABLE')
      expect(get).toHaveBeenCalledOnce()
      request.emit('close')
      expect(await running).toBe('CALLBACK_CLOSED')
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('handles headers without a status or location and retires the response only at request close', async () => {
    const request = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    let headers!: (response: http.IncomingMessage) => void
    const get = vi.fn((_url, _options, callback) => { headers = callback; return request }) as unknown as typeof http.get
    const replay = createCallbackReplay({ get })
    const result = replay.run('http://127.0.0.1:1', new AbortController().signal)
    const response = { headers: {}, destroy: vi.fn() }
    headers(response as unknown as http.IncomingMessage)
    expect(response.destroy).toHaveBeenCalledOnce()
    request.emit('close')
    expect(await result).toEqual({ status: 0, location: null })
    await replay.stop()
  })

  it('retains physical request credit after cancellation until actual close, including during stop', async () => {
    const requests: Array<EventEmitter & { destroy: ReturnType<typeof vi.fn> }> = []
    const get = vi.fn(() => {
      const request = Object.assign(new EventEmitter(), { destroy: vi.fn() })
      requests.push(request)
      return request
    }) as unknown as typeof http.get
    const replay = createCallbackReplay({ get })
    const controllers = Array.from({ length: CALLBACK_REQUESTS_MAX }, () => new AbortController())
    const calls = controllers.map(controller => replay.run('http://127.0.0.1:1', controller.signal).catch(error => error.message))
    controllers.forEach(controller => controller.abort())
    expect(await Promise.all(calls)).toEqual(controllers.map(() => 'CALLBACK_ABORTED'))
    await expect(replay.run('http://127.0.0.1:1', new AbortController().signal)).rejects.toThrow('CALLBACK_UNAVAILABLE')
    expect(requests).toHaveLength(CALLBACK_REQUESTS_MAX)
    requests[0].emit('close')
    const replacement = replay.run('http://127.0.0.1:1', new AbortController().signal).catch(error => error.message)
    expect(requests).toHaveLength(CALLBACK_REQUESTS_MAX + 1)
    let stopped = false
    const stop = replay.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    for (const request of requests.slice(1)) request.emit('close')
    await stop
    expect(stopped).toBe(true)
    expect(await replacement).toBe('CALLBACK_CLOSED')
  })

  it('closes the callback connection after its headers without waiting for an endless body', async () => {
    let closed = false
    const port = await listen((request, response) => {
      request.socket.once('close', () => { closed = true })
      response.writeHead(302, { location: '/success' })
      response.flushHeaders()
    })
    expect(await loopbackGet(`http://127.0.0.1:${port}/callback`)).toBe(302)
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 150 })
  })
  it('answers with the program\'s status, query and all', async () => {
    let seen = ''
    const port = await listen((request, response) => { seen = request.url ?? ''; response.writeHead(302, { location: 'https://x.test/done' }).end() })
    expect(await loopbackGet(`http://127.0.0.1:${port}/callback?code=c&state=s`)).toBe(302)
    expect(seen).toBe('/callback?code=c&state=s')
  })

  it('fails when nothing listens, or nothing answers in time', async () => {
    const port = await listen(() => { /* never answers */ })
    await expect(loopbackGet(`http://127.0.0.1:${port}/callback`, 50)).rejects.toThrow('CALLBACK_TIMEOUT')
    server!.closeAllConnections()
    await new Promise<void>((done) => server!.close(() => done()))
    server = null
    await expect(loopbackGet(`http://127.0.0.1:${port}/callback`)).rejects.toThrow()
  })
})
