/** Saved API edits reach real launch callers through the Models process, without contacting a provider. */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon } from './harness/daemon.js'

const oldKey = 'fixture-old-api-key', newKey = 'fixture-new-api-key'
const oldBase = 'https://old-api.example.test/v1', newBase = 'https://new-api.example.test/v1'
let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined
afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })

async function fresh() {
  const d = daemon = await IsolatedDaemon.create()
  onTestFailed(() => console.log(d.log()))
  await d.start()
  const c = client = await LocalClient.connect(d)
  const saved = await c.request('api_connections', { action: 'save', connection: {
    provider: 'custom', name: 'Launch fixture', baseUrl: oldBase, apiKey: oldKey,
  } }, 30_000)
  expect(saved.error).toBeUndefined()
  expect(saved.connections).toHaveLength(1)
  const connection = saved.connections[0] as Record<string, unknown> & { id: string }
  const grid = { networkId: `api:${connection.id}`, networkName: 'Launch fixture', baseUrl: oldBase,
    apiKey: oldKey, model: 'fixture-model' }
  expect(d.servicePids('models').length).toBeGreaterThan(0)
  return { d, c, connection, grid }
}

async function rotate(c: LocalClient, connection: Record<string, unknown>) {
  const answer = await c.request('api_connections', { action: 'save', connection: {
    ...connection, name: 'Edited fixture', baseUrl: newBase, apiKey: newKey,
  } }, 30_000)
  expect(answer.error).toBeUndefined()
}

function folder(d: IsolatedDaemon, name: string) {
  const cwd = join(d.projectsDir, name)
  mkdirSync(cwd, { recursive: true })
  return cwd
}

async function ready(c: LocalClient, id: string, since = 0) {
  await c.waitFor(frame => frame.type === 'agent_synced' && frame.payload?.agent?.id === id
    && frame.payload.agent.launch?.state === 'ready' && !!frame.payload.agent.sessionId,
  30_000, 'the accepted native session', since)
}

async function accepted(d: IsolatedDaemon, c: LocalClient, id: string) {
  const answer = await c.request('agents_list', {}, 30_000)
  const agent = answer.agents.find((row: Record<string, unknown>) => row.id === id)
  expect(agent?.grid).toMatchObject({ baseUrl: newBase, model: 'fixture-model' })
  const rows = JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')) as Array<Record<string, any>>
  const record = rows.find(row => row.agentId === id)?.gridLaunch
  expect(record?.baseUrl).toBe(newBase)
  // A boolean failure keeps even synthetic credential values out of assertion output.
  expect(record?.apiKey === newKey, 'the durable launch uses the edited key').toBe(true)
  for (const key of [oldKey, newKey]) {
    expect(JSON.stringify(c.frames).includes(key), 'replies contain no credential').toBe(false)
    expect(d.log().includes(key), 'daemon logs contain no credential').toBe(false)
  }
  await c.turn(id, 'the refreshed launch takes a turn', 30_000)
  expect(d.coresStarted()).toBe(1)
}

it('creates from the current Saved API when the request carries its previous endpoint and key', async () => {
  const { d, c, connection, grid } = await fresh()
  await rotate(c, connection)
  const made = await c.request('agent_create', { engine: 'claude', cwd: folder(d, 'rotated-create'),
    grid, bypassPermission: true }, 90_000)
  expect(made.error).toBeUndefined()
  await ready(c, made.agent.id)
  await accepted(d, c, made.agent.id)
})

it('publishes the accepted endpoint after retargeting with an outdated Saved API selection', async () => {
  const { d, c, connection, grid } = await fresh()
  const made = await c.request('agent_create', { engine: 'claude', cwd: folder(d, 'rotated-retarget'),
    bypassPermission: true }, 90_000)
  expect(made.error).toBeUndefined()
  await ready(c, made.agent.id)
  await rotate(c, connection)
  const since = c.frames.length
  const moved = await c.request('agent_retarget', { agentId: made.agent.id, grid }, 90_000)
  expect(moved.error).toBeUndefined()
  await ready(c, made.agent.id, since)
  await accepted(d, c, made.agent.id)
})

it('refuses an outdated create after its Saved API was removed, without creating an agent', async () => {
  const { d, c, connection, grid } = await fresh()
  const removed = await c.request('api_connections', { action: 'remove', id: connection.id }, 30_000)
  expect(removed.error).toBeUndefined()
  const before = await c.request('agents_list', {}, 30_000)
  const made = await c.request('agent_create', { engine: 'claude', cwd: folder(d, 'removed-create'),
    grid, bypassPermission: true }, 90_000)
  expect(made.error).toBe('API_UNAVAILABLE')
  expect(made.agent).toBeUndefined()
  const after = await c.request('agents_list', {}, 30_000)
  expect(after.agents.map((row: Record<string, unknown>) => row.id))
    .toEqual(before.agents.map((row: Record<string, unknown>) => row.id))
  expect(d.coresStarted()).toBe(1)
})
