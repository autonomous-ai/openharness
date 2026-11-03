import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({
  auth: vi.fn(), admits: vi.fn(), relay: vi.fn(), publish: vi.fn(), changed: vi.fn(), live: vi.fn(), upgrade: vi.fn(), info: vi.fn(),
  SsoAuthError: class SsoAuthError extends Error { constructor(message: string, readonly code: string) { super(message) } },
}))
vi.mock('./ssoAuth.js', () => ({ authenticateAccessToken: m.auth, SsoAuthError: m.SsoAuthError }))
vi.mock('../utils/logger.js', () => ({ logger: { info: m.info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('./agentMessageShares.js', () => ({ admits: m.admits }))
vi.mock('./bus.js', () => ({ subscribeTabRelay: m.relay, publishTabRelay: m.publish, subscribeAgentMessageShareChanged: m.changed }))
vi.mock('./hub.js', () => ({ trackSocketLiveness: m.live }))
vi.mock('./wsServer.js', () => ({ WS_LIMITS: { agentMessages: 1 }, createWss: () => ({ handleUpgrade: m.upgrade }) }))
import { handleAgentMessagesUpgrade } from './agentMessagesWs.js'

const user = { sub: 'ken', email: 'ken@example.com', autonomousEnv: 'prod' as const, role: 'user' }
const SHARE = 'a'.repeat(24)
class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0
  send = vi.fn()
  close = vi.fn((_code?: number, _reason?: string) => { this.readyState = 3; this.emit('close') })
  terminate = vi.fn(() => this.close())
  frame(body: unknown) { this.emit('message', Buffer.from(JSON.stringify(body)), false) }
}
const flush = async () => { for (let i = 0; i < 400; i++) await Promise.resolve() }
const req = (query = `share=${SHARE}&machine=ken-mac`, token: string | null = 'tok') =>
  ({ url: `/api/agent-messages-ws?${query}`, headers: token ? { 'sec-websocket-protocol': token } : {} })
const sent = (ws: Socket) => ws.send.mock.calls.map(c => JSON.parse(c[0] as string))

describe('blind shared-tab relay WebSocket', () => {
  let ws: Socket, socket: { destroyed: boolean; destroy: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> }
  let incoming: (message: unknown) => void, changed: () => void
  let disposeRelay: ReturnType<typeof vi.fn<() => void>>, disposeChanged: ReturnType<typeof vi.fn<() => void>>, disposeLive: ReturnType<typeof vi.fn<() => void>>
  beforeEach(() => {
    vi.useFakeTimers(); vi.resetAllMocks(); ws = new Socket(); socket = { destroyed: false, destroy: vi.fn(), write: vi.fn() }
    disposeRelay = vi.fn(); disposeChanged = vi.fn(); disposeLive = vi.fn()
    m.auth.mockResolvedValue(user); m.admits.mockResolvedValue(true); m.publish.mockResolvedValue(1)
    m.live.mockReturnValue(disposeLive)
    m.relay.mockImplementation(async (_s, _m, cb) => { incoming = cb; return disposeRelay })
    m.changed.mockImplementation(async (_s, cb) => { changed = cb; return disposeChanged })
    m.upgrade.mockImplementation((_r, _s, _h, done) => done(ws))
  })
  afterEach(() => { ws.close(); vi.useRealTimers() })
  const connect = async (request: unknown = req()) => {
    handleAgentMessagesUpgrade(request as never, socket as never, Buffer.alloc(0)); await flush()
  }

  it('destroys the socket before upgrade without a token, a 24-hex share or a machine', async () => {
    for (const request of [req(undefined, null), req(`share=zz&machine=m`), req(`share=${SHARE.toUpperCase()}&machine=m`),
      req(`share=${SHARE}`), req(`share=${SHARE}&machine=${'x'.repeat(129)}`), { headers: { 'sec-websocket-protocol': 'tok' } }]) {
      await connect(request)
    }
    expect(socket.destroy).toHaveBeenCalledTimes(6)
    expect(m.auth).not.toHaveBeenCalled(); expect(m.upgrade).not.toHaveBeenCalled()
  })

  // WebSocket roadmap Phase 0: which daemon, how its socket ended and after how long.
  it('logs the daemon it declared, and how and when its socket closed', async () => {
    await connect(req(`share=${SHARE}&machine=ken-mac&client=relay&v=0.9.1`))
    vi.advanceTimersByTime(1_500)
    ws.emit('close', 4409, Buffer.from('Replaced by a newer connection'))
    const lines = m.info.mock.calls.filter(c => c[0] === 'agent-messages disconnected').map(c => c[1])
    expect(lines).toEqual([expect.objectContaining({ endpoint: 'agentMessages', client: 'relay', version: '0.9.1', userId: 'ken',
      machineId: 'ken-mac', code: 4409, reason: 'Replaced by a newer connection', aliveMs: 1_500 })])
  })

  // Review of #2029: as the observer's, the shared tab's lines never carry its id.
  it('keeps the shared tab id out of its connect and disconnect lines', async () => {
    await connect(req(`share=${SHARE}&machine=ken-mac&client=relay`))
    ws.emit('close', 1000, Buffer.alloc(0))
    const lines = m.info.mock.calls.filter(c => String(c[0]).startsWith('agent-messages'))
    expect(lines.map(c => c[0])).toEqual(['agent-messages connected', 'agent-messages disconnected'])
    expect(JSON.stringify(lines)).not.toContain(SHARE)
  })

  it('upgrades a refused connection and closes it 4403, authenticating as a daemon', async () => {
    m.admits.mockResolvedValue(false)
    await connect(req(`share=${SHARE}&machine=ken-mac&autonomousEnv=stag`))
    expect(m.auth).toHaveBeenCalledWith('tok', 'stag', { allowHarnessSession: 'computer' })
    expect(m.admits).toHaveBeenCalledWith('ken', 'ken-mac', SHARE, 'stag')
    expect(ws.close).toHaveBeenCalledWith(4403, expect.any(String)); expect(m.relay).not.toHaveBeenCalled()
  })

  it('answers a token that does not authenticate 401 before the upgrade, the wrong environment 403, never 4403', async () => {
    m.auth.mockRejectedValueOnce(new m.SsoAuthError('Invalid or expired SSO access token', 'INVALID_TOKEN'))
    await connect()
    expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    expect(socket.destroy).toHaveBeenCalledTimes(1)
    for (const code of ['AUTONOMOUS_ENV_MISMATCH', 'AUTONOMOUS_ENV_NOT_ALLOWED']) {
      m.auth.mockRejectedValueOnce(new m.SsoAuthError('wrong environment', code))
      await connect()
      expect(socket.write).toHaveBeenLastCalledWith('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    }
    expect(socket.destroy).toHaveBeenCalledTimes(3)
    // Its socket gone meanwhile: nothing written to it.
    socket.destroyed = true; m.auth.mockRejectedValueOnce(new m.SsoAuthError('expired', 'INVALID_TOKEN')); await connect()
    expect(socket.write).toHaveBeenCalledTimes(3)
    // An auth service that is down is no answer on the token: the socket is dropped, for the daemon to try again.
    socket.destroyed = false; m.auth.mockRejectedValueOnce(new m.SsoAuthError('down', 'AUTH_SERVICE_UNAVAILABLE')); await connect()
    expect(socket.write).toHaveBeenCalledTimes(3); expect(socket.destroy).toHaveBeenCalledTimes(4)
    expect(m.upgrade).not.toHaveBeenCalled(); expect(m.admits).not.toHaveBeenCalled()
  })

  it('answers a team sign-in (lib/teamSession.ts) 403 before the upgrade: refused for good, not a token to refresh', async () => {
    m.auth.mockRejectedValueOnce(new m.SsoAuthError('This connection is not available to a team sign-in', 'TEAM_SESSION_LIMITED'))
    await connect()
    expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    expect(m.admits).not.toHaveBeenCalled(); expect(m.upgrade).not.toHaveBeenCalled()
  })

  it('tells an admitted socket it is ready and subscribes to its own channel and share changes', async () => {
    await connect()
    expect(m.admits).toHaveBeenCalledWith('ken', 'ken-mac', SHARE, 'prod')
    expect(m.relay).toHaveBeenCalledWith(SHARE, 'ken-mac', expect.any(Function))
    expect(m.changed).toHaveBeenCalledWith(SHARE, expect.any(Function))
    expect(sent(ws)).toEqual([{ type: 'amsg_ready' }])
    ws.close()
    expect(disposeLive).toHaveBeenCalledTimes(1); expect(disposeRelay).toHaveBeenCalledTimes(1); expect(disposeChanged).toHaveBeenCalledTimes(1)
  })

  it('publishes a client frame to the addressed machine with the sender stamped by the server', async () => {
    await connect()
    ws.frame({ type: 'amsg_frame', to: 'bob-mini', from: { machineId: 'forged', userId: 'mallory' }, payload: { __e2e: { c: 1 } } }); await flush()
    expect(m.publish).toHaveBeenCalledTimes(1)
    expect(m.publish).toHaveBeenCalledWith(SHARE, 'bob-mini', { from: { machineId: 'ken-mac', userId: 'ken' }, payload: { __e2e: { c: 1 } } })
    expect(sent(ws)).toEqual([{ type: 'amsg_ready' }])
  })

  it('answers amsg_undeliverable when nobody received the frame', async () => {
    await connect(); m.publish.mockResolvedValueOnce(0)
    ws.frame({ type: 'amsg_frame', to: 'bob-mini', payload: { hello: {} } }); await flush()
    expect(sent(ws).at(-1)).toEqual({ type: 'amsg_undeliverable', to: 'bob-mini' })
  })

  it('hands a frame from its channel to the socket unchanged, and nothing after close', async () => {
    await connect()
    const from = { machineId: 'bob-mini', userId: 'bob' }
    incoming({ from, payload: { __e2e: { c: 2 } } })
    expect(sent(ws).at(-1)).toEqual({ type: 'amsg_frame', from, payload: { __e2e: { c: 2 } } })
    ws.close(); incoming({ from, payload: { welcome: {} } })
    expect(ws.send).toHaveBeenCalledTimes(2)
  })

  it('closes 1008 on binary, oversized, over-rate, malformed or unknown frames', async () => {
    const bad: Array<[string, () => void]> = [
      ['binary', () => ws.emit('message', Buffer.from('{}'), true)],
      ['over 128 KiB', () => ws.emit('message', Buffer.alloc(128 * 1024 + 1), false)],
      ['over 128 KiB in fragments', () => ws.emit('message', [Buffer.alloc(128 * 1024), Buffer.alloc(1)], false)],
      ['not json', () => ws.emit('message', Buffer.from('garbage'), false)],
      ['unknown type', () => ws.frame({ type: 'agent_delete', to: 'x', payload: {} })],
      ['no recipient', () => ws.frame({ type: 'amsg_frame', payload: {} })],
      ['empty recipient', () => ws.frame({ type: 'amsg_frame', to: '', payload: {} })],
      ['recipient too long', () => ws.frame({ type: 'amsg_frame', to: 'x'.repeat(129), payload: {} })],
      ['no payload', () => ws.frame({ type: 'amsg_frame', to: 'x' })],
      ['non-object payload', () => ws.frame({ type: 'amsg_frame', to: 'x', payload: 'text' })],
    ]
    for (const [, send] of bad) {
      ws = new Socket(); await connect(); send(); await flush()
      expect(ws.close).toHaveBeenCalledWith(1008, expect.any(String)); expect(m.publish).not.toHaveBeenCalled()
    }
    ws = new Socket(); await connect()
    for (let i = 0; i < 21; i++) ws.frame({ type: 'amsg_frame', to: 'x', payload: {} })
    await flush()
    // Closed as the 21st arrived, before the queue reached any: nothing of a burst over the rate is published.
    expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid shared tab message'); expect(m.publish).not.toHaveBeenCalled()
  })

  it('allows 20 frames per second and resets the window', async () => {
    await connect()
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 20; i++) ws.frame({ type: 'amsg_frame', to: 'x', payload: {} })
      await flush(); await vi.advanceTimersByTimeAsync(1000)
    }
    expect(ws.close).not.toHaveBeenCalled(); expect(m.publish).toHaveBeenCalledTimes(40)
  })

  it('counts the rate, binary and size as frames arrive: a slow publish never lets a burst queue up behind it', async () => {
    await connect()
    let release!: (n: number) => void
    m.publish.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    ws.frame({ type: 'amsg_frame', to: 'x', payload: {} }); await flush()
    expect(m.publish).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 20; i++) ws.frame({ type: 'amsg_frame', to: 'x', payload: {} })
    // Closed at the 21st as it arrived, while the first still waits: counted when handled, all 21 would have queued.
    expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid shared tab message')
    release(1); await flush()
    expect(m.publish).toHaveBeenCalledTimes(1)
    for (const send of [() => ws.emit('message', Buffer.from('{}'), true), () => ws.emit('message', Buffer.alloc(128 * 1024 + 1), false)]) {
      ws = new Socket(); await connect()
      m.publish.mockImplementationOnce(() => new Promise(() => {}))
      ws.frame({ type: 'amsg_frame', to: 'x', payload: {} }); await flush()
      send()
      expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid shared tab message')
    }
  })

  it('closes 1008 when too many frames queue behind a slow publish, and 1013 when publishing fails', async () => {
    await connect(); ws.close.mockImplementation(() => {})
    let release!: (n: number) => void
    m.publish.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    // Within the rate, a second at a time, until the queue's 256 are full.
    ws.frame({ type: 'amsg_frame', to: 'x', payload: {} }); await flush()
    for (let i = 1; i < 258; i++) { if (i % 20 === 0) vi.advanceTimersByTime(1000); ws.frame({ type: 'amsg_frame', to: 'x', payload: {} }) }
    expect(ws.close).not.toHaveBeenCalledWith(1008, 'Invalid shared tab message')
    expect(ws.close).toHaveBeenCalledWith(1008, 'Too many shared tab messages')
    // Closed for real before the publish finishes: the frames queued behind it are dropped, not published.
    ws.emit('close'); release(1); await flush()
    expect(m.publish).toHaveBeenCalledTimes(1)
    ws = new Socket(); await connect(); m.publish.mockRejectedValueOnce(new Error('relay down'))
    ws.frame({ type: 'amsg_frame', to: 'x', payload: {} }); await flush()
    expect(ws.close).toHaveBeenCalledWith(1013, 'Shared tab temporarily unavailable')
  })

  it('ignores a queued frame once the socket has closed', async () => {
    await connect()
    let release!: (n: number) => void
    m.publish.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    ws.frame({ type: 'amsg_frame', to: 'x', payload: {} }); ws.frame({ type: 'amsg_frame', to: 'y', payload: {} }); await flush()
    ws.close(); release(1); await flush()
    expect(m.publish).toHaveBeenCalledTimes(1)
    // A frame the socket still hands over after its close is not counted or queued either.
    ws.frame({ type: 'amsg_frame', to: 'z', payload: {} }); await flush()
    expect(m.publish).toHaveBeenCalledTimes(1)
  })

  it('closes 4403 when a share change or the 60 second re-check finds the socket no longer admitted', async () => {
    await connect(); m.admits.mockResolvedValue(false); changed(); await flush()
    expect(ws.close).toHaveBeenCalledWith(4403, expect.any(String))
    m.admits.mockResolvedValue(true); ws = new Socket(); await connect()
    const checks = m.admits.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000); expect(ws.close).not.toHaveBeenCalled()
    expect(m.admits.mock.calls.length).toBe(checks + 1)
    m.admits.mockResolvedValue(false); await vi.advanceTimersByTimeAsync(59_999); expect(ws.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(ws.close).toHaveBeenCalledWith(4403, expect.any(String))
  })

  it('closes 1013 when the re-check fails, an upstream is down or admission cannot be decided', async () => {
    await connect(); m.admits.mockRejectedValueOnce(new Error('db down')); changed(); await flush()
    expect(ws.close).toHaveBeenCalledWith(1013, 'Shared tab temporarily unavailable')
    await connect(req(`share=${SHARE}&machine=m&autonomousEnv=nope`)); expect(socket.destroy).toHaveBeenCalledTimes(1)
    ws = new Socket(); m.relay.mockRejectedValueOnce(new Error('bus down')); await connect()
    expect(ws.close).toHaveBeenCalledWith(1013, 'Shared tab temporarily unavailable')
    expect(sent(ws)).toEqual([])
  })

  it('closes the older socket 4409 for the same share and machine, and never lets it unregister the newer one', async () => {
    await connect()
    const first = ws; first.close.mockImplementation(() => {})   // stays "open" until its close event, as a real socket does
    const second = new Socket(); ws = second; await connect()
    expect(first.close).toHaveBeenCalledWith(4409, expect.any(String)); expect(second.close).not.toHaveBeenCalled()
    first.emit('close')                                           // the old socket finally closes: must not delete the new entry
    const third = new Socket(); ws = third; await connect()
    expect(second.close).toHaveBeenCalledWith(4409, expect.any(String))
    const other = new Socket(); ws = other
    await connect(req(`share=${SHARE}&machine=other-mac`)); expect(third.close).not.toHaveBeenCalled()
  })

  it('does not finish attaching a socket that closed while subscribing', async () => {
    let release!: (dispose: () => void) => void
    m.changed.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    handleAgentMessagesUpgrade(req() as never, socket as never, Buffer.alloc(0)); await flush()
    ws.close(); release(() => disposeChanged()); await flush()
    expect(disposeChanged).toHaveBeenCalledTimes(1); expect(ws.send).not.toHaveBeenCalled()
    expect(disposeRelay).toHaveBeenCalledTimes(1); disposeRelay.mockClear(); ws = new Socket()
    m.relay.mockImplementationOnce(async () => { ws.close(); return disposeRelay })
    await connect()
    expect(disposeRelay).toHaveBeenCalledTimes(1); expect(ws.send).not.toHaveBeenCalled()
  })

  it('drops the connection when authentication or admission throws, and stops when the socket is already gone', async () => {
    m.auth.mockRejectedValueOnce(new Error('invalid')); await connect()
    expect(socket.destroy).toHaveBeenCalledTimes(1)
    socket.destroyed = true; m.auth.mockRejectedValueOnce(new Error('invalid')); await connect()
    expect(socket.destroy).toHaveBeenCalledTimes(1)
    await connect(); expect(m.upgrade).not.toHaveBeenCalled()
  })
})
