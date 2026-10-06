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
/** How tmux paints [pane]: its window's `window-style`, and the pane's style as `select-pane -g` reports
 *  it (the pane's own before tmux 3.0; from 3.0 its pane option, or its window's when it has none). */
const styleOf = async (d: IsolatedDaemon, pane: string) => ({
  window: await d.tmux.run('show-options', '-w', '-v', '-t', pane, 'window-style'),
  pane: await d.tmux.run('select-pane', '-g', '-t', pane),
})
type Style = Awaited<ReturnType<typeof styleOf>>

describe('the person reaching into the agents\' tmux', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  // A move returns the person's own pane it put the agent's beside, if any, and how it was painted.
  it.each([
    ['renames its session', async (d: IsolatedDaemon, pane: string, engine: Engine) => {
      const session = await d.tmux.run('display-message', '-p', '-t', pane, '#{session_name}')
      await d.tmux.run('rename-session', '-t', session, `my-${engine}-work`)
      return null as { pane: string; style: Style } | null
    }],
    ['renames its window', async (d: IsolatedDaemon, pane: string, _engine: Engine) => {
      await d.tmux.run('rename-window', '-t', pane, 'review')
      return null
    }],
    ['moves its pane into a window of their own', async (d: IsolatedDaemon, pane: string, engine: Engine) => {
      const theirs = await d.tmux.run('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', `mine-${engine}`, '-x', '120', '-y', '40')
      // The person's own colours for the window they made.
      await d.tmux.run('set-option', '-w', '-t', theirs, 'window-style', 'bg=#102030')
      const style = await styleOf(d, theirs)
      await d.tmux.run('join-pane', '-d', '-s', pane, '-t', `mine-${engine}:`)
      return { pane: theirs, style }
    }],
    ['breaks its pane out into a window of its own', async (d: IsolatedDaemon, pane: string, _engine: Engine) => {
      await d.tmux.run('break-pane', '-d', '-s', pane).catch(async (error: unknown) => {
        // tmux before 3.1 will not break out a window's only pane ("can't break with only one pane"):
        // there the person has opened a shell beside the agent first, and it stays behind.
        if (!/only one pane/.test(String(error))) throw error
        await d.tmux.run('split-window', '-d', '-t', pane, '/bin/sh')
        await d.tmux.run('break-pane', '-d', '-s', pane)
      })
      return null
    }],
  ] as const)('the person %s: the agent stays active, works, and comes back after a restart', async (_what, move) => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    let client = await LocalClient.connect(d)
    const agents = [await create(d, client, 'claude', 'moved-claude'), await create(d, client, 'codex', 'moved-codex')]
    const theirs: Array<{ pane: string; style: Style }> = []
    for (const agent of agents) {
      const beside = await move(d, paneOf(agent), agent.engine)
      if (beside) theirs.push(beside)
    }
    // The person's panes beside a moved agent keep their own colours, and the agent's keeps Harness's:
    // Harness paints only its panes, each on its own, never the window. When it painted windows, the
    // moved agent took the colours of the person's window, and the first scan after a daemon restart,
    // or a palette change, painted the person's shells there in Harness's.
    const untouched = async (when: string) => {
      for (const { pane, style } of theirs) expect(await styleOf(d, pane), `the person's ${pane} ${when}`).toEqual(style)
      for (const agent of agents) {
        await until(`${agent.engine}'s own pane in Harness's colours ${when}`, async () =>
          (await styleOf(d, paneOf(agent))).pane.includes('bg=#181818') ? true : null, 10_000, 250)
      }
    }
    // Several reconcile passes (5 s each here).
    await sleep(15_000)
    for (const agent of agents) {
      const now = await row(client, agent.id)
      expect(now?.status, `${agent.engine} after the move`).toBe('active')
      expect(now?.sessionId).toBe(agent.sessionId)
      await turn(client, agent.id, `after the move (${agent.engine})`)
    }
    await untouched('after the move')
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
    await untouched('after the restart')
    expect(d.coresStarted()).toBe(2)
    client.close()
  }, 300_000)
})
