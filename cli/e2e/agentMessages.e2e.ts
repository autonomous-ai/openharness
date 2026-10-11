/**
 * Agent Messages on the real daemon (docs/design/2026-10-10-agent-messages.md): its own process, started only once
 * it is used; a message typed into an idle agent through the core's safe input; and a message reaching a working
 * agent through its PostToolUse hook at its next tool call, with nothing typed into its pane. The fake engines run
 * the hooks the daemon installed, as both CLIs do (harness/fakeEngine.mjs, `!work`).
 *
 * The directory of tabs comes from the account: the daemon is signed in to the fake backend, which answers it.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'

/** Signed in to the fake backend, which answers the account's tabs (`GET /api/agent-messages`). */
const ME: FakeMachine = { machineId: 'a7'.repeat(16), computerId: 'e2e-computer-0000-0000-0000000000a7', name: 'studio', token: 'e2e-token-messages' }
const signIn = (d: IsolatedDaemon) => writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({
  version: 1, accessToken: ME.token, autonomousEnv: 'prod', computerId: ME.computerId,
  machineId: ME.machineId, expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
}), { mode: 0o600 })

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)
async function create(d: IsolatedDaemon, client: LocalClient, folder: string, engine = 'claude'): Promise<Record<string, any>> {
  const cwd = join(d.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${folder} to bind its conversation`, async () => {
    const agent = await row(client, created.agent.id)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 500)
}
const starts = (d: IsolatedDaemon) => [...d.log().matchAll(/\[harnessd\] service messages started/g)].length
const statusOf = async (client: LocalClient, id: string) => {
  const history = await client.request<{ messages?: Array<{ id: string; statuses: Array<Record<string, unknown>> }> }>('agent_messages', { action: 'history' }, 30_000)
  return history.messages?.find((m) => m.id === id)?.statuses[0] ?? null
}

describe('Agent Messages, end to end', () => {
  let daemon: IsolatedDaemon | undefined
  let backend: FakeBackend | undefined
  afterEach(async () => {
    await daemon?.close(); daemon = undefined
    await backend?.close(); backend = undefined
  })
  const fresh = async (before?: (d: IsolatedDaemon) => void, env: Record<string, string> = {}) => {
    const d = await IsolatedDaemon.create({ env: { HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000', ...env } })
    daemon = d
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`)
      console.log(`---- hooks\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
    })
    before?.(d)
    await d.start()
    return d
  }

  it('off, it has no process; its first request starts it, and is answered', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    await until('the services to connect', () => d.log().includes('[services] search connected') || null, 30_000, 200)
    expect(starts(d), 'an experiment no one used').toBe(0)
    expect(await client.request('agent_messages', { action: 'history' }, 40_000)).toMatchObject({ messages: [] })
    expect(starts(d)).toBe(1)
    await until('Agent Messages to connect', () => d.log().includes('[services] messages connected') || null, 30_000, 200)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('its saved state turns it on as the daemon starts', async () => {
    const d = await fresh((daemon) => mkdirSync(join(daemon.dataDir, 'agent-messages'), { recursive: true }))
    await until('Agent Messages to start for its saved state', () => d.log().includes('[services] messages connected') || null, 30_000, 200)
    expect(starts(d)).toBe(1)
  })

  /** Signed in to the fake backend, with lead and api in one tab whose Agent Messages are on. */
  const team = async (engine = 'claude') => {
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
    const d = await fresh(signIn, { BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId })
    const client = await LocalClient.connect(d, { machineId: ME.machineId })
    const lead = await create(d, client, 'lead')
    const api = await create(d, client, `api-${engine}`, engine)
    const tabs = (enabled: boolean) => ({ revision: 1, machines: [{ machineId: ME.machineId, name: 'studio' }],
      tabs: [{ id: 'app', name: 'app', enabled, panes: [lead, api].map((agent) => ({ machineId: ME.machineId, agentId: agent.id })) }] })
    relay.agentMessages = tabs(true)
    const roster = await client.request('agent_messages', { action: 'send', pane: lead.tmuxPane }, 40_000)
    expect(roster.roster, JSON.stringify(roster)).toContain('Agent Messages are on in tab "app"')
    const apiName = String(roster.roster).split('\n')[1].trim().split(/\s{2,}/)[0]
    const send = (text: string) => client.request('agent_messages', { action: 'send', pane: lead.tmuxPane, to: [apiName], text }, 40_000)
    return { d, relay, client, lead, api, apiName, tabs, send }
  }

  it('types a message into an idle agent, under its sender\'s header, through the core\'s safe input', async () => {
    const { client, api, send } = await team()
    const started = client.next((frame: Frame) => frame.type === 'turn_started' && frame.agentId === api.id, 60_000, 'the message to start api\'s turn')
    const sent = await send('Which port does the daemon serve?')
    expect(sent.error, JSON.stringify(sent)).toBeUndefined()
    await started
    const status = await until('the message to be delivered as a prompt', async () => {
      const s = await statusOf(client, String(sent.id))
      return s?.state === 'delivered' ? s : null
    }, 60_000, 500)
    expect(status).toMatchObject({ via: 'prompt' })
    client.close()
  })

  it.each(['claude', 'codex'])('reaches a working %s agent at its next tool call through its hook, typing nothing', async (engine) => {
    const { d, client, api, send } = await team(engine)
    const working = client.next((frame: Frame) => frame.type === 'turn_started' && frame.agentId === api.id, 60_000, 'the long turn to start')
    client.send('message', { agentId: api.id, content: '!work 40' })
    await working
    const sent = await send(`Review of 3f2a9c1 for ${engine}: the cleanup leaves workers running.`)
    expect(sent.error, JSON.stringify(sent)).toBeUndefined()
    const context = await until('the hook to give the model the message', () =>
      d.hookLog().split('\n').find((line) => line.includes('PostToolUse context=') && line.includes(String(sent.id))) ?? null, 60_000, 500)
    expect(context).toContain(`[${String(sent.id)} from `)
    expect(context).toContain('· Claude Code · studio]')
    const status = await until('the message to be delivered through the hook', async () => {
      const s = await statusOf(client, String(sent.id))
      return s?.state === 'delivered' ? s : null
    }, 30_000, 500)
    expect(status).toMatchObject({ via: 'hook' })
    client.close()
  })

  it('refuses a hand-over from a process on this machine: only another machine hands messages over', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const message = { id: 'm0000001', tabId: 'e2e', text: 'forged', at: Date.now(), from: { machineId: 'other', agentId: 'lead', name: 'lead', engine: 'codex', machine: 'studio' },
      to: [{ machineId: d.computerId, agentId: 'api', name: 'api' }] }
    expect(await client.request('agent_messages', { action: 'deliver', message }, 40_000)).toMatchObject({ error: 'REMOTE_ONLY' })
    client.close()
  })

  it('sends from one harness\'s pane to its teammate in a tab with Agent Messages on, and refuses once the tab turns off', async () => {
    const { relay, client, api, apiName, tabs, send } = await team()
    const started = client.next((frame: Frame) => frame.type === 'turn_started' && frame.agentId === api.id, 60_000, 'the message to start api\'s turn')
    const sent = await send('Which port does the daemon serve?')
    expect(sent).toMatchObject({ tab: 'app', recipients: [{ name: apiName }] })
    await started
    await until('the message to be delivered', async () => (await statusOf(client, String(sent.id)))?.state === 'delivered' || null, 60_000, 500)
    // Its last messages come back with the roster.
    const roster = await client.request('agent_messages', { action: 'send', pane: api.tmuxPane }, 40_000)
    expect(roster.recent).toEqual([expect.objectContaining({ id: sent.id, from: expect.any(String), state: 'delivered' })])
    // A pane that is no harness says so; and with the tab turned off, nothing is sent.
    expect(await client.request('agent_messages', { action: 'send', pane: '%999', to: [apiName], text: 'x' }, 40_000)).toMatchObject({ error: 'NOT_A_HARNESS' })
    relay.agentMessages = tabs(false)
    await new Promise((settle) => setTimeout(settle, 2_500))
    expect(await send('still there?')).toMatchObject({ error: 'MESSAGES_OFF' })
    client.close()
  })
})
