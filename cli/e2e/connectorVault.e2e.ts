/** The shipped gateway owns connector plaintext; losing it cannot stop a local session. */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, onTestFailed } from 'vitest'
import { b64e, newIdentity } from '../src/lib/e2ee/core.js'
import { Store } from '../src/lib/connectors/store.js'
import { LocalClient } from './harness/client.js'
import { until, type IsolatedDaemon } from './harness/daemon.js'
import { FakeBackend } from './harness/fakeBackend.js'
import { signedInDaemon, writeE2ee } from './harness/fleet.js'

function gateways(daemon: IsolatedDaemon): number[] {
  const owned = new Set([...daemon.log().matchAll(/\[harnessd\] service gateway started \(pid (\d+)\)/g)].map(match => Number(match[1])))
  return execFileSync('ps', ['-A', '-o', 'pid=,command=']).toString().split('\n')
    .map(line => line.trim().match(/^(\d+)\s+harnessd-gateway$/)).filter(match => !!match)
    .map(match => Number(match![1])).filter(pid => owned.has(pid))
}

it('isolates a Refresh interrupted by gateway death, keeps the agent usable, and recovers synchronization', async () => {
  const backend = await FakeBackend.start()
  backend.enableDeviceLog()
  const vault = backend.connectorVault = { revision: 0, envelope: null as unknown, holdReads: false, pendingReads: 0 }
  const identity = newIdentity()
  const spec = { machineId: 'c7'.repeat(16), computerId: 'e2e-computer-connector-vault', name: 'vault-machine', token: 'e2e-vault-token' }
  backend.addMachine(spec)
  const daemon = await signedInDaemon(backend, spec, {
    HARNESSD_SERVICES: 'gateway,connectors',
    HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '20000', HARNESSD_SERVICE_MAX_BACKOFF_MS: '20000',
  })
  let client: LocalClient | undefined
  onTestFailed(() => {
    console.log(daemon.log().split('\n').slice(-100).join('\n'))
    console.log(backend.seen.slice(-30).join('\n'))
  })
  try {
    await writeE2ee(daemon, { 'identity.json': { priv: b64e(identity.priv), pub: b64e(identity.pub) } })
    const store = new Store(join(daemon.env.HOME!, '.harness', 'connections'))
    const canary = 'synthetic-native-vault-canary'
    store.save('custom_fixture', { source: 'custom', access_token: canary, obtained_at: Date.now(),
      mcp_entry: { url: `${backend.httpUrl}/fixture-mcp`, headers: {} } })
    await daemon.start()
    client = await LocalClient.connect(daemon, { machineId: spec.machineId })
    await until('the account log and encrypted vault to be published', () =>
      !!backend.deviceLog!.state.active[b64e(identity.pub)] && vault.revision > 0, 60_000)
    expect(JSON.stringify(vault.envelope)).not.toContain(canary)
    const first = await until('registration to settle and Refresh to succeed', async () => {
      const answer = await client!.request('connectors', { action: 'list', sync: true }, 30_000)
      return answer.error ? null : answer
    }, 60_000)
    expect(first.shared).toBe(true)
    expect(JSON.stringify(first)).not.toContain(canary)

    const cwd = join(daemon.projectsDir, 'connector-vault')
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
    expect(created.error).toBeUndefined()
    const agentId = created.agent.id as string
    await until('the fixture conversation to bind', async () => {
      const rows = await client!.request('agents_list', { includeStopped: true }, 30_000)
      return rows.agents.find((row: { id: string; sessionId?: string }) => row.id === agentId)?.sessionId
    }, 45_000)

    vault.holdReads = true
    const interrupted = client.request('connectors', { action: 'list', sync: true }, 30_000)
    await until('the gateway exchange to reach its held backend read', () => vault.pendingReads > 0, 10_000)
    const pids = gateways(daemon)
    expect(pids).toHaveLength(1)
    process.kill(pids[0]!, 'SIGKILL')
    expect((await interrupted).error).toBeTruthy()
    await until('the gateway process to exit', () => gateways(daemon).length === 0, 5_000)
    const listed = await client.request('connectors', { action: 'list' }, 5_000)
    expect(listed.error).toBeUndefined()
    const ended = client.next(frame => frame.type === 'turn_ended' && frame.agentId === agentId, 45_000, 'local turn with gateway absent')
    client.send('message', { agentId, content: 'local work survives connector sync failure' })
    await ended
    expect(gateways(daemon)).toHaveLength(0)
    expect(store.token('custom_fixture')?.access_token).toBe(canary)

    vault.holdReads = false
    await until('the restarted gateway to synchronize', async () => {
      if (gateways(daemon).length !== 1) return false
      const answer = await client!.request('connectors', { action: 'list', sync: true }, 20_000)
      return !answer.error && answer.shared === true
    }, 60_000)
    expect(daemon.coresStarted()).toBe(1)
    expect(daemon.log()).not.toContain(canary)
  } finally {
    client?.close()
    await daemon.close()
    await backend.close()
  }
})
