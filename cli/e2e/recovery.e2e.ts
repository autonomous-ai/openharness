/**
 * Coming back, for Claude Code and Codex, on the real daemon: restarted again and again while agents
 * work, its master killed outright, an engine missing from this machine, and a registry lock left by
 * a daemon that crashed holding it. Agents live in tmux, so every way back must find them again.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'

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
const back = (client: LocalClient, agent: Record<string, any>) =>
  until(`${agent.id.slice(0, 8)} to be back`, async () => {
    const now = await row(client, agent.id)
    return now?.status === 'active' && now.sessionId === agent.sessionId ? now : null
  }, 60_000, 500)
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  await ended
}

describe('coming back', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}`) })
    return d
  }

  it('restarted five times in a row while agents work: they are back and take a turn every time', async () => {
    const d = await fresh()
    await d.start()
    let client = await LocalClient.connect(d)
    const agents = [await create(d, client, 'claude', 'restarts-claude'), await create(d, client, 'codex', 'restarts-codex')]
    for (let restart = 1; restart <= 5; restart++) {
      // A turn in flight as the daemon goes, every other time.
      if (restart % 2) client.send('message', { agentId: agents[0].id, content: '!slow 3000' })
      client.close()
      await d.restart()
      client = await LocalClient.connect(d)
      for (const agent of agents) await back(client, agent)
      await Promise.all(agents.map((agent) => turn(client, agent.id, `after restart ${restart}`)))
    }
    client.close()
  })

  it('its master killed outright: the core stops too, and the next start finds every agent', async () => {
    const d = await fresh()
    await d.start()
    const client = await LocalClient.connect(d)
    const agents = [await create(d, client, 'claude', 'killed-claude'), await create(d, client, 'codex', 'killed-codex')]
    const core = d.corePid()
    client.close()
    await d.kill()
    await until('the core to stop once its master is gone', () => !IsolatedDaemon.alive(core) || null, 30_000, 250)
    await d.start()
    const again = await LocalClient.connect(d)
    for (const agent of agents) await back(again, agent)
    await Promise.all(agents.map((agent) => turn(again, agent.id, 'after the master was killed')))
    again.close()
  })

  it('an engine missing from this machine fails its launch with the reason, and the other engine works', async () => {
    const d = await fresh()
    rmSync(join(d.root, 'bin', 'codex'), { force: true })
    await d.start()
    const client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'no-codex')
    mkdirSync(cwd, { recursive: true })
    // The pane opens and the launch fails in it, so the person sees why: the agent says it, and so does
    // its terminal.
    const created = await client.request('agent_create', { engine: 'codex', cwd, bypassPermission: true }, 90_000)
    const failed = await until('the launch to fail with its reason', async () => {
      const agent = created.agent?.id ? await row(client, created.agent.id) : undefined
      return agent?.launch?.state === 'failed' ? agent : null
    }, 30_000, 250)
    expect(failed.launch.error).toBe('ENGINE_NOT_INSTALLED')
    expect(failed.launch.detail).toContain('codex is not installed')
    expect(failed.status).not.toBe('active')
    const claude = await create(d, client, 'claude', 'still-claude')
    await turn(client, claude.id, 'claude is still here')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('a registry lock left by a daemon that crashed holding it does not stop the next one', async () => {
    const d = await fresh()
    // A lock whose owner is a process that no longer exists, as a crash leaves it.
    const lock = join(d.dataDir, 'registry.json.lock')
    mkdirSync(lock, { recursive: true, mode: 0o700 })
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 999_999, token: 'crashed', at: Date.now() - 60_000 }), { mode: 0o600 })
    await d.start()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'codex', 'after-a-stale-lock')
    await turn(client, agent.id, 'the registry took the write')
    await d.restart()
    const again = await LocalClient.connect(d)
    await back(again, agent)
    again.close()
    client.close()
  })
})
