/**
 * The person's engines keeping their data somewhere of their own, for Claude Code and Codex.
 * `CLAUDE_CONFIG_DIR` moves Claude Code's settings (and with them its hooks), transcripts and process
 * records; `CODEX_HOME` moves Codex's hooks and rollouts. People set them in their shell profile to keep
 * a work and a personal account apart, and the daemon launches every engine through that shell, so the
 * engine takes them whatever the daemon's own environment says: the desktop app starts the daemon
 * without the profile. An agent must still bind, take turns and come back after a restart.
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
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const started = client.next(isTurn('turn_started', agentId), 45_000, `turn_started (${content})`)
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  expect((await started).payload?.userMessage).toBe(content)
  await ended
}

describe('the person\'s engines keeping their data elsewhere', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it.each([
    ['claude', 'CLAUDE_CONFIG_DIR', 'claude-work'],
    ['codex', 'CODEX_HOME', 'codex-work'],
  ] as const)('%s with %s set in the person\'s shell profile: an agent binds, works and comes back after a restart', async (engine: Engine, variable, folder) => {
    // The daemon installs its hooks, as it does on a person's machine: Claude Code's and Codex's alone,
    // into this test's throwaway home, the moved one included.
    const d = await IsolatedDaemon.create({ env: { DISABLE_HOOK_INSTALL: 'false', HOOK_INSTALL_ENGINES: 'claude,codex' } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    const home = join(d.root, folder)
    mkdirSync(home, { recursive: true })
    // The profile every shell the daemon starts reads; the daemon itself never sees this variable.
    writeFileSync(join(d.env.ZDOTDIR!, '.zshrc'), `export ${variable}=${JSON.stringify(home)}\n`)
    await d.start()
    let client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, `homes-${engine}`)
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agent = await until(`the ${engine} agent to bind with its data in ${folder}`, async () => {
      const now = await row(client, created.agent.id)
      return now?.sessionId && now.status === 'active' ? now : null
    }, 60_000, 500)
    await turn(client, agent.id, `with ${variable} set`)
    client.close()

    await d.restart()
    client = await LocalClient.connect(d)
    await until(`the ${engine} agent back after the restart`, async () => {
      const now = await row(client, agent.id)
      return now?.status === 'active' && now.sessionId === agent.sessionId ? now : null
    }, 60_000, 500)
    await turn(client, agent.id, `after the restart, with ${variable} set`)
    client.close()
  }, 300_000)
})
