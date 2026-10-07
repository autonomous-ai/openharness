/**
 * The folders agents work in, as people name and lose them, for Claude Code and Codex: names with
 * spaces, quotes, a dollar sign, accents and emoji, which tmux, the shell and the engines' transcript
 * folders each escape their own way; and a folder that disappears (a worktree swept, a project
 * deleted) while its agent runs and while the daemon is down. An agent in any of them must be made,
 * take turns, survive a restart and be closed; one whose folder is gone must not take the daemon or
 * any other agent with it.
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
type Row = Record<string, any>

const rows = async (client: LocalClient): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
async function create(client: LocalClient, engine: Engine, cwd: string): Promise<Row> {
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${cwd}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`the agent in ${cwd} to bind its conversation`, async () => {
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

// Names that each break a different layer when escaped wrong: the shell, tmux's -c, and the engines'
// transcript folders, which Claude Code derives from the path.
const AWKWARD = [
  'My Projects/with spaces',
  "it's \"quoted\"",
  'cost $HOME and `ticks`',
  'ünïcødé çafé',
  'rocket 🚀 launch',
]

describe('the folders agents work in', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    return d
  }

  it.each(['claude', 'codex'] as const)('%s: a folder of any name holds an agent that works, survives a restart and is closed', async (engine) => {
    const d = await fresh()
    let client = await LocalClient.connect(d)
    const agents: Row[] = []
    for (const name of AWKWARD) agents.push(await create(client, engine, join(d.projectsDir, name)))
    for (const [i, agent] of agents.entries()) {
      expect(agent.project?.cwd ?? agent.cwd, AWKWARD[i]).toContain(AWKWARD[i].split('/').at(-1))
      await turn(client, agent.id, `in ${AWKWARD[i]}`)
    }
    client.close()
    await d.restart()
    client = await LocalClient.connect(d)
    for (const [i, agent] of agents.entries()) {
      await until(`${AWKWARD[i]} back after the restart`, async () => {
        const now = await row(client, agent.id)
        return now?.status === 'active' && now.sessionId === agent.sessionId ? now : null
      }, 60_000, 500)
      await turn(client, agent.id, `back in ${AWKWARD[i]}`)
    }
    for (const agent of agents) {
      const now = (await row(client, agent.id))!
      expect(await client.request('agent_close', { agentId: agent.id, sessionId: now.sessionId, createdAt: now.createdAt, mode: 'now' }, 60_000)).toMatchObject({ closed: true })
    }
    client.close()
  })

  it('a folder deleted under a running agent costs that agent at most: the daemon and the others go on', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const doomed = await create(client, 'claude', join(d.projectsDir, 'swept-worktree'))
    const other = await create(client, 'codex', join(d.projectsDir, 'kept-project'))
    rmSync(join(d.projectsDir, 'swept-worktree'), { recursive: true, force: true })
    // The engine is still running in its pane; what the apps read about its folder must not throw.
    const listed = await rows(client)
    expect(listed.some((agent) => agent.id === doomed.id)).toBe(true)
    for (const type of ['git_project_info', 'project_preview', 'fs_list_dir'] as const) {
      const answer = await client.request(type, { path: join(d.projectsDir, 'swept-worktree') }, 30_000)
      expect(answer, type).toBeTruthy()
    }
    await turn(client, other.id, 'the other agent is fine')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('a folder deleted while the daemon is down: the restart restores the rest, and says why it could not restore that one', async () => {
    const d = await fresh()
    let client = await LocalClient.connect(d)
    const doomed = await create(client, 'claude', join(d.projectsDir, 'gone-by-morning'))
    const kept = await create(client, 'codex', join(d.projectsDir, 'still-here'))
    await turn(client, doomed.id, 'before its folder went')
    client.close()
    await d.stop()
    // The machine is down; its agents' panes go with it, and one folder is deleted meanwhile.
    await d.tmux.run('kill-server')
    rmSync(join(d.projectsDir, 'gone-by-morning'), { recursive: true, force: true })
    await d.start()
    client = await LocalClient.connect(d)
    // Back means its engine is up again, not only its row: a restore lists the agent, on its conversation,
    // from the moment it starts relaunching it, and a message sent before the engine is there is refused
    // (on Linux the relaunch was still under way when the row first read as active).
    await until('the agent whose folder is still there to come back', async () => {
      const now = await row(client, kept.id)
      return now?.status === 'active' && now.sessionId === kept.sessionId && now.launch?.state !== 'starting' ? now : null
    }, 60_000, 500)
    await turn(client, kept.id, 'restored beside one that could not be')
    // The one whose folder is gone is not shown as active, and the daemon did not restart over it.
    await until('the agent whose folder is gone not to read as active', async () => {
      const now = await row(client, doomed.id)
      return !now || now.status !== 'active' || null
    }, 60_000, 500)
    expect(d.coresStarted()).toBe(2)
    client.close()
  })
})
