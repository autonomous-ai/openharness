/**
 * What a message must never do, for Claude Code and Codex: reach the shell an exited engine leaves in
 * its pane, where it would run as a command, a picker for a point to rewind the conversation to, where
 * its Enter would pick one, or a view where it is lost. (A permission prompt or a question is in
 * questions.e2e.ts.) And what a client must never cost the others: one that
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

  it('codex: a message is not typed into its transcript browser, whose Enter rewinds: refused with the reason, it goes through once the browser is closed', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'codex', 'browsing-scrollback')
    // Codex browsing in its scrollback mode: a transcript pager over the pane, which drops a paste, so
    // the Enter behind it would revert the conversation to the prompt in view.
    await turn(client, agent.id, '!browse scrollback')
    await until('the pager to be drawn', async () => (await d.capture(agent.tmuxPane)).includes('Browsing transcript') || null, 15_000, 250)
    const from = client.frames.length
    const refused = client.next((frame) => frame.type === 'error' && frame.agentId === agent.id, 15_000, 'the refusal')
    client.send('message', { agentId: agent.id, content: 'what changed since then?' })
    expect(String((await refused).payload?.message)).toBe('Codex is browsing its transcript, where Enter would rewind the conversation. Close it with Esc in its terminal, then send the message again.')
    // Nothing typed: still browsing, nothing rewound, no turn.
    const pane = await d.capture(agent.tmuxPane)
    expect(pane).toContain('Browsing transcript')
    expect(pane).not.toContain('rewound')
    expect(client.frames.slice(from).some(isTurn('turn_started', agent.id))).toBe(false)
    // Closed with Esc, as the refusal says, the same message goes through.
    await d.tmux.run('send-keys', '-t', agent.tmuxPane, 'Escape')
    await until('the composer to be back', async () => !(await d.capture(agent.tmuxPane)).includes('Browsing transcript') || null, 15_000, 250)
    await turn(client, agent.id, 'what changed since then?')
    expect(await d.capture(agent.tmuxPane)).not.toContain('rewound')
    client.close()
  })

  it('claude: a message is not lost in its transcript view (ctrl+o): refused with the reason, it goes through once the view is closed', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'claude', 'transcript-view')
    await turn(client, agent.id, '!transcript')
    await until('the view to be drawn', async () => (await d.capture(agent.tmuxPane)).includes('Showing detailed transcript') || null, 15_000, 250)
    const from = client.frames.length
    const refused = client.next((frame) => frame.type === 'error' && frame.agentId === agent.id, 15_000, 'the refusal')
    client.send('message', { agentId: agent.id, content: 'and the logout bug?' })
    expect(String((await refused).payload?.message)).toBe('Claude Code is showing its transcript (ctrl+o), where a message is not typed. Close it with Esc in its terminal, then send the message again.')
    expect(client.frames.slice(from).some(isTurn('turn_started', agent.id))).toBe(false)
    // Closed with Esc, as the refusal says, the same message goes through.
    await d.tmux.run('send-keys', '-t', agent.tmuxPane, 'Escape')
    await until('the prompt to be back', async () => !(await d.capture(agent.tmuxPane)).includes('Showing detailed transcript') || null, 15_000, 250)
    await turn(client, agent.id, 'and the logout bug?')
    client.close()
  })

  it('codex: a message is not lost in its transcript overlay (ctrl+t): refused with the reason, it goes through once the overlay is closed', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'codex', 'transcript-overlay')
    await turn(client, agent.id, '!overlay')
    await until('the overlay to be drawn', async () => (await d.capture(agent.tmuxPane)).includes('T R A N S C R I P T') || null, 15_000, 250)
    const from = client.frames.length
    const refused = client.next((frame) => frame.type === 'error' && frame.agentId === agent.id, 15_000, 'the refusal')
    client.send('message', { agentId: agent.id, content: 'and the logout bug?' })
    expect(String((await refused).payload?.message)).toBe('Codex is showing its transcript (ctrl+t), where a message is not typed. Close it with q in its terminal, then send the message again.')
    expect(client.frames.slice(from).some(isTurn('turn_started', agent.id))).toBe(false)
    // Closed with q, as the refusal says, the same message goes through.
    await d.tmux.run('send-keys', '-t', agent.tmuxPane, 'q')
    await until('the composer to be back', async () => !(await d.capture(agent.tmuxPane)).includes('T R A N S C R I P T') || null, 15_000, 250)
    await turn(client, agent.id, 'and the logout bug?')
    client.close()
  })

  it.each(engines)('%s: a message is not typed into a search of the prompt history (ctrl+r), where it would become the search, and Claude Code\'s Enter would send an earlier prompt', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `history-search-${engine}`)
    await turn(client, agent.id, 'fix the login bug please')
    await turn(client, agent.id, '!search')
    const footer = engine === 'claude' ? 'search prompts:' : 'reverse-i-search:'
    await until('the search to be drawn', async () => (await d.capture(agent.tmuxPane)).includes(footer) || null, 15_000, 250)
    const from = client.frames.length
    const refused = client.next((frame) => frame.type === 'error' && frame.agentId === agent.id, 15_000, 'the refusal')
    client.send('message', { agentId: agent.id, content: 'fix the login bug' })
    expect(String((await refused).payload?.message)).toBe(engine === 'claude'
      ? 'Claude Code is searching its prompt history (ctrl+r), where Enter would send an earlier prompt. Close it with ctrl+c in its terminal, then send the message again.'
      : 'Codex has a search open, where a message would become what it searches for. Close it with Esc in its terminal, then send the message again.')
    expect(client.frames.slice(from).some(isTurn('turn_started', agent.id))).toBe(false)
    // Closed as the refusal says, the same message goes through, as itself.
    await d.tmux.run('send-keys', '-t', agent.tmuxPane, engine === 'claude' ? 'C-c' : 'Escape')
    await until('the search to be closed', async () => !(await d.capture(agent.tmuxPane)).includes(footer) || null, 15_000, 250)
    const started = client.next(isTurn('turn_started', agent.id), 45_000, 'turn_started')
    await turn(client, agent.id, 'fix the login bug')
    expect(JSON.stringify((await started).payload)).toContain('fix the login bug')
    expect(JSON.stringify((await started).payload)).not.toContain('please')
    client.close()
  })

  it.each(engines)('%s: what reached the pane as its engine went down never runs in the shell it leaves', async (engine) => {
    // An engine on its way out reads no more input: Claude Code runs its SessionEnd hooks first. What was
    // typed for it then, a message right behind \`/exit\` among them, waits in the terminal, and the shell
    // the pane becomes must not run it. Typed here once the engine has taken its \`!exit\`.
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `went-down-${engine}`)
    await d.tmux.run('send-keys', '-t', agent.tmuxPane, '-l', '!exit')
    await d.tmux.run('send-keys', '-t', agent.tmuxPane, 'Enter')
    await until('the engine to take its exit', async () => (await d.capture(agent.tmuxPane)).includes('> !exit') || null, 15_000, 20)
    const marker = join(d.root, `pwned-on-the-way-out-${engine}`)
    await d.tmux.run('send-keys', '-t', agent.tmuxPane, command(marker), 'Enter')
    await until('the pane to be a shell', async () => (await d.capture(agent.tmuxPane)).includes('This pane is a shell now') || null, 30_000, 100)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    expect(existsSync(marker), 'what was typed for the engine ran in the shell').toBe(false)
    // The shell is the person's from here: what they type runs.
    const typed = join(d.root, `typed-in-the-shell-${engine}`)
    await d.tmux.run('send-keys', '-t', agent.tmuxPane, command(typed), 'Enter')
    await until('the shell to run what was typed into it', () => existsSync(typed) || null, 10_000, 100)
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
