// The Harness Store proxy: which paths it forwards, who may write, and what the hook server answers.
import http, { type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STORE_PATH_RE as FROM_HOOK_SERVER, startHookServer, type HookServerHandlers } from '../hookServer.js'
import { routeStoreRequest, STORE_PATH_RE, type StoreHandler, type StoreRoute } from './storeProxy.js'

describe('STORE_PATH_RE', () => {
  it('is the one the hook server uses', () => {
    expect(FROM_HOOK_SERVER).toBe(STORE_PATH_RE)
  })

  it('takes the store\'s own paths, with a query', () => {
    for (const path of [
      '/api/store/ratings',
      '/api/store/harnesses/autonomous/marp/reviews?limit=5&cursor=abc%3D',
      '/api/store/harnesses/autonomous/text-to-cad/review',
      '/api/store/harnesses/a..b/reviews',
      '/api/store/harnesses/.well-known/x',
      '/api/store/x?',
    ]) expect(STORE_PATH_RE.test(path), path).toBe(true)
  })

  it('refuses anything else: other characters, an empty rest, and a dot segment fetch would resolve out of the store', () => {
    for (const path of [
      '/api/store/',
      '/api/store/harnesses/a%20b/reviews',
      '/api/store/harnesses/a b/reviews',
      '/api/store/ratings#frag',
      '/api/store/ratings?q=a/b',
      '/api/machines',
      '/api/store/../machines',
      '/api/store/..',
      '/api/store/..?x=1',
      '/api/store/./ratings',
      '/api/store/harnesses/../../auth/me',
      '/api/store/harnesses/autonomous/..',
      `/api/store/${'a'.repeat(201)}`,
    ]) expect(STORE_PATH_RE.test(path), path).toBe(false)
  })
})

describe('routeStoreRequest', () => {
  const store: StoreHandler = async (method, path, body) => ({ status: 200, body: { method, path, body } })
  const request = (method: string | undefined, url: string, localOk = false, body = ''): Parameters<typeof routeStoreRequest>[0] =>
    ({ method, url, localOk, readBody: async () => body })
  const answer = async (route: StoreRoute): Promise<unknown> => ('forward' in route ? { forwarded: await route.forward() } : route)

  it('answers 503 with no backend to proxy to, whatever was asked', async () => {
    expect(await routeStoreRequest(request('PUT', '/api/store/../x', true), undefined)).toEqual({ status: 503, body: { error: 'UNAVAILABLE' } })
  })

  it('forwards a read with no header at all, query included', async () => {
    expect(await answer(await routeStoreRequest(request('GET', '/api/store/ratings?ids=a,b'), store))).toEqual({ status: 400, body: { error: 'BAD_PATH' } })
    expect(await answer(await routeStoreRequest(request('GET', '/api/store/ratings?ids=a'), store)))
      .toEqual({ forwarded: { status: 200, body: { method: 'GET', path: '/api/store/ratings?ids=a', body: undefined } } })
  })

  it('a write needs the local header; a PUT needs a JSON body; a DELETE carries none', async () => {
    const review = '/api/store/harnesses/autonomous/marp/review'
    expect(await routeStoreRequest(request('PUT', review, false, '{"rating":5}'), store)).toEqual({ status: 403, body: { error: 'FORBIDDEN' } })
    expect(await routeStoreRequest(request('DELETE', review, false), store)).toEqual({ status: 403, body: { error: 'FORBIDDEN' } })
    expect(await routeStoreRequest(request('PUT', review, true, '{not json'), store)).toEqual({ status: 400, body: { error: 'bad json' } })
    expect(await routeStoreRequest(request('PUT', review, true, ''), store)).toEqual({ status: 400, body: { error: 'bad json' } })
    expect(await answer(await routeStoreRequest(request('PUT', review, true, '{"rating":5}'), store)))
      .toEqual({ forwarded: { status: 200, body: { method: 'PUT', path: review, body: { rating: 5 } } } })
    expect(await answer(await routeStoreRequest(request('DELETE', review, true, '{"ignored":true}'), store)))
      .toEqual({ forwarded: { status: 200, body: { method: 'DELETE', path: review, body: undefined } } })
  })

  it('anything but GET, PUT and DELETE is 405, header or not', async () => {
    for (const method of ['POST', 'PATCH', 'HEAD', undefined]) {
      expect(await routeStoreRequest(request(method, '/api/store/ratings', true), store), String(method)).toEqual({ status: 405, body: { error: 'METHOD_NOT_ALLOWED' } })
    }
  })
})

