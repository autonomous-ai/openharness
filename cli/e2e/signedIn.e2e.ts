/**
 * A signed-in daemon, with every service in its own process (the default), for Claude Code and Codex.
 * Signed in, the core serves under its account's machine id while its services name this computer's,
 * and the core took a service only when the two matched: every service of every signed-in daemon was
 * refused and answered SERVICE_UNAVAILABLE for good. Every other end-to-end test runs signed out, and the
 * release rehearsal found it only when it was asked to sign in (`REHEARSE_SIGNED_IN=1`).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'

type Engine = 'claude' | 'codex'
const MACHINE: FakeMachine = { machineId: 'c3'.repeat(16), computerId: 'e2e-computer-0000-0000-00000000000c', name: 'signed-in', token: 'e2e-token-signed-in' }
/** Every service but the experiments, which start only once they are on (e2e/experiments.e2e.ts). */
const SERVICES = ['search', 'viewers', 'store', 'workspaces', 'usage', 'monitor', 'projects'] as const

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)
async function create(daemon: IsolatedDaemon, client: LocalClient, engine: Engine, folder: string): Promise<Record<string, any>> {
  const cwd = join(daemon.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${folder} to bind its conversation`, async () => {
    const agent = await row(client, created.agent.id)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 500)
}
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  await ended
}

describe('a signed-in daemon', () => {
  let daemon: IsolatedDaemon | undefined
  let backend: FakeBackend | undefined
  afterEach(async () => {
    await daemon?.close(); daemon = undefined
    await backend?.close(); backend = undefined
  })

  it('runs every service in its own process, each taken by the core, and search answers for both engines', async () => {
    backend = await FakeBackend.start()
    backend.addMachine(MACHINE)
    const d = await IsolatedDaemon.create({ env: {
      BACKEND_WS_URL: backend.wsUrl, WEB_URL: backend.httpUrl, ADAPTER_COMPUTER_ID: MACHINE.computerId,
    } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    // Signed in, as `harness login` leaves a computer: a session for its machine on this account.
    writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({
      version: 1, accessToken: MACHINE.token, autonomousEnv: 'prod', computerId: MACHINE.computerId,
      machineId: MACHINE.machineId, expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
    }), { mode: 0o600 })
    await d.start()
    await until('the daemon to connect as the machine\'s node', () => backend!.nodeUp(MACHINE.machineId) || null, 60_000, 250)
    for (const service of SERVICES) {
      await until(`${service} to be taken by the core`, () => d.log().includes(`[service ${service}] connected to the core`) || null, 30_000, 250)
    }
    expect(d.log()).not.toContain('service refused')
    const client = await LocalClient.connect(d, { machineId: MACHINE.machineId })
    for (const engine of ['claude', 'codex'] as const) {
      const agent = await create(d, client, engine, `signed-in-${engine}`)
      await turn(client, agent.id, `a ${engine} turn about the pangolin`)
      await until(`search to find ${engine}'s conversation`, async () => {
        const answer = await client.request('session_search', { query: 'pangolin' }, 30_000)
        expect(answer.error, JSON.stringify(answer)).toBeUndefined()
        return JSON.stringify(answer).includes(agent.sessionId) || null
      }, 60_000, 1_000)
    }
    expect(d.coresStarted()).toBe(1)
    client.close()
  }, 240_000)
})
