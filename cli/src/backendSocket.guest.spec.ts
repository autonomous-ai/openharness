import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackendSocket } from './backendSocket.js'
import type { RemoteClient } from './core/api.js'
import { dispatchDown, gatewayOf, relaySocket, upstreamOf } from './testing/relaySocket.js'

// A guest: a session trusted only because this machine is shared with its account. Its own space, nothing
// of the owner's (docs/plans/2026-10-19-guest-machine-sharing-plan.md, core/guestPolicy.ts).
describe('a guest session', () => {
  const sockets: BackendSocket[] = []
  afterEach(async () => { for (const s of sockets.splice(0)) await s.stop(); vi.restoreAllMocks() })

  const sealed = (type: string, payload: Record<string, unknown> = {}) => ({ type, payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture' } }, clear: { type, payload: { requestId: 'one', ...payload } } })

  /** A relayed `web` session from `remote`: the owner's own app, or `guest`'s. */
  function session(guest?: string, sharedWith = guest) {
    const socket = relaySocket('fixture')
    sockets.push(socket)
    const gw = gatewayOf(socket)
    vi.spyOn(gw.e2ee, 'hasSession').mockReturnValue(true)
    vi.spyOn(gw.e2ee, 'sessionRole').mockReturnValue('web')
    vi.spyOn(gw.e2ee, 'sessionIdentity').mockReturnValue('identity')
    vi.spyOn(gw.e2ee, 'pairedPeers').mockReturnValue([{ identityPub: 'identity', label: 'Mac · kim', pairedAt: 1, role: 'web',
      ...(guest !== undefined ? { shared: true as const, ...(sharedWith ? { sharedWith } : {}) } : {}) }])
    const client: RemoteClient = { role: 'web', label: null, identity: 'identity', direct: false, accountOwner: guest === undefined,
      ...(guest !== undefined ? { guest } : {}) }
    ;(socket as unknown as { remoteClients: Map<string, RemoteClient> }).remoteClients.set('remote', client)
    const replies = vi.spyOn(gw, 'reply').mockImplementation(() => {})
    const ask = async (type: string, payload: Record<string, unknown> = {}) => {
      const frame = sealed(type, payload)
      vi.spyOn(gw.e2ee, 'unwrapDown').mockReturnValue(frame.clear)
      await dispatchDown(socket, { type: frame.type, payload: frame.payload }, 'remote')
    }
    const answered = () => replies.mock.calls.map(([, type, , payload]) => ({ type, payload: payload as Record<string, unknown> }))
    return { socket, gw, ask, answered }
  }

  it('is refused what is not its own, and the service never hears it', async () => {
    const { socket, ask, answered } = session('kim@acme.io')
    const routed = vi.fn(() => true)
    socket.serviceRouter = routed
    await ask('shell', { op: 'open' })
    await ask('fs_list_dir', { path: '/Users/owner' })
    expect(routed).not.toHaveBeenCalled()
    expect(answered()).toEqual([
      { type: 'shell', payload: expect.objectContaining({ error: 'GUEST_NOT_ALLOWED' }) },
      { type: 'fs_list_dir', payload: expect.objectContaining({ error: 'GUEST_NOT_ALLOWED' }) },
    ])
  })

  it('may ask what is allowed, as no owner, saying whose guest it is', async () => {
    const { socket, ask } = session('kim@acme.io')
    const askers: unknown[] = []
    socket.serviceRouter = (_type, _payload, asker, reply) => { askers.push(asker); reply({ ok: true }); return true }
    await ask('usage_read')
    expect(askers).toEqual([expect.objectContaining({ owner: false, guest: 'kim@acme.io' })])
  })

  it('lists only its own harnesses, and opens only their terminals', async () => {
    const { socket, ask, answered } = session('kim@acme.io')
    const lists: unknown[] = []
    socket.agentsProvider = async (_payload, _role, reply, guest) => { lists.push(guest); reply({ agents: [] }) }
    socket.agentGuest = (agentId) => (agentId === 'mine' ? 'kim@acme.io' : null)
    const opened = vi.fn(async () => true)
    ;(socket as unknown as { terminalStreams: unknown }).terminalStreams = { handleFrame: opened, stop: vi.fn() }
    await ask('agents_list')
    expect(lists).toEqual(['kim@acme.io'])
    await ask('terminal_open', { agentId: 'owners' })
    expect(opened).not.toHaveBeenCalled()
    expect(answered().at(-1)).toEqual({ type: 'terminal_open', payload: expect.objectContaining({ error: 'NOT_YOUR_HARNESS' }) })
    await ask('terminal_open', { agentId: 'mine' })
    expect(opened).toHaveBeenCalledWith('remote', 'terminal_open', expect.objectContaining({ agentId: 'mine' }))
  })

  it('the owner\'s own app is still the owner', async () => {
    const { socket, ask } = session()
    const lists: unknown[] = []
    const askers: unknown[] = []
    socket.agentsProvider = async (_payload, _role, reply, guest) => { lists.push(guest); reply({ agents: [] }) }
    socket.serviceRouter = (type, _payload, asker, reply) => { if (type !== 'shell') return false; askers.push(asker); reply({ ok: true }); return true }
    await ask('agents_list')
    await ask('shell')
    expect(lists).toEqual([undefined])
    expect(askers).toEqual([expect.objectContaining({ owner: true })])
  })

  it('manages none of the machine\'s pairings, and joins no trust group: the gateway refuses it', async () => {
    const { ask, answered } = session('kim@acme.io')
    await ask('e2ee_pairings_list')
    await ask('e2ee_pairing_unpair', { identityPub: 'owner-phone' })
    await ask('group_sync')
    expect(answered().map((a) => a.payload)).toEqual([
      expect.objectContaining({ error: 'GUEST_NOT_ALLOWED' }), expect.objectContaining({ error: 'GUEST_NOT_ALLOWED' }), expect.objectContaining({ error: 'GUEST_NOT_ALLOWED' }),
    ])
  })

  it('a share recorded before its account was is still a guest, which owns nothing', async () => {
    const { socket, ask, answered } = session('', '')
    socket.agentGuest = () => ''
    await ask('terminal_open', { agentId: 'any' })
    await ask('e2ee_pairings_list')
    expect(answered().map((a) => a.payload)).toEqual([
      expect.objectContaining({ error: 'NOT_YOUR_HARNESS' }), expect.objectContaining({ error: 'GUEST_NOT_ALLOWED' }),
    ])
  })

  it('the gateway sends a guest\'s event to the group, and sealed to each of that guest\'s sessions', () => {
    const { gw, socket } = session('kim@acme.io')
    vi.spyOn(gw.e2ee, 'guestSessions').mockImplementation((email) => (email === 'kim@acme.io' ? ['g1', 'g2', 'gone'] : []))
    vi.spyOn(gw.e2ee, 'wrapFor').mockImplementation((connId, frame) => (connId === 'gone' ? null : { ...frame, payload: { sealedFor: connId } }))
    const queue = upstreamOf(socket).queue
    const before = queue.length
    gw.broadcast({ type: 'turn_started', agentId: 'mine', payload: {} }, 'kim@acme.io')
    gw.broadcast({ type: 'turn_started', agentId: 'owners', payload: {} })
    const sent = queue.slice(before).map((q) => q.msg as { targetConnId?: string; frame: { payload: unknown } })
    expect(sent.map((m) => m.targetConnId ?? 'group')).toEqual(['group', 'g1', 'g2', 'group'])
    expect(sent[1].frame.payload).toEqual({ sealedFor: 'g1' })
  })

  it('hears its own harnesses\' events sealed for it alone; the owner\'s go to the group only', () => {
    const { socket, gw } = session('kim@acme.io')
    socket.agentGuest = (agentId) => (agentId === 'mine' ? 'kim@acme.io' : null)
    const broadcast = vi.spyOn(gw, 'broadcast')
    socket.send({ type: 'agent_synced', payload: { agent: { id: 'mine' } } })
    socket.send({ type: 'turn_started', agentId: 'mine', payload: {} })
    socket.send({ type: 'agent_deleted', payload: { agentId: 'mine' } })
    socket.send({ type: 'agent_synced', payload: { agent: { id: 'owners' } } })
    socket.send({ type: 'machines_changed', payload: {} })
    expect(broadcast.mock.calls.map(([frame, guest]) => [frame.type, guest])).toEqual([
      ['agent_synced', 'kim@acme.io'], ['turn_started', 'kim@acme.io'], ['agent_deleted', 'kim@acme.io'],
      ['agent_synced', undefined], ['machines_changed', undefined],
    ])
  })

  it('hears a question about its own harness sent to the apps away from this desk; the owner\'s goes to the group only', () => {
    const { socket, gw } = session('kim@acme.io')
    socket.agentGuest = (agentId) => (agentId === 'mine' ? 'kim@acme.io' : null)
    const broadcast = vi.spyOn(gw, 'broadcast')
    socket.sendRemote({ type: 'commander_question', agentId: 'mine', payload: { requestId: 'q1' } })
    socket.sendRemote({ type: 'commander_question', agentId: 'owners', payload: { requestId: 'q2' } })
    expect(broadcast.mock.calls.map(([frame, guest]) => [(frame.payload as { requestId?: unknown }).requestId, guest]))
      .toEqual([['q1', 'kim@acme.io'], ['q2', undefined]])
  })
})
