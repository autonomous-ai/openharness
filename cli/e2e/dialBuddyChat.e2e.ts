/**
 * The desktop follows the round dial into Buddy chats (Diego, 10-30), end to end: the real daemon on a throwaway home, a
 * fake backend serving one Swarm whose reader has a Buddy running on this machine, a fake round dial that speaks the Swarm
 * cards and Buddy screens on a pseudo-terminal, and a window on the local socket. The cards travel the production path,
 * read by the Super Tab service, checked on their way into the core and handed to the devices process, which once lost
 * the Buddy's session id there and left a tap on its notification opening a terminal tab. What the window is told is
 * checked: the Buddy chat for the Buddy side and the Buddy's tap, the Lead chat for the PM side, a tile for any other agent,
 * and the Buddy's session id never on the cable.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import { FakeDial, type DialMessage } from './harness/fakeDial.js'
import { overOldRoutes } from './harness/swarmReads.js'

const ME: FakeMachine = { machineId: 'c9'.repeat(16), computerId: 'e2e-dial-buddy-computer', name: 'Fixture', token: 'e2e-dial-buddy-token' }
const TAB = 'dial-buddy-tab'
const PERSON = { id: 'person-me', email: 'me@example.test' }
const ROUND = { swarmCard: 'v1', superTab: 'wait-v1', swarmChat: 'v1', swarmBuddy: 'v1' }

let daemon: IsolatedDaemon | undefined, backend: FakeBackend | undefined, dial: FakeDial | undefined
const clients: LocalClient[] = []
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close())
  await daemon?.close(); daemon = undefined
  await dial?.close(); dial = undefined
  await backend?.close(); backend = undefined
})

it('opens the Buddy chat for the Buddy side and the Buddy\'s tap, the Lead chat for the PM side, and a tile for any other agent', async () => {
  const relay = await FakeBackend.start(); backend = relay; relay.addMachine(ME); relay.me = PERSON
  const device = await FakeDial.open({ capabilities: ROUND }); dial = device
  const d = await IsolatedDaemon.create({ env: {
    CABLE_DISABLE: 'false', HARNESSD_TEST_DIAL_PORT: device.path,
    BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId,
    ANTHROPIC_API_KEY: 'fixture-not-a-credential', OPENAI_API_KEY: 'fixture-not-a-credential',
  } }); daemon = d
  writeFileSync(join(d.engineConfig.codexHome, 'models_cache.json'), readFileSync(join(CLI_ROOT, 'src/lib/__fixtures__/codex-home-0.160/models_cache.json')))
  writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token,
    autonomousEnv: 'prod', computerId: ME.computerId, machineId: ME.machineId,
    expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
  }), { mode: 0o600 })
  onTestFailed(() => {
    console.log(`---- daemon log\n${d.log().split('\n').slice(-160).join('\n')}`)
    console.log(`---- the dial heard\n${device.messages.map((m) => m.t).join(' ')}`)
    console.log(`---- backend saw\n${relay.seen.slice(-40).join('\n')}`)
  })
  await d.start()
  // A signed-in daemon serves under its account's machine id.
  const window = await LocalClient.connect(d, { machineId: ME.machineId }); clients.push(window)

  // Two agents here: the reader's Buddy, and an ordinary one the Swarm does not know.
  const create = async (folder: string): Promise<string> => {
    const cwd = join(d.projectsDir, folder)
    mkdirSync(cwd, { recursive: true })
    const created = await window.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const id = created.agent.id as string
    await until(`${folder} to bind`, async () => ((await window.request('agents_list', {})).agents as Array<Record<string, unknown>>)
      .find((agent) => agent.id === id)?.sessionId || null, 60_000, 500)
    return id
  }
  const buddyHarness = await create('buddy'), ordinary = await create('ordinary')

  // The Swarm: one project, its Lead on another machine, and the reader's Buddy chat with the Buddy running here.
  const state = {
    name: 'Dial Buddy', paused: false, ownerId: PERSON.id, buddies: true, people: [{ id: PERSON.id, email: PERSON.email }],
    projects: [{ id: 'web', name: 'web', leadConversationId: 'lead-web' }],
    agents: [
      { id: 'lead1', harnessId: 'lead-harness', machineId: 'd0'.repeat(16), machineOwnerId: PERSON.id, configuration: { engine: 'claude' } },
      { id: 'buddy1', name: "me's Buddy", harnessId: buddyHarness, machineId: ME.machineId, machineOwnerId: PERSON.id,
        projectId: 'web', buddyOf: { personId: PERSON.id, generation: 'g1' }, configuration: { engine: 'claude' } },
    ],
    conversations: [
      { id: 'lead-web', projectId: 'web', leadId: 'lead1', archived: false, assignment: null, lastMessageSequence: 0 },
      { id: 'buddy-web', projectId: 'web', kind: 'buddy', buddyOwnerId: PERSON.id, agentIds: ['buddy1'], leadId: null, archived: false, assignment: null, lastMessageSequence: 0 },
    ],
  }
  relay.superTabs = overOldRoutes(async (method, raw) => {
    const path = new URL(raw, relay.httpUrl).pathname
    if (method !== 'GET') return { status: 404, error: { code: 'NOT_FOUND', message: 'Not in this fixture.' } }
    if (path.startsWith(`/api/super-tabs/hosts/${ME.machineId}`)) return { data: [] }
    if (path === '/api/super-tabs') return { data: { tabs: [{ id: TAB, name: state.name, revision: 1 }], next: null } }
    if (path === `/api/super-tabs/${TAB}`) return { data: { state, revision: 1 } }
    if (path.startsWith(`/api/super-tabs/${TAB}/`)) return { data: { messages: [], conversations: [] } }
    return { status: 404, error: { code: 'NOT_FOUND', message: 'Not in this fixture.' } }
  })

  await device.greet()
  const cards = await device.next((m) => m.t === 'supertab' && Array.isArray(m.leads) && (m.leads as DialMessage[]).some((l) => l.buddy), 60_000, 'the Swarm card with its Buddy')
  // The Buddy's session id stays on this computer: no frame to the dial carries it.
  expect(JSON.stringify(device.messages)).not.toContain(buddyHarness)
  expect(cards.id).toBe(TAB)

  const told = (since: number) => window.frames.slice(since).filter((f) => f.type === 'dial_super_tab' || f.type === 'dial_open')
  // The dial picks the project, swipes to the Buddy side, and back to the PM.
  let since = window.frames.length
  device.send({ t: 'supertab.select', tab: TAB, lead: 'lead1' })
  await window.waitFor((f) => f.type === 'dial_super_tab', 15_000, 'the pick', since)
  since = window.frames.length
  device.send({ t: 'supertab.side', tab: TAB, side: 'buddy' })
  await window.waitFor((f) => f.type === 'dial_super_tab', 15_000, 'the Buddy side', since)
  expect(told(since).map((f) => f.payload)).toEqual([{ superTabId: TAB, projectId: 'web', chat: 'buddy' }])
  since = window.frames.length
  device.send({ t: 'supertab.side', tab: TAB, side: 'pm' })
  await window.waitFor((f) => f.type === 'dial_super_tab', 15_000, 'the PM side', since)
  expect(told(since).map((f) => f.payload)).toEqual([{ superTabId: TAB, projectId: 'web', chat: 'pm' }])

  // A tap on the Buddy's notification: its chat in the Swarm tab, and no tile.
  since = window.frames.length
  device.send({ t: 'agent.open', agentId: buddyHarness })
  await window.waitFor((f) => f.type === 'dial_super_tab' || f.type === 'dial_open', 15_000, 'the Buddy\'s tap', since)
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(told(since).map((f) => [f.type, f.payload])).toEqual([['dial_super_tab', { superTabId: TAB, projectId: 'web', chat: 'buddy' }]])

  // Any other agent: a tile, as today.
  since = window.frames.length
  device.send({ t: 'agent.open', agentId: ordinary })
  await window.waitFor((f) => f.type === 'dial_open', 15_000, 'the ordinary tap', since)
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(told(since).map((f) => [f.type, f.payload?.agentId])).toEqual([['dial_open', ordinary]])
})
