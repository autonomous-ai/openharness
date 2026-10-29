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
    socket.send({ type: 'text_delta', payload: { agentId: 'pm', text: 'private' } })
    socket.send({ type: 'text_delta', payload: { agentId: 'worker', text: 'hello' } })
    expect(broadcast.mock.calls.map(([frame]) => frame)).toEqual([{ type: 'text_delta', payload: { agentId: 'worker', text: 'hello' } }])
  })

  it('leaves a guest to the guest policy, which refuses it first', async () => {
    const { ask, answered } = session('kim@acme.io')
    await ask('message', { agentId: 'worker' })
    expect(answered()).toEqual([{ type: 'message', payload: expect.objectContaining({ error: 'NOT_YOUR_HARNESS' }) }])
  })
})
