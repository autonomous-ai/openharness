/**
 * What the machine does to the daemon, for Claude Code and Codex: the tmux server that holds every
 * agent's pane dies at once (a `tmux kill-server`, or tmux crashing), with agents idle or mid-turn,
 * and the machine restarts while the daemon is down, which takes every pane with it. When the server
 * dies under it, the daemon must carry on, must not keep showing any agent as active or working, and
 * must bring each back with its conversation when it is opened again. After a restart it brings them
 * back on its own.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
type Row = Record<string, any>

const rows = async (client: LocalClient): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
async function create(daemon: IsolatedDaemon, client: LocalClient, engine: Engine, folder: string): Promise<Row> {
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
  const started = client.next(isTurn('turn_started', agentId), 45_000, `turn_started (${content})`)
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  expect((await started).payload?.userMessage).toBe(content)
  await ended
}
/** Neither active nor working: what an agent whose pane is gone must read as. */
const down = (agent: Row | undefined) => !agent || (agent.status !== 'active' && agent.activity?.state !== 'working')
/** Opened again, it comes back with the same conversation, and takes a turn there. */
async function reopen(client: LocalClient, agent: Row, content: string): Promise<void> {
  const resumed = await client.request('agent_resume', { agentId: agent.id }, 90_000)
  expect(resumed.error, JSON.stringify(resumed)).toBeUndefined()
  await until(`${agent.id.slice(0, 8)} back with its conversation`, async () => {
    const now = await row(client, agent.id)
    return now?.status === 'active' && now.sessionId === agent.sessionId ? now : null
  }, 60_000, 500)
  await turn(client, agent.id, content)
}

describe('what the machine does to the daemon', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`)
      // The runner swallows console output: MACHINE_LOG=<file> keeps the daemon's whole log for reading.
      if (process.env.MACHINE_LOG) writeFileSync(process.env.MACHINE_LOG, d.log())
    })
    await d.start()
    return d
  }

  it('the tmux server dies under idle agents: none reads as active, the next agent runs, and each comes back', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agents = [await create(d, client, 'claude', 'idle-claude'), await create(d, client, 'codex', 'idle-codex')]
    for (const agent of agents) await turn(client, agent.id, `before the server died (${agent.engine})`)

    await d.tmux.run('kill-server')
    for (const agent of agents) {
      await until(`${agent.engine} to stop reading as active`, async () => down(await row(client, agent.id)) || null, 45_000, 500)
    }
    // The daemon carries on: a new agent gets a new server, and runs.
    const next = await create(d, client, 'claude', 'after-the-server')
    await turn(client, next.id, 'on a new server')
    // Each comes back with its conversation.
    for (const agent of agents) await reopen(client, agent, `back after the server died (${agent.engine})`)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it.each(['claude', 'codex'] as const)('%s: the tmux server dies mid-turn: the turn does not stay working, and the agent comes back', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `mid-turn-${engine}`)
    client.send('message', { agentId: agent.id, content: '!slow 8000' })
    await client.next(isTurn('turn_started', agent.id), 30_000, 'turn_started')
    await until('the agent to read as working', async () => (await row(client, agent.id))?.activity?.state === 'working' || null, 15_000, 250)

    const killedAt = client.frames.length
    await d.tmux.run('kill-server')
    await until('the agent to stop reading as working', async () => down(await row(client, agent.id)) || null, 45_000, 500)
    await reopen(client, agent, 'back after the server died mid-turn')
    // The interrupted turn died with its engine: it is never announced as starting again. Checked on every
    // frame since the kill, not only the next one, which caught it only when it came late (Codex).
    const restarted = client.frames.slice(killedAt).filter(isTurn('turn_started', agent.id)).map((frame) => frame.payload?.userMessage)
    expect(restarted).toEqual(['back after the server died mid-turn'])
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('the machine restarts while the daemon is down: every agent comes back on its own, with its conversation', async () => {
    const d = await fresh()
    let client = await LocalClient.connect(d)
    const agents = [await create(d, client, 'claude', 'reboot-claude'), await create(d, client, 'codex', 'reboot-codex')]
    for (const agent of agents) await turn(client, agent.id, `before the restart (${agent.engine})`)
    client.close()

    // A reboot: the daemon stops, and so does every pane with it. Its next start restores each agent
    // that was open into a new pane, resuming its conversation, with nobody opening it again.
    await d.stop()
    await d.tmux.run('kill-server')
    await d.start()
    client = await LocalClient.connect(d)
    for (const agent of agents) {
      await until(`${agent.engine} back on its own with its conversation`, async () => {
        const now = await row(client, agent.id)
        return now?.status === 'active' && now.sessionId === agent.sessionId ? now : null
      }, 60_000, 500)
    }
    for (const agent of agents) await turn(client, agent.id, `after the machine restarted (${agent.engine})`)
    client.close()
  })
})
