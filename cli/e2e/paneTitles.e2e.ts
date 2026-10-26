/**
 * A harness named by its terminal's title, on the real daemon: the title its engine sets (OSC 0) renames it, and a
 * kitty graphics query, which tmux also takes as the pane's title, never does. A guest's Claude Code on a shared Mac
 * was named "Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA" (2026-10-22): its helper starts the engine with `env -i`, so it has no
 * TMUX and asks the terminal for graphics.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

const QUERY = 'Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA'

describe('a harness named by its terminal title', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it('keeps its name through a kitty graphics query, and takes the title its engine sets', async () => {
    const d = await IsolatedDaemon.create({ graphicsQuery: { title: 'Fix the login test', titleAfterMs: 25_000 } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}`) })
    await d.start()
    const client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'titles')
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const id: string = created.agent.id
    const row = async () => ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000))
      .agents).find((agent) => agent.id === id)
    // The query reached tmux as the pane's title, as on the shared Mac.
    await until('the graphics query as the pane title', async () =>
      (await d.tmux.run('list-panes', '-a', '-F', '#{pane_title}')).split('\n').includes(QUERY) || null, 20_000, 250)
    // Two title syncs (every 5 s) while it is the title: it never names the harness.
    await new Promise((resolve) => setTimeout(resolve, 11_000))
    expect((await d.tmux.run('list-panes', '-a', '-F', '#{pane_title}')).split('\n')).toContain(QUERY)
    expect((await row())?.name).not.toBe(QUERY)
    // The title its engine sets still names it: the sync ran all along, and reads titles.
    await until('the engine\'s title as the name', async () => (await row())?.name === 'Fix the login test' || null, 45_000, 500)
    client.close()
  }, 150_000)
})
