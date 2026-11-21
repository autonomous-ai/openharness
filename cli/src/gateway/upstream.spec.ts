import { EventEmitter, once } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hostname } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { backendName, env } from '../config/env.js'
import { AuthSessionError } from '../lib/authSession.js'
import { UpstreamLink } from './upstream.js'

// A computer's name that is not its hostname, so the adapter-ws label below shows which one it sends.
vi.mock('../lib/computerName.js', () => ({ computerName: async () => 'Test Lab Mac' }))

// A stand-in backend on loopback. `onConnection` decides what each accepted link gets; `refuse` answers
// every upgrade with that HTTP status instead.
async function backend(opts: { onConnection?: (ws: WebSocket, request: IncomingMessage) => void; refuse?: number } = {}) {
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    ...(opts.refuse ? { verifyClient: (_info: unknown, done: (ok: boolean, code?: number) => void) => done(false, opts.refuse) } : {}),
  })
  await once(wss, 'listening')
  const links: WebSocket[] = []
  wss.on('connection', (ws, request) => { links.push(ws); opts.onConnection?.(ws, request) })
  return { wss, links, url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}` }
}

type Auth = { accessToken(opts?: { force?: boolean }): Promise<string> }

function upstream(auth: Auth) {
  const signals = new EventEmitter()
  const link = new UpstreamLink({
    machineId: 'upstream-spec',
    auth,
    events: {
      down: () => {},
      binary: () => {},
      up: () => {},
      gone: () => {},
      status: (connected) => { signals.emit(connected ? 'up' : 'down') },
      revoked: () => { signals.emit('revoked') },
      busy: () => {},
      localClients: () => ({ desktop: 0, tui: 0 }),
    },
  })
  return { link, signals }
}

const token: Auth = { accessToken: async () => 'token' }

// How long the link waits before it dials again: the one timer it left pending, read off the fake clock.
function nextRedialMs(): number {
  expect(vi.getTimerCount()).toBe(1)
  const before = Date.now()
  vi.advanceTimersToNextTimer()
  return Date.now() - before
}

async function untilATimerIsPending(): Promise<void> {
  for (let turn = 0; turn < 1_000 && vi.getTimerCount() === 0; turn++) await new Promise((resolve) => setImmediate(resolve))
}

describe('UpstreamLink reconnect backoff', () => {
  const originalUrl = env.BACKEND_WS_URL
  let servers: WebSocketServer[] = []
  let links: UpstreamLink[] = []

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Halfway through each wait's window, so every wait is one exact number.
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })

  afterEach(async () => {
    for (const link of links) link.stop()
    links = []
    vi.useRealTimers()
    env.BACKEND_WS_URL = originalUrl
    await Promise.all(servers.map((wss) => {
      for (const client of wss.clients) client.terminate()
      return new Promise((resolve) => wss.close(resolve))
    }))
    servers = []
    // A dial the stop cut short reports its error a turn later; keep it out of the test output.
    await new Promise((resolve) => setImmediate(resolve))
    vi.restoreAllMocks()
  })

  async function serve(opts: Parameters<typeof backend>[0] = {}) {
    const server = await backend(opts)
    servers.push(server.wss)
    env.BACKEND_WS_URL = server.url
    return server
  }

  function open(auth: Auth = token) {
    const made = upstream(auth)
    links.push(made.link)
    return made
  }

  it('spreads each redial at random between one second and its step, and keeps the 30 s cap, while a link drops as soon as it opens', async () => {
    // A draining pod: the upgrade is answered, then the socket is cut at once.
    await serve({ onConnection: (ws) => ws.terminate() })
    const { link, signals } = open()

    const waits: number[] = []
    let dropped = once(signals, 'down')
    link.connect()
    for (let i = 0; i < 6; i++) {
      await dropped
      dropped = once(signals, 'down')
      waits.push(nextRedialMs())
    }

    // Steps 2, 4, 8, 16, 30, 30 s, each waited halfway between 1 s and the step.
    expect(waits).toEqual([1_500, 2_500, 4_500, 8_500, 15_500, 15_500])
  })

  it('starts the backoff over only once a link has stayed up for 30 s', async () => {
    const server = await serve()
    const { link, signals } = open()

    let up = once(signals, 'up')
    link.connect()
    await up
    vi.advanceTimersByTime(29_000)
    let dropped = once(signals, 'down')
    server.links.at(-1)!.terminate()
    await dropped
    up = once(signals, 'up')
    // 29 s up was not stable: the first wait stays in place and the next one grows.
    expect(nextRedialMs()).toBe(1_500)
    await up
    dropped = once(signals, 'down')
    server.links.at(-1)!.terminate()
    await dropped
    up = once(signals, 'up')
    expect(nextRedialMs()).toBe(2_500)
    await up

    vi.advanceTimersByTime(30_000)
    dropped = once(signals, 'down')
    server.links.at(-1)!.terminate()
    await dropped
    expect(nextRedialMs()).toBe(1_500)
  })

  it('backs off a token refresh the backend cannot answer instead of asking again every second', async () => {
    await serve()
    const unavailable: Auth = { accessToken: async () => { throw new AuthSessionError('refresh unavailable', 'UNAVAILABLE') } }
    const { link, signals } = open(unavailable)

    const waits: number[] = []
    let failed = once(signals, 'down')
    link.connect()
    for (let i = 0; i < 3; i++) {
      await failed
      failed = once(signals, 'down')
      waits.push(nextRedialMs())
    }

    expect(waits).toEqual([1_500, 2_500, 4_500])
  })

  it('backs off a redial after a refused token whose refresh failed', async () => {
    await serve({ refuse: 401 })
    const forced: boolean[] = []
    const auth: Auth = {
      accessToken: async (opts) => {
        forced.push(Boolean(opts?.force))
        if (opts?.force) throw new AuthSessionError('refresh unavailable', 'UNAVAILABLE')
        return 'token'
      },
    }
    const { link } = open(auth)

    link.connect()
    await untilATimerIsPending()

    expect(forced).toEqual([false, true])
    expect(nextRedialMs()).toBe(1_500)
  })

  it('backs off redials while the backend refuses every token, even though each refresh succeeds', async () => {
    await serve({ refuse: 401 })
    let refreshes = 0
    const auth: Auth = { accessToken: async (opts) => { if (opts?.force) refreshes++; return 'token' } }
    const { link } = open(auth)

    const waits: number[] = []
    link.connect()
    for (let i = 0; i < 3; i++) {
      await untilATimerIsPending()
      waits.push(nextRedialMs())
    }

    expect(waits).toEqual([1_500, 2_500, 4_500])
    expect(refreshes).toBe(3)
  })

  // The backend writes this label to Machine.hostname on every connect, and the apps read it as the hostname.
  it('the adapter-ws dial is labelled with the hostname, not the computer\'s name', async () => {
    let dialed = ''
    await serve({ onConnection: (_ws, request) => { dialed = request.url ?? '' } })
    const { link, signals } = open()

    const up = once(signals, 'up')
    link.connect()
    await up

    expect(new URL(dialed, 'ws://backend').searchParams.get('label')).toBe(hostname())
  })

  it.each(['stop', 'close'] as const)('cancels a pending redial on %s', async (end) => {
    await serve({ onConnection: (ws) => ws.terminate() })
    const { link, signals } = open()

    const dropped = once(signals, 'down')
    link.connect()
    await dropped
    expect(vi.getTimerCount()).toBe(1)

    link[end]()

    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('UpstreamLink connected line', () => {
  // Every process says the backend with the same words (core/main.ts, device/deviceLink.ts): a hash differs between processes.
  it('names the backend by whether it is the one a build dials unless told otherwise', () => {
    expect(backendName('wss://harness-api.autonomous.ai')).toBe('the production backend')
    expect(backendName('wss://harness-api.autonomous.ai/api/adapter-ws?label=sentinel&v=1')).toBe('the production backend')
    expect(backendName('wss://harness-api.autonomous.ai.example/api/adapter-ws')).toBe('another backend')
    expect(backendName('ws://localhost:8090')).toBe('another backend')
    expect(backendName('not a URL')).toBe('another backend')
  })

  // `harness start` waits for `[backend] connected` (lib/daemonLaunch.ts); the URL carries the hostname.
  it('the connected line keeps its marker and says which backend in fixed words, never its URL', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const originalUrl = env.BACKEND_WS_URL
    let dialed = ''
    const server = await backend({ onConnection: (_ws, request) => { dialed = request.url ?? '' } })
    env.BACKEND_WS_URL = server.url
    const { link, signals } = upstream(token)
    try {
      const up = once(signals, 'up')
      link.connect()
      await up

      const lines = log.mock.calls.map((call) => call.map(String).join(' '))
      expect(dialed).toContain('label=')
      expect(lines.filter((line) => line.startsWith('[backend] connected'))).toEqual(['[backend] connected · another backend'])
      expect(lines.join('\n')).not.toContain('127.0.0.1')
    } finally {
      link.stop()
      env.BACKEND_WS_URL = originalUrl
      for (const client of server.wss.clients) client.terminate()
      await new Promise((resolve) => server.wss.close(resolve))
      vi.restoreAllMocks()
    }
  })
})

describe('UpstreamLink socket errors', () => {
  it('the socket\'s error line names its kind and the status, never the host', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const originalUrl = env.BACKEND_WS_URL
    const server = await backend()
    env.BACKEND_WS_URL = server.url
    const { link, signals } = upstream(token)
    try {
      const up = once(signals, 'up')
      link.connect()
      await up
      const ws = (link as unknown as { ws: WebSocket }).ws
      ws.emit('error', new Error('Unexpected server response: 401'))
      ws.emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND api.example.test'), { code: 'ENOTFOUND' }))

      expect(error.mock.calls).toEqual([
        ['[backend] socket error: Error · Unexpected server response: 401'],
        ['[backend] socket error: ENOTFOUND'],
      ])
      expect(JSON.stringify([...log.mock.calls, ...error.mock.calls])).not.toContain('api.example.test')
    } finally {
      link.stop()
      env.BACKEND_WS_URL = originalUrl
      for (const client of server.wss.clients) client.terminate()
      await new Promise((resolve) => server.wss.close(resolve))
      vi.restoreAllMocks()
    }
  })
})
