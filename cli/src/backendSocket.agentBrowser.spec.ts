// The agent browser through the socket (services/agentBrowser.ts): its settings carry a proxy's password, their replies the
// proxy's host, and a proxy test's the proxy's exit address. None of it is written to the frame log, and the asker the
// service trusts is the socket's word, never the payload's.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendSocket } from './backendSocket.js'
import { env } from './config/env.js'
import type { Asker, RemoteClient } from './core/api.js'
import type { BrowserStreamManager } from './core/browserStreams.js'
import { TerminalBinaryKind, type TerminalBinaryClear } from './lib/terminalBinary.js'
import * as logModule from './lib/log.js'
import { dispatchDown, gatewayOf, relaySocket } from './testing/relaySocket.js'

type Frame = { type: string; payload: Record<string, unknown> }
const SETTLED = { timeout: 10_000 }

describe('the agent browser through the socket', () => {
  let socket: BackendSocket
  const asked: Array<{ type: string; asker: Asker }> = []

  beforeEach(() => {
    socket = relaySocket('fixture')
    asked.length = 0
    socket.serviceRouter = (type, _payload, asker, reply) => {
      asked.push({ type, asker })
      if (type === 'agent_browser_settings_save') reply({ proxy: { scheme: 'http', host: 'proxy.example', port: 3128, username: 'kim', passwordSet: true } })
      else if (type === 'agent_browser_proxy_test') reply({ ok: true, address: '203.0.113.7', timeZone: 'Europe/Paris' })
      else if (type === 'machine_resources') reply({ cpu: 1 })
      else return false
      return true
    }
  })
  afterEach(async () => {
    await socket.stop()
    vi.restoreAllMocks()
  })

  it('no agent_browser frame is written to the frame log', async () => {
    const wasOn = env.LOG_FRAMES
    env.LOG_FRAMES = true
    const logged = vi.spyOn(logModule, 'logFrame').mockImplementation(() => {})
    const frames: Frame[] = []
    socket.registerLocalClient('local:w', { sendFrame: (frame) => { frames.push(frame as Frame); return true }, sendBinary: () => true })
    try {
      const settings = { proxy: { scheme: 'http', host: 'proxy.example', port: 3128, username: 'kim', password: 'pw-secret' } }
      socket.handleLocalFrame('local:w', { type: 'agent_browser_settings_save', payload: { requestId: 'b-1', agentId: 'a1', settings } })
      socket.handleLocalFrame('local:w', { type: 'agent_browser_proxy_test', payload: { requestId: 'b-2', agentId: 'a1', proxy: settings.proxy } })
      socket.handleLocalFrame('local:w', { type: 'machine_resources', payload: { requestId: 'b-3' } })
      await vi.waitFor(() => expect(frames.map(frame => frame.type)).toEqual(expect.arrayContaining(
        ['agent_browser_settings_save_result', 'agent_browser_proxy_test_result', 'machine_resources_result'])), SETTLED)
      // Sent to every window and to the relay, as a stream's frame will be.
      socket.sendLocal({ type: 'agent_browser_open_result', payload: { requestId: 'b-4', streamId: 's1' } })
      socket.send({ type: 'agent_browser_close', payload: { streamId: 's1', reason: 'closed' } })
      socket.sendRemote({ type: 'agent_browser_close', payload: { streamId: 's1', reason: 'closed' } })
      expect(socket.sendLocalTo('local:w', { type: 'agent_browser_ack', payload: { streamId: 's1' } })).toBe(true)
      // The log works for any other frame, so the silence is the exclusion and not a broken spy.
      const types = logged.mock.calls.map(([, , frame]) => String(frame.type))
      expect(types).toEqual(expect.arrayContaining(['machine_resources', 'machine_resources_result']))
      expect(types.filter(type => type.startsWith('agent_browser_'))).toEqual([])
      for (const secret of ['pw-secret', 'proxy.example', '203.0.113.7']) expect(JSON.stringify(logged.mock.calls)).not.toContain(secret)
    } finally {
      env.LOG_FRAMES = wasOn
      await socket.unregisterLocalClient('local:w')
    }
  })

  it('hands a service\'s product counter to the gateway\'s report', () => {
    const counted = vi.spyOn(gatewayOf(socket), 'usageCounter').mockImplementation(() => {})
    socket.countUsage('agent_browser_enabled')
    expect(counted).toHaveBeenCalledWith('agent_browser_enabled')
  })

  it('asks as the socket knows the connection: a window here, the owner\'s own other Desktop, a share guest', () => {
    socket.registerLocalClient('local:w', { sendFrame: () => true, sendBinary: () => true })
    const remote = (socket as unknown as { remoteClients: Map<string, RemoteClient> }).remoteClients
    remote.set('desk-2', { role: 'web', label: 'Dee’s Mac', identity: 'i2', direct: false, accountOwner: true, machineId: 'machine-2' })
    remote.set('guest-1', { role: 'web', label: null, identity: 'i3', direct: false, accountOwner: false, guest: 'kim@acme.io' })
    remote.set('dial-1', { role: 'device', label: null, identity: 'i4', direct: false })
    expect(socket.askerFor('local:w')).toEqual({ local: true, owner: true, connection: 'local:w' })
    expect(socket.askerFor('desk-2')).toEqual({ local: false, owner: true, accountOwner: true, machine: { machineId: 'machine-2', label: 'Dee’s Mac' }, connection: 'desk-2' })
    expect(socket.askerFor('guest-1')).toEqual({ local: false, owner: false, accountOwner: false, guest: 'kim@acme.io', connection: 'guest-1' })
    expect(socket.askerFor('dial-1')).toEqual({ local: false, owner: false, accountOwner: false, connection: 'dial-1' })
    expect(socket.askerFor('gone')).toEqual({ local: false, owner: false, accountOwner: false, connection: 'gone' })
  })
})

