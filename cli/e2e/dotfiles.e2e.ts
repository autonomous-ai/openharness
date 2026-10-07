/**
 * The person's shell startup files, for Claude Code and Codex. The daemon reads the login shell's
 * environment and launches each engine through the person's interactive login shell, so their
 * `.zshrc` runs first, and people's are noisy: a banner on stdout, warnings on stderr, a command that
 * fails, a slow plugin manager, and a `cd` to where they keep their code. An agent must still start
 * in its own folder, take turns, come back after a restart and be closed.
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
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
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 120_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${folder} to bind its conversation`, async () => {
    const agent = await row(client, created.agent.id)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 90_000, 500)
}
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const started = client.next(isTurn('turn_started', agentId), 45_000, `turn_started (${content})`)
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  expect((await started).payload?.userMessage).toBe(content)
  await ended
}

describe('the person\'s shell startup files', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it.each(['claude', 'codex'] as const)('%s: under a noisy, slow .zshrc that changes folder, an agent starts in its own folder and works', async (engine) => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    const elsewhere = join(d.root, 'where-i-keep-code')
    mkdirSync(elsewhere, { recursive: true })
    // ZDOTDIR is the throwaway home: this is the .zshrc every shell the daemon starts reads.
    writeFileSync(join(d.env.ZDOTDIR!, '.zshrc'), [
      'echo "Welcome back! Today is a good day to code."',
      'echo "warning: nvm is slow" >&2',
      'sleep 1',
      'this-command-does-not-exist 2>/dev/null',
      `cd ${JSON.stringify(elsewhere)}`,
      'PS1="%n@%m %~ %# "',
      '',
    ].join('\n'))
    writeFileSync(join(d.env.ZDOTDIR!, '.zprofile'), 'echo "zprofile says hello"\n')
    await d.start()
    let client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `dotfiles-${engine}`)
    // The .zshrc did run: its banner is in the pane's history, above the engine.
    const pane = String(agent.terminal?.runtimes?.[0]?.paneId ?? agent.tmuxPane)
    expect(await d.tmux.run('capture-pane', '-p', '-S', '-500', '-t', pane)).toContain('Welcome back! Today is a good day to code.')
    // The engine runs in the agent's folder, not where the .zshrc went.
    const info = await client.request('terminal_info', { agentId: agent.id }, 10_000)
    expect(info.error, JSON.stringify(info)).toBeUndefined()
    expect(realpathSync(info.path)).toBe(realpathSync(join(d.projectsDir, `dotfiles-${engine}`)))
    await turn(client, agent.id, 'under a noisy shell')
    client.close()
    await d.restart()
    client = await LocalClient.connect(d)
    await until('the agent back after the restart', async () => {
      const now = await row(client, agent.id)
      return now?.status === 'active' && now.sessionId === agent.sessionId ? now : null
    }, 90_000, 500)
    const back = await client.request('terminal_info', { agentId: agent.id }, 10_000)
    expect(realpathSync(back.path)).toBe(realpathSync(join(d.projectsDir, `dotfiles-${engine}`)))
    await turn(client, agent.id, 'after the restart')
    const now = (await row(client, agent.id))!
    expect(await client.request('agent_close', { agentId: agent.id, sessionId: now.sessionId, createdAt: now.createdAt, mode: 'now' }, 60_000)).toMatchObject({ closed: true })
    client.close()
  }, 300_000)
})
