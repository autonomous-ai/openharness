/**
 * What a message must never do, for Claude Code and Codex: reach the shell an exited engine leaves in
 * its pane, where it would run as a command. And what a client must never cost the others: one that
 * stops reading is cut off, alone, and the daemon's memory stays bounded while it is.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
const engines: Engine[] = ['claude', 'codex']

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
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  await ended
}
/** A message that, typed into a shell, leaves a file behind: the proof it ran as a command. */
const command = (marker: string) => `touch ${marker}`

describe('what a message must never do', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    return d
  }

  it.each(engines)('%s: a message to an agent whose engine exited is refused, and nothing reaches the shell in its pane', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `exited-${engine}`)
    client.send('message', { agentId: agent.id, content: '!exit' })
    await until('the engine to be gone', async () => (await row(client, agent.id))?.status !== 'active' || null, 30_000, 250)
    const marker = join(d.root, `pwned-after-exit-${engine}`)
    client.send('message', { agentId: agent.id, content: command(marker) })
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    expect(existsSync(marker), 'the message ran as a shell command').toBe(false)
    client.close()
  })

  it.each(engines)('%s: a message right behind the one that makes the engine exit never runs in the shell', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `exit-race-${engine}`)
    await turn(client, agent.id, 'a turn first')
    const marker = join(d.root, `pwned-race-${engine}`)
    // Back to back: the engine exits on the first, and the second is already on its way.
    client.send('message', { agentId: agent.id, content: '!exit' })
    client.send('message', { agentId: agent.id, content: command(marker) })
    await new Promise((resolve) => setTimeout(resolve, 6_000))
    expect(existsSync(marker), 'the second message ran as a shell command').toBe(false)
    client.close()
  })

  it.each(engines)('%s: keystrokes queued for a terminal whose engine exited are the person\'s own to send', async (engine) => {
    // The terminal is a terminal: what a person types into the pane goes to whatever runs there. The
    // composer is what must never type into a shell; this pins that the two stay apart.
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `terminal-after-exit-${engine}`)
    client.send('message', { agentId: agent.id, content: '!exit' })
    await until('the engine to be gone', async () => (await row(client, agent.id))?.status !== 'active' || null, 30_000, 250)
    const marker = join(d.root, `typed-by-hand-${engine}`)
    await d.tmux.run('send-keys', '-t', agent.tmuxPane, command(marker), 'Enter')
    await until('the shell to run what was typed by hand', () => existsSync(marker) || null, 10_000, 100)
    client.close()
  })
})

describe('what a client must never cost the others', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it('a client that stops reading is cut off alone, and memory stays bounded while it lasts', async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-80).join('\n')}`) })
    await d.start()
    const driver = await LocalClient.connect(d)
    const agents = [await create(d, driver, 'claude', 'slow-reader-a'), await create(d, driver, 'codex', 'slow-reader-b')]
    const stuck = await LocalClient.connect(d)
    const before = await d.rssMiB()
    // It stops reading: its socket buffer fills and everything after waits in the daemon for it.
    stuck.pauseReading()
    const words = 'many words in a long answer '.repeat(2_000)
    const started = Date.now()
    let rounds = 0
    // The daemon says when it cuts a connection off for silence; only the stuck one can be.
    const cutOff = () => d.log().includes('— terminating')
    while (!cutOff() && Date.now() - started < 90_000) {
      await Promise.all(agents.map((agent) => turn(driver, agent.id, `${rounds} ${words}`)))
      rounds++
      driver.frames.splice(0, driver.frames.length)
    }
    const peak = await d.rssMiB()
    expect(cutOff(), `the stuck client was never cut off (${rounds} rounds)`).toBe(true)
    expect(Date.now() - started).toBeLessThan(80_000)
    expect(peak - before, `rss ${before.toFixed(1)} → ${peak.toFixed(1)} MiB over ${rounds} rounds`).toBeLessThan(200)
    // The client that kept reading never noticed.
    await Promise.all(agents.map((agent) => turn(driver, agent.id, 'after the stuck client went')))
    expect(d.coresStarted()).toBe(1)
    driver.close()
  }, 180_000)
})