// A browser stream is wired beside the terminal's (core/browserStreams.ts): every way a terminal stream ends, it ends too.
describe('agent browser streams through the socket', () => {
  const STREAM = '00000000-0000-4000-8000-0000000000d1'
  const screen: TerminalBinaryClear = { kind: TerminalBinaryKind.browser, streamId: STREAM, seq: 1, compressed: false, bytes: new Uint8Array([1, 2]) }
  const web: RemoteClient = { role: 'web', label: null, identity: 'i', direct: false, accountOwner: true }
  let socket: BackendSocket
  let streams: { [K in 'open' | 'ack' | 'close' | 'input' | 'closeConnection' | 'route' | 'routeLost' | 'transportError']: ReturnType<typeof vi.fn> }
  let terminals: { handleBinary: ReturnType<typeof vi.fn>; handleFrame: ReturnType<typeof vi.fn>; closeConnection: ReturnType<typeof vi.fn>; closeConnectionsWhere: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    socket = relaySocket('fixture')
    streams = { open: vi.fn(), ack: vi.fn(), close: vi.fn(), input: vi.fn(), closeConnection: vi.fn(), route: vi.fn(), routeLost: vi.fn(), transportError: vi.fn() }
    socket.setBrowserStreams(streams as unknown as BrowserStreamManager)
    terminals = { handleBinary: vi.fn(async () => {}), handleFrame: vi.fn(async () => false), closeConnection: vi.fn(async () => {}), closeConnectionsWhere: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    socket.setTerminalStreamManager(terminals as never)
  })
  afterEach(async () => {
    await socket.stop()
    vi.restoreAllMocks()
  })

  it('a window\'s and a remote client\'s stream frames reach the streams, and nothing else answers them', async () => {
    socket.registerLocalClient('local:w', { sendFrame: () => true, sendBinary: () => true })
    const routed = vi.fn(() => false)
    socket.serviceRouter = routed
    socket.handleLocalFrame('local:w', { type: 'agent_browser_open', payload: { requestId: 'r1', agentId: 'a1' } })
    socket.handleLocalFrame('local:w', { type: 'agent_browser_ack', payload: { streamId: STREAM, bytes: 65536 } })
    await socket.fromGateway.frame('mac-2', { type: 'agent_browser_close', payload: { streamId: STREAM } }, 'relay', 'web')
    await vi.waitFor(() => expect(streams.ack).toHaveBeenCalledWith('local:w', { streamId: STREAM, bytes: 65536 }), SETTLED)
    expect(streams.open).toHaveBeenCalledWith('local:w', { requestId: 'r1', agentId: 'a1' })
    expect(streams.close).toHaveBeenCalledWith('mac-2', { streamId: STREAM })
    expect(routed).not.toHaveBeenCalled()
    expect(terminals.handleFrame).not.toHaveBeenCalled()
    await socket.unregisterLocalClient('local:w')
  })

  it('local agent: kind 8 from the app reaches handleLocalBinary', async () => {
    socket.registerLocalClient('local:w', { sendFrame: () => true, sendBinary: () => true })
    await socket.handleLocalBinary('local:w', screen)
    expect(streams.input).toHaveBeenCalledWith('local:w', STREAM, screen.bytes)
    expect(terminals.handleBinary).not.toHaveBeenCalled()
    await socket.unregisterLocalClient('local:w')
  })

  it('a remote client\'s kind 8 reaches the streams, and a terminal\'s bytes still reach the terminals', async () => {
    await socket.fromGateway.binary('mac-2', screen)
    const keystroke = { ...screen, kind: TerminalBinaryKind.input }
    await socket.fromGateway.binary('mac-2', keystroke)
    expect(streams.input.mock.calls).toEqual([['mac-2', STREAM, screen.bytes]])
    expect(terminals.handleBinary.mock.calls).toEqual([['mac-2', keystroke]])
  })

  it('client disconnected, link down and local window gone each close that connection\'s streams and kill the execs', async () => {
    socket.fromGateway.client('mac-2', web)
    socket.fromGateway.client('mac-2', null)
    await socket.fromGateway.disconnected('mac-3')
    socket.fromGateway.client('mac-4', web)
    socket.fromGateway.linkDown()
    socket.registerLocalClient('local:w', { sendFrame: () => true, sendBinary: () => true })
    await socket.unregisterLocalClient('local:w')
    expect(streams.closeConnection.mock.calls).toEqual([['mac-2'], ['mac-3'], ['mac-4'], ['local:w']])
  })

  it('the gateway\'s route, lost route and transport error reach the streams', () => {
    socket.fromGateway.browserRoute(STREAM, 'turn')
    socket.fromGateway.browserRouteLost(STREAM)
    socket.fromGateway.browserTransportError()
    expect(streams.route).toHaveBeenCalledWith(STREAM, 'turn')
    expect(streams.routeLost).toHaveBeenCalledWith(STREAM)
    expect(streams.transportError).toHaveBeenCalledTimes(1)
  })

  it('the backend\'s agent_browser_transport_error reaches transportError', async () => {
    await dispatchDown(socket, { type: 'agent_browser_transport_error', payload: { code: 'RATE' } }, '')
    expect(streams.transportError).toHaveBeenCalledTimes(1)
  })
})