describe('the store proxy on the hook server', () => {
  let server: Server | null = null
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  })

  const start = async (onStore?: HookServerHandlers['onStore']): Promise<number> => {
    const started = await startHookServer(0, { onRegistered: vi.fn(), onSessionEnd: vi.fn(), onStore })
    server = started.server
    return started.port
  }
  /** A raw request: the path goes out exactly as written, `..` and all, which fetch would not do. */
  const send = (port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; json: unknown }> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }))
      })
      req.on('error', reject)
      req.end(body)
    })

  it('never forwards a path that climbs out of the store, even to a reader with no header', async () => {
    // Found by this spec: `.` was an id character, so /api/store/../auth/me was forwarded with the
    // daemon's own session and fetch resolved it to a backend route that is not the store's.
    const onStore = vi.fn<StoreHandler>(async () => ({ status: 200, body: { ok: true } }))
    const port = await start(onStore)
    expect(await send(port, 'GET', '/api/store/../auth/me')).toEqual({ status: 400, json: { error: 'BAD_PATH' } })
    expect(await send(port, 'DELETE', '/api/store/harnesses/../../machines/m1', { 'x-adapter-local': '1' })).toEqual({ status: 400, json: { error: 'BAD_PATH' } })
    expect(onStore).not.toHaveBeenCalled()
  })

  it('reads are ungated; writes without the local header are refused before the backend hears of them', async () => {
    const onStore = vi.fn<StoreHandler>(async (method) => ({ status: 201, body: { method } }))
    const port = await start(onStore)
    expect(await send(port, 'GET', '/api/store/ratings')).toEqual({ status: 201, json: { method: 'GET' } })
    expect(await send(port, 'PUT', '/api/store/harnesses/autonomous/marp/review', { 'content-type': 'application/json' }, '{"rating":4}')).toEqual({ status: 403, json: { error: 'FORBIDDEN' } })
    expect(await send(port, 'DELETE', '/api/store/harnesses/autonomous/marp/review')).toEqual({ status: 403, json: { error: 'FORBIDDEN' } })
    expect(await send(port, 'DELETE', '/api/store/harnesses/autonomous/marp/review', { 'x-adapter-local': 'yes' })).toEqual({ status: 403, json: { error: 'FORBIDDEN' } })
    expect(await send(port, 'PUT', '/api/store/harnesses/autonomous/marp/review', { 'x-adapter-local': '1' }, '{"rating":4}')).toEqual({ status: 201, json: { method: 'PUT' } })
    expect(onStore.mock.calls).toEqual([
      ['GET', '/api/store/ratings'],
      ['PUT', '/api/store/harnesses/autonomous/marp/review', { rating: 4 }],
    ])
  })

  it('a body past the hook server\'s limit is bad JSON, not a truncated review', async () => {
    const onStore = vi.fn<StoreHandler>(async () => ({ status: 200, body: {} }))
    const port = await start(onStore)
    const huge = JSON.stringify({ rating: 5, body: 'x'.repeat(300 * 1024) })
    expect(await send(port, 'PUT', '/api/store/harnesses/autonomous/marp/review', { 'x-adapter-local': '1' }, huge)).toEqual({ status: 400, json: { error: 'bad json' } })
    expect(onStore).not.toHaveBeenCalled()
  })

  it('a backend call that throws is a 502 the app can read, and no backend at all is a 503', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const port = await start(async () => { throw new Error('socket hang up') })
    expect(await send(port, 'GET', '/api/store/ratings')).toEqual({ status: 502, json: { success: false, error: { code: 'PROXY_FAILED', message: 'socket hang up' } } })
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    const bare = await start(undefined)
    expect(await send(bare, 'GET', '/api/store/ratings')).toEqual({ status: 503, json: { error: 'UNAVAILABLE' } })
  })
})
