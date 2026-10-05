/**
 * The person reaching into the agents' tmux, for Claude Code and Codex. Harness is built on tmux, and hn
 * (`tmux improved`) puts its people in tmux all day: they attach to an agent's session, rename it, and
 * move its pane into a window of their own. Discovery adopts only panes in sessions Harness named, so a
 * session the person opened by hand is never taken for an agent (autonomous-harness-desktop#6). A pane
 * the daemon already runs an agent in is still that agent wherever it moves: it must stay active, take
 * turns, and come back after a restart.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
type Row = Record<string, any>

const rows = async (client: LocalClient): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
async function create(d: IsolatedDaemon, client: LocalClient, engine: Engine, folder: string): Promise<Row> {
  const cwd = join(d.projectsDir, folder)
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const paneOf = (agent: Row): string => String(agent.terminal?.runtimes?.[0]?.paneId ?? agent.tmuxPane)

describe('the person reaching into the agents\' tmux', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it.each([
    ['renames its session', async (d: IsolatedDaemon, pane: string, engine: Engine) => {
      const session = await d.tmux.run('display-message', '-p', '-t', pane, '#{session_name}')
      await d.tmux.run('rename-session', '-t', session, `my-${engine}-work`)
    }],
    ['renames its window', async (d: IsolatedDaemon, pane: string, _engine: Engine) => {
      await d.tmux.run('rename-window', '-t', pane, 'review')
    }],
    ['moves its pane into a window of their own', async (d: IsolatedDaemon, pane: string, engine: Engine) => {
      await d.tmux.run('new-session', '-d', '-s', `mine-${engine}`, '-x', '120', '-y', '40')
      await d.tmux.run('join-pane', '-d', '-s', pane, '-t', `mine-${engine}:`)
    }],
    ['breaks its pane out into a window of its own', async (d: IsolatedDaemon, pane: string, _engine: Engine) => {
      await d.tmux.run('break-pane', '-d', '-s', pane)
    }],
  ] as const)('the person %s: the agent stays active, works, and comes back after a restart', async (_what, move) => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    let client = await LocalClient.connect(d)
    const agents = [await create(d, client, 'claude', 'moved-claude'), await create(d, client, 'codex', 'moved-codex')]
    for (const agent of agents) await move(d, paneOf(agent), agent.engine)
    // Several reconcile passes (5 s each here).
    await sleep(15_000)
    for (const agent of agents) {
      const now = await row(client, agent.id)
      expect(now?.status, `${agent.engine} after the move`).toBe('active')
      expect(now?.sessionId).toBe(agent.sessionId)
      await turn(client, agent.id, `after the move (${agent.engine})`)
    }
    client.close()
    await d.restart()
    client = await LocalClient.connect(d)
    for (const agent of agents) {
      await until(`${agent.engine} back after the restart`, async () => {
        const now = await row(client, agent.id)
        return now?.status === 'active' && now.sessionId === agent.sessionId ? now : null
      }, 60_000, 500)
      await turn(client, agent.id, `after the restart (${agent.engine})`)
    }
    expect(d.coresStarted()).toBe(2)
    client.close()
  }, 300_000)
})
