import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { expect, it, vi } from 'vitest'
import { BackendSocket, type Frame } from '../backendSocket.js'
import { gatewayOf, relaySocket } from '../testing/relaySocket.js'
import { attachLocalWsServer } from '../localWsServer.js'
import { env } from '../config/env.js'
import { registry } from '../lib/registry.js'
import { b64e, newIdentity } from '../lib/e2ee/core.js'
import { connectWithPassword } from '../lib/e2ee/relayClient.js'
import { MachinePeerStore } from '../lib/e2ee/machinePeers.js'
import { RemoteRelayPool } from '../lib/remoteRelay.js'
import { Team } from './model.js'
import { teamRpc } from './client.js'
import { channelTeamId } from './service.js'

for (const channel of [false, true]) it(`routes ${channel ? 'tab channel' : 'team'} questions and replies through paired encrypted relays`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'team-remote-'))
  const originalPort = env.PORT
  const hosts = [relaySocket('team-owner'), relaySocket('team-peer')]
  const machineIds = ['team-owner', 'team-peer']
  const servers = hosts.map(() => createServer((_req, res) => { res.statusCode = 404; res.end() }))
  const localServers: ReturnType<typeof attachLocalWsServer>[] = []
  const pools: RemoteRelayPool[] = []
  const peers = new MachinePeerStore()
  const sent: Array<{ host: number; agent: string; text: string; id: string }> = []
  const wire: Frame[] = []
  const sockets = new Map<string, WebSocket>()
  const agents = hosts.map((host, i) => {
    host.teamStateDir = join(root, String(i))
    host.teamCommand = 'fixture-harness team'
    const agent = registry.openPendingAgent({ engine: i === 0 ? 'claude' : 'codex', cwd: root,
      runtimes: [{ backend: 'tmux', paneId: `%${920001 + i}` }], defaultName: `peer${i}` })!
    registry.setLaunch(agent.agentId, { state: 'ready' })
    host.onMessage = (agent, text, id) => {
      sent.push({ host: i, agent, text, id: id! })
      host.swarmPromptScopes.prepare(agent, text, undefined, id)
      host.swarmPromptScopes.started(agent, text, 'hook')
      host.teamDelivery({ sessionId: agent, deliveryId: id!, state: 'started' })
    }
    // The fixture substitutes only the cloud's opaque envelope routing and terminal engines.
    // RPC authorization, persistence, input receipts, relay pools, pairing and crypto are real.
    // The relay's side is the gateway's: what it sends one relayed connection, and whether its link is up.
    const gateway = gatewayOf(host) as unknown as { sendTo(connId: string, frame: Frame): void; connected(): boolean }
    const sendTo = gateway.sendTo.bind(gateway)
    vi.spyOn(gateway, 'connected').mockReturnValue(true)
    vi.spyOn(gateway, 'sendTo').mockImplementation((connId, frame) => {
      const socket = sockets.get(connId)
      if (!socket) { sendTo(connId, frame); return }
      wire.push(frame)
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
    })
    return agent
  })
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  let nextConnection = 0
  relay.on('connection', socket => {
    const connId = `team-relay-${++nextConnection}`
    sockets.set(connId, socket)
    let target: BackendSocket | undefined
    socket.on('close', () => { sockets.delete(connId); (target ? gatewayOf(target) : undefined)?.e2ee.dropSession(connId) })
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString()) as Frame
      if (frame.type === 'machine_select') {
        const index = machineIds.indexOf(String((frame.payload as Record<string, unknown>)?.machineId))
        target = hosts[index]
        if (!target) { socket.close(4404); return }
        socket.send(JSON.stringify({ type: 'connected', payload: { machineId: machineIds[index] } }))
      } else if (target) {
        wire.push(frame)
        // The same remote dispatch entry point the gateway's backend link uses.
        ;(gatewayOf(target) as unknown as { enqueueDown(frame: Frame, connId: string, transport: string): void }).enqueueDown(frame, connId, 'relay')
      }
    })
  })
  try {
    await new Promise<void>((resolve, reject) => { relay.once('listening', resolve); relay.once('error', reject) })
    const base = `ws://127.0.0.1:${(relay.address() as AddressInfo).port}`
    const password = 'disposable-team-fixture-password'
    for (let i = 0; i < 2; i++) {
      const identity = newIdentity()
      const remote = 1 - i
      await gatewayOf(hosts[remote]).setRemotePassword(password)
      const paired = await connectWithPassword({ targetMachineId: machineIds[remote], password, selfIdentity: identity,
        accessToken: 'synthetic-test-token', backendWsBase: base, autonomousEnv: 'prod', timeoutMs: 5000 })
      expect(paired.ok).toBe(true)
      if (!paired.ok) throw new Error('Fixture pairing failed')
      peers.pin(machineIds[remote], b64e(paired.peerPub), 'disposable team fixture')
      const pool = new RemoteRelayPool({ accessToken: async () => 'synthetic-test-token' } as never,
        base, identity, peers, { p2p: false, lingerMs: 20 })
      pools.push(pool)
      localServers.push(attachLocalWsServer(servers[i], { machineId: machineIds[i], backend: hosts[i], relayPool: pool, autonomousEnv: 'prod' }))
      await new Promise<void>((resolve, reject) => { servers[i].once('error', reject); servers[i].listen(0, '127.0.0.1', resolve) })
    }
    const ports = servers.map(server => (server.address() as AddressInfo).port)
    // The owner daemon resolves remote runtime/delivery RPCs through its own local API.
    env.PORT = ports[0]
    const call = (fromHost: number, payload: Record<string, unknown>) => teamRpc({ port: ports[fromHost], machineId: machineIds[0] }, 'team', payload, 7000)
    const teamId = channel ? channelTeamId('device') : '3'.repeat(32), questionId = '4'.repeat(32)
    const question = 'PRIVATE_REMOTE_QUESTION: which endpoint serves daemon state?'
    const answer = 'PRIVATE_REMOTE_ANSWER: GET /api/daemons.'
    if (channel) {
      for (const host of hosts) host.readChannelDesk = async () => ({ enabled: true, settingsRevision: 1, revision: 1, tabs: [{ id: 'device', name: 'Device', channelHost: machineIds[0],
        panes: agents.map((agent, i) => ({ machineId: machineIds[i], agentId: agent.agentId })) }] })
      // Both real daemon lifecycles read the account opt-in before writing input.
      // Neither endpoint relies on a manual consult to initialize collaboration.
      for (const host of hosts) host.startTeams()
      await call(1, { action: 'channel_get', tabId: 'device' })
    } else {
      await call(0, { action: 'create', id: teamId, name: 'Paired teammates',
        members: agents.map((agent, i) => ({ machineId: machineIds[i], agentId: agent.agentId, name: `peer${i}` })) })
    }
    const members = Team.parse(JSON.parse(readFileSync(join(root, '0', 'ledgers', `${teamId}.json`), 'utf8'))).members
    if (channel) {
      await expect(call(0, { action: 'members', teamId, memberKey: members[0].key })).rejects.toThrow('current task')
      hosts[0].swarmPromptScopes.prepare(agents[0].agentId, 'Task submitted in Device', 'device')
      hosts[0].swarmPromptScopes.started(agents[0].agentId, 'Task submitted in Device', 'hook')
    }
    await call(0, { action: 'ask', teamId, id: questionId, memberKey: members[0].key, to: members[1].id, text: question })
    await vi.waitFor(() => expect(sent.filter(s => s.id.endsWith(':question'))).toHaveLength(1), { timeout: 9000 })
    expect(sent.find(s => s.id.endsWith(':question'))).toMatchObject({ host: 1, agent: agents[1].agentId })
    if (channel) {
      // The swarm host verifies scope on the recipient's different, paired machine.
      expect(await call(1, { action: 'members', teamId, memberKey: members[1].key })).toHaveProperty('members')
    }
    // The recipient's CLI runs against its own daemon, which relays back to the team owner.
    await call(1, { action: 'reply', teamId, questionId, memberKey: members[1].key, text: answer })
    await call(1, { action: 'reply', teamId, questionId, memberKey: members[1].key, text: answer })
    if (channel) expect(hosts[1].swarmPromptScopes.current(agents[1].agentId)).toBeNull()
    await vi.waitFor(() => expect(sent.filter(s => s.id.endsWith(':answer'))).toHaveLength(1), { timeout: 9000 })
    expect(sent.find(s => s.id.endsWith(':answer'))).toMatchObject({ host: 0, agent: agents[0].agentId })
    await vi.waitFor(async () => {
      const result = await call(1, { action: 'get', teamId })
      expect((result.team as Team).exchanges[0]).toMatchObject({ state: 'answered', answer: { text: answer, origin: 'agent' }, continuation: { state: 'started' } })
    }, { timeout: 9000 })
    const opaque = JSON.stringify(wire)
    for (const secret of [question, answer, ...members.map(m => m.key)]) expect(opaque).not.toContain(secret)
    for (const type of ['team', 'team_result', 'team_delivery', 'team_delivery_result']) {
      expect(wire.some(frame => frame.type === type && (frame.payload as Record<string, unknown>)?.__e2e)).toBe(true)
    }
  } finally {
    env.PORT = originalPort
    await Promise.allSettled(hosts.map(host => host.stop()))
    await Promise.allSettled(localServers.map(server => server.close()))
    for (const pool of pools) for (const id of machineIds) { pool.invalidate(id); pool.invalidateIsolated(id) }
    for (const socket of relay.clients) socket.terminate()
    await new Promise<void>(resolve => relay.close(() => resolve()))
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))))
    for (const id of machineIds) peers.unlink(id)
    for (const agent of agents) registry.removeAgent(agent.agentId)
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  }
}, 35000)
