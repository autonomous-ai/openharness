/**
 * A model switch on the real daemon, as a Buddy's machine makes it (task #2354, superTabs/buddyModel.ts): onto a grid model and
 * back keeps the conversation; a conversation too long for the model starts fresh there, and the way home reopens the one it
 * left, as the same agent. The fake Claude Code (e2e/harness/fakeEngine.mjs) resumes the session `--resume` names, as the real
 * one does.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

/** A grid as the models service resolves one (gridLaunchWire.ts GridLaunchOverride): the fake engine never calls it. */
const GRID = { networkId: 'net-fixture', networkName: 'fixture-grid', baseUrl: 'https://fixture.invalid/g/net-fixture/relay',
  apiKey: 'fixture-key', model: 'deepseek-4.1-flash', contextWindow: 131072 }

let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined
afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })

const row = async (agentId: string) =>
  ((await client!.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents).find(a => a.id === agentId)
/** The agent back up after a move, bound to a conversation other than [not] when one is named. */
const settled = (agentId: string, wanted: (sessionId: string) => boolean, what: string) =>
  until(what, async () => { const agent = await row(agentId); return agent?.status === 'active' && agent.sessionId && wanted(agent.sessionId) ? agent : null }, 60_000, 500)
async function turn(agentId: string, content: string): Promise<void> {
  const ended = client!.next((frame: Frame) => frame.type === 'turn_ended' && frame.agentId === agentId, 45_000, `turn_ended (${content})`)
  client!.send('message', { agentId, content })
  await ended
}

it('moves onto a grid model and back in the same conversation, and a fresh move comes home to the conversation it left', async () => {
  const d = await IsolatedDaemon.create()
  daemon = d
  onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
  await d.start()
  client = await LocalClient.connect(d)
  const cwd = join(d.projectsDir, 'buddy')
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
  expect(created.error, JSON.stringify(created)).toBeUndefined()
  const agentId = created.agent.id as string
  const first = await settled(agentId, () => true, 'the agent to bind its conversation')
  await turn(agentId, 'Remember the word lilac')
  const s1 = first.sessionId as string

  // Resumed: the same conversation on the grid, and the same one home.
  expect(await client.request('agent_retarget', { agentId, grid: GRID }, 60_000)).toMatchObject({ retargeted: true })
  expect((await settled(agentId, id => id === s1, 'the resumed conversation on the grid')).sessionId).toBe(s1)
  expect(await client.request('agent_retarget', { agentId, clearGrid: true }, 60_000)).toMatchObject({ retargeted: true })
  expect((await settled(agentId, id => id === s1, 'the same conversation at home')).sessionId).toBe(s1)

  // Too long for the model: a fresh conversation on the grid, then home to the one it left, as the same agent.
  expect(await client.request('agent_retarget', { agentId, grid: GRID, fresh: true }, 60_000)).toMatchObject({ retargeted: true })
  const onGrid = await settled(agentId, id => id !== s1, 'a fresh conversation on the grid')
  await turn(agentId, 'A question for the shared model')
  expect(await client.request('agent_retarget', { agentId, clearGrid: true }, 60_000)).toMatchObject({ retargeted: true })
  const home = await settled(agentId, id => id === s1, 'the conversation it left, reopened at home')
  expect([home.id, home.sessionId, onGrid.id]).toEqual([agentId, s1, agentId])
  expect((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents.filter(a => a.status === 'active'))
    .toHaveLength(1)
})
