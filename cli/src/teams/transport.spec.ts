import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { BackendSocket } from '../backendSocket.js'
import { attachLocalWsServer } from '../localWsServer.js'
import { registry } from '../lib/registry.js'
import { Team } from './model.js'
import { teamRpc } from './client.js'

it('runs create, ask, explicit reply, and continuation through the real daemon WebSocket', async () => {
  const root = mkdtempSync(join(tmpdir(), 'team-transport-'))
  const backend = new BackendSocket('team-fixture')
  backend.teamStateDir = root
  backend.teamCommand = 'fixture-harness team'
  const sent: Array<{ agent: string; text: string; id: string }> = []
  backend.onMessage = (agent, text, id) => {
    sent.push({ agent, text, id: id! })
    backend.teamDelivery({ sessionId: agent, deliveryId: id!, state: 'started' })
  }
  const agents = ['claude', 'codex'].map((engine, i) => {
    const agent = registry.openPendingAgent({ engine: engine as 'claude' | 'codex', cwd: root,
      runtimes: [{ backend: 'tmux', paneId: `%${910001 + i}` }], defaultName: engine })!
    registry.setLaunch(agent.agentId, { state: 'ready' })
    return agent
  })
  const server = createServer((_req, res) => { res.statusCode = 404; res.end() })
  const local = attachLocalWsServer(server, { machineId: 'team-fixture', backend })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  const call = (payload: Record<string, unknown>) => teamRpc({ port, machineId: 'team-fixture' }, 'team', payload, 3000)
  const teamId = '1'.repeat(32), questionId = '2'.repeat(32)
  try {
    const created = await call({ action: 'create', id: teamId, name: 'Real transport',
      members: agents.map((a, i) => ({ machineId: 'team-fixture', agentId: a.agentId, name: `peer${i}` })) })
    expect(JSON.stringify(created)).not.toContain('"key"')
    const members = Team.parse(JSON.parse(readFileSync(join(root, 'ledgers', `${teamId}.json`), 'utf8'))).members
    const ask = { action: 'ask', teamId, memberKey: members[0].key, to: 'peer1', text: 'What is the protocol?', id: questionId }
    await call(ask)
    // Each RPC opens a fresh client, just like reconnecting after a lost reply.
    await call(ask)
    await vi.waitFor(() => expect(sent.filter(s => s.id.endsWith(':question'))).toHaveLength(1), { timeout: 7000 })
    expect(sent.find(s => s.id.endsWith(':question'))?.agent).toBe(agents[1].agentId)
    await expect(call({ action: 'reply', teamId, memberKey: members[0].key, questionId, text: 'spoof' })).rejects.toThrow('addressed teammate')
    await call({ action: 'reply', teamId, memberKey: members[1].key, questionId, text: 'team.v1' })
    await vi.waitFor(() => expect(sent.filter(s => s.id.endsWith(':answer'))).toHaveLength(1), { timeout: 7000 })
    expect(sent.find(s => s.id.endsWith(':answer'))?.agent).toBe(agents[0].agentId)
    const result = await call({ action: 'get', teamId })
    expect((result.team as any).exchanges).toHaveLength(1)
    expect((result.team as any).exchanges[0].answer).toMatchObject({ text: 'team.v1', origin: 'agent' })
    const controller = new AbortController()
    controller.abort()
    await expect(teamRpc({ port, machineId: 'team-fixture', signal: controller.signal }, 'team', { action: 'get', teamId })).rejects.toThrow('view was closed')
    expect(sent.filter(s => s.id.endsWith(':question'))).toHaveLength(1)
  } finally {
    await local.close()
    await backend.stop()
    await new Promise<void>(resolve => server.close(() => resolve()))
    for (const agent of agents) registry.removeAgent(agent.agentId)
    rmSync(root, { recursive: true, force: true })
  }
}, 20000)
