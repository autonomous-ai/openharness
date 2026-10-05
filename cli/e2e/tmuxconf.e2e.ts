/**
 * The person's own tmux configuration, for Claude Code and Codex. The daemon's agents live on the
 * person's default tmux server, so that server loads their `~/.tmux.conf`, and people configure tmux
 * heavily: windows and panes numbered from 1, another prefix, vi keys, a long or a tiny history,
 * renamed and renumbered windows, the mouse, activity alerts. Some options would end an agent the
 * moment it was made if they applied to it: `destroy-unattached` ends any session no client is
 * attached to (every agent's), and `exit-empty` and session hooks have their say too. An agent must be
 * made, take turns, be closed and come back after a restart under any of them.
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

// What a heavily configured tmux looks like: every line here is common in published dotfiles.
const EVERYDAY = `
set -g prefix C-a
unbind C-b
bind C-a send-prefix
set -g base-index 1
setw -g pane-base-index 1
set -g renumber-windows on
set -g history-limit 100
setw -g mode-keys vi
set -g mouse on
set -g escape-time 0
set -g default-terminal "tmux-256color"
set -g status-position top
set -g status-interval 1
set -g allow-rename off
setw -g automatic-rename off
set -g set-titles on
setw -g monitor-activity on
set -g visual-activity on
set -g focus-events on
set -g remain-on-exit off
`

// Options that would end an agent the moment it was made, if the daemon let them apply to its own.
const DANGEROUS = `
set -g destroy-unattached on
set -g exit-empty on
set -g detach-on-destroy on
set-hook -g session-created 'set -g status off'
`

describe('the person\'s own tmux configuration', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const withConfig = async (config: string) => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    // The daemon's server is the person's default one, and loads their configuration from home.
    writeFileSync(join(d.env.HOME!, '.tmux.conf'), config)
    await d.start()
    return d
  }

  it.each([['an everyday configuration', EVERYDAY], ['options that would end a session no client watches', DANGEROUS]] as const)(
    'under %s, agents are made, take turns, come back after a restart and are closed',
    async (_name, config) => {
      const d = await withConfig(config)
      let client = await LocalClient.connect(d)
      const agents = [await create(d, client, 'claude', 'conf-claude'), await create(d, client, 'codex', 'conf-codex')]
      // Still there a moment later: nothing in the configuration ended them once they were made.
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      for (const agent of agents) {
        expect((await row(client, agent.id))?.status, agent.engine).toBe('active')
        await turn(client, agent.id, `under the configuration (${agent.engine})`)
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
      for (const agent of agents) {
        const now = (await row(client, agent.id))!
        expect(await client.request('agent_close', { agentId: agent.id, sessionId: now.sessionId, createdAt: now.createdAt, mode: 'now' }, 60_000)).toMatchObject({ closed: true })
      }
      expect(d.coresStarted()).toBe(2)
      client.close()
    },
  )
})
