import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackendSocket } from './backendSocket.js'
import type { RemoteAppPolicy, RemoteClient } from './core/api.js'
import { dispatchDown, gatewayOf, relaySocket } from './testing/relaySocket.js'

// The account's own apps on a Harness Team daemon (#895, superTabs/inCore/teamApps.ts): the socket asks the policy
// before anything else answers, shows them its replies as the policy filters them, and withholds the events it withholds.
// Its rules are teamApps.spec.ts's; here, that the socket keeps to them on each path.
describe('the account\'s own apps under a remote app policy', () => {
  const sockets: BackendSocket[] = []
  afterEach(async () => { for (const s of sockets.splice(0)) await s.stop(); vi.restoreAllMocks() })

  /** A policy that hides the agent `pm` and refuses `message`. */
  const policy: RemoteAppPolicy = {
    refuse: (type, payload) => payload.agentId === 'pm' ? { error: 'SWARM_CONFIDENTIAL', message: 'hidden' }
      : type === 'message' ? { error: 'TEAM_READ_ONLY', message: 'read only' } : null,
    reply: (_type, payload) => Array.isArray(payload.agents) ? { ...payload, agents: (payload.agents as Array<{ id: string }>).filter(a => a.id !== 'pm') } : payload,
    event: (frame) => (frame.payload as { agentId?: unknown } | undefined)?.agentId === 'pm' ? null : frame,
    watchOnly: () => true,
    isConfidential: (id) => id === 'pm',
  }

  function session(guest?: string) {
    const socket = relaySocket('fixture')
    sockets.push(socket)
    socket.remoteAppPolicy = policy
    const gw = gatewayOf(socket)
    vi.spyOn(gw.e2ee, 'hasSession').mockReturnValue(true)
    vi.spyOn(gw.e2ee, 'sessionRole').mockReturnValue('web')
    vi.spyOn(gw.e2ee, 'sessionIdentity').mockReturnValue('identity')
    vi.spyOn(gw.e2ee, 'pairedPeers').mockReturnValue([{ identityPub: 'identity', label: 'Mac · owner', pairedAt: 1, role: 'web',
      ...(guest !== undefined ? { shared: true as const, sharedWith: guest } : {}) }])
    const client: RemoteClient = { role: 'web', label: null, identity: 'identity', direct: false, accountOwner: guest === undefined, ...(guest !== undefined ? { guest } : {}) }
    ;(socket as unknown as { remoteClients: Map<string, RemoteClient> }).remoteClients.set('remote', client)
    const replies = vi.spyOn(gw, 'reply').mockImplementation(() => {})
    const ask = async (type: string, payload: Record<string, unknown> = {}) => {
      const clear = { type, payload: { requestId: 'one', ...payload } }
      vi.spyOn(gw.e2ee, 'unwrapDown').mockReturnValue(clear)
      await dispatchDown(socket, { type, payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture' } } }, 'remote')
    }
    const answered = () => replies.mock.calls.map(([, type, , payload]) => ({ type, payload: payload as Record<string, unknown> }))
    return { socket, gw, ask, answered }
  }

  it('refuses what the policy refuses, before a service or a terminal stream hears it', async () => {
    const { socket, ask, answered } = session()
    const routed = vi.fn(() => true)
    socket.serviceRouter = routed
    const opened = vi.fn(async () => true)
    ;(socket as unknown as { terminalStreams: unknown }).terminalStreams = { handleFrame: opened, stop: vi.fn() }
    await ask('terminal_open', { agentId: 'pm' })
    await ask('message', { agentId: 'worker', text: 'cat ~/.claude' })
    expect(opened).not.toHaveBeenCalled()
    expect(routed).not.toHaveBeenCalled()
    expect(answered()).toEqual([
      { type: 'terminal_open', payload: { error: 'SWARM_CONFIDENTIAL', message: 'hidden' } },
      { type: 'message', payload: { error: 'TEAM_READ_ONLY', message: 'read only' } },
    ])
    await ask('terminal_open', { agentId: 'worker' })
    expect(opened).toHaveBeenCalledWith('remote', 'terminal_open', expect.objectContaining({ agentId: 'worker' }))
  })

  it('shows its replies as the policy filters them', async () => {
    const { socket, ask, answered } = session()
    socket.agentsProvider = async (_payload, _role, reply) => { reply({ agents: [{ id: 'pm' }, { id: 'worker' }] }) }
    await ask('agents_list')
    expect(answered()).toEqual([{ type: 'agents_list', payload: { agents: [{ id: 'worker' }] } }])
  })

  it('withholds from the apps the events the policy withholds, and still tells the windows here', async () => {
    const { socket, gw } = session()
    const broadcast = vi.spyOn(gw, 'broadcast').mockImplementation(() => {})
    socket.send({ type: 'text_delta', payload: { agentId: 'pm', content: 'private' } })
    socket.send({ type: 'text_delta', payload: { agentId: 'worker', content: 'hello' } })
    expect(broadcast.mock.calls.map(([frame]) => frame)).toEqual([{ type: 'text_delta', payload: { agentId: 'worker', content: 'hello' } }])
  })

  it('holds the account\'s own apps to watching their terminals, and no guest, window here or daemon without a policy', () => {
    const { socket } = session()
    expect(socket.appWatchOnly('remote')).toBe(true)
    expect(socket.appWatchOnly('')).toBe(false)
    // A remote connection with no client record fails closed.
    expect(socket.appWatchOnly('unknown-connection')).toBe(true)
    socket.remoteAppPolicy = null
    expect(socket.appWatchOnly('remote')).toBe(false)
    expect(session('kim@acme.io').socket.appWatchOnly('remote')).toBe(false)
  })

  // Security re-review of #2089: turn cards, agent questions and commander events go to the account's paired devices
  // through sendCommander, and a Team daemon seals them for the Mac owner's devices.
  it('withholds from the account\'s paired devices and its browsers what the policy withholds', () => {
    const { socket, gw } = session()
    const commander = vi.spyOn(gw, 'commander').mockImplementation(() => {})
    const user = vi.spyOn(gw, 'user').mockImplementation(() => {})
    socket.sendCommander({ type: 'question', payload: { agentId: 'pm', question: 'Approve the launch slip?' } })
    socket.sendCommander({ type: 'turn_card', payload: { agentId: 'worker', recap: 'Tests pass.' } })
    socket.sendUser({ type: 'notice', payload: { agentId: 'pm' } })
    socket.sendUser({ type: 'notice', payload: { agentId: 'worker' } })
    expect(commander.mock.calls.map(([frame]) => (frame as { payload: { agentId: string } }).payload.agentId)).toEqual(['worker'])
    expect(user.mock.calls.map(([frame]) => (frame as { payload: { agentId: string } }).payload.agentId)).toEqual(['worker'])
  })

  // Security re-check 2 of #2089: the relay seals the Wi-Fi device's frames before the socket sees them, its events name
  // their agent a level down, and its own doors (core/wifiAgents.ts) never ask the policy. On a Team daemon it is off.
  it('with the Wi-Fi device off, hands it none of the relay\'s sessions or requests, and sends it nothing', async () => {
    const { socket, gw } = session()
    const wifi = { session: vi.fn(), dropped: vi.fn(), request: vi.fn(), revoked: vi.fn() }
    socket.disableWifi()
    socket.useWifi(wifi as never)
    const device = vi.spyOn(gw, 'device').mockImplementation(() => true)
    // As the gateway hands them on: a device session, its sealed request opened, its revocation.
    socket.fromGateway.client('dial-1', { role: 'device', label: 'Wi-Fi device', identity: 'dial', direct: true, accountOwner: true })
    await socket.fromGateway.device?.('dial-1', { type: 'e2e', payload: {} }, { type: 'wifi_view', payload: { requestId: 'v1' } })
    socket.fromGateway.deviceRevoked?.('dial')
    await socket.fromGateway.disconnected('dial-1')
    socket.deviceFrame('dial-1', 'wifi_view_result', { agents: [{ agentId: 'worker' }] })
    expect([wifi.session, wifi.request, wifi.revoked, wifi.dropped].map(f => f.mock.calls.length)).toEqual([0, 0, 0, 0])
    expect(device).not.toHaveBeenCalled()
  })

  it('closes a confidential session\'s terminal to the account\'s own apps, unknown connections too, and to no guest or window here', () => {
    const { socket } = session()
    expect([socket.appClosedTo('remote', 'pm'), socket.appClosedTo('remote', 'worker'), socket.appClosedTo('unknown-connection', 'pm')]).toEqual([true, false, true])
    expect(socket.appClosedTo('', 'pm')).toBe(false)
    expect(session('kim@acme.io').socket.appClosedTo('remote', 'pm')).toBe(false)
    socket.remoteAppPolicy = null
    expect(socket.appClosedTo('remote', 'pm')).toBe(false)
  })

  it('leaves a guest to the guest policy, which refuses it first', async () => {
    const { ask, answered } = session('kim@acme.io')
    await ask('message', { agentId: 'worker' })
    expect(answered()).toEqual([{ type: 'message', payload: expect.objectContaining({ error: 'NOT_YOUR_HARNESS' }) }])
  })
})
