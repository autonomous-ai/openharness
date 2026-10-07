/**
 * A message is typed only into the engine's own composer, for Claude Code and Codex: a screen of theirs
 * the daemon has no name for is refused, never typed into, and so is a list of suggestions open over the
 * composer, whose Enter picks a row. The composer is typed into while a turn runs (the engines queue
 * it), in a narrow pane, and with CJK and emoji in the message. The fake engines draw the composers the
 * engines draw (e2e/harness/fakeEngine.mjs): Claude Code's ruled box, Codex's `›` row and footer.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
const engines: Engine[] = ['claude', 'codex']
const name = (engine: Engine) => (engine === 'claude' ? 'Claude Code' : 'Codex')

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
  const started = client.next(isTurn('turn_started', agentId), 45_000, `turn_started (${content})`)
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  expect((await started).payload?.userMessage).toBe(content)
  await ended
}
const refusal = (client: LocalClient, agentId: string, ms: number) =>
  client.next((frame) => frame.type === 'error' && frame.agentId === agentId, ms, 'the refusal')

describe('a message goes only into the engine\'s own composer', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    return d
  }

  it.each(engines)('%s: a screen the daemon has no name for is refused, never typed into; closed, the message goes through', async (engine) => {
    // Claude Code's settings take a paste as a search and Enter changes the highlighted setting; Codex's
    // agent command center opens the highlighted task on Enter.
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `unnamed-${engine}`)
    await turn(client, agent.id, engine === 'claude' ? '!config' : '!center')
    const drawn = engine === 'claude' ? 'Search settings' : 'Agent command center'
    await until('the screen to be drawn', async () => (await d.capture(agent.tmuxPane)).includes(drawn) || null, 15_000, 250)
    const from = client.frames.length
    const refused = refusal(client, agent.id, 40_000)
    client.send('message', { agentId: agent.id, content: 'auto' })
    expect(String((await refused).payload?.message)).toBe(`${name(engine)} isn't showing its prompt; finish what's on its screen in its terminal, then send the message again.`)
    const pane = await d.capture(agent.tmuxPane)
    expect(pane).not.toContain('changed)')
    expect(pane).not.toContain('(opened')
    expect(client.frames.slice(from).some(isTurn('turn_started', agent.id))).toBe(false)
    await d.tmux.run('send-keys', '-t', agent.tmuxPane, 'Escape')
    await until('the composer to be back', async () => !(await d.capture(agent.tmuxPane)).includes(drawn) || null, 15_000, 250)
    await turn(client, agent.id, 'auto')
    client.close()
  })

  it.each(engines)('%s: a /command typed in the terminal with its suggestions open refuses a message; put away, the message goes through', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `popup-${engine}`)
    await d.tmux.run('send-keys', '-t', agent.tmuxPane, '/mo')
    await until('the suggestions to be drawn', async () => (await d.capture(agent.tmuxPane)).includes('Set the AI model') || null, 15_000, 250)
    const refused = refusal(client, agent.id, 15_000)
    client.send('message', { agentId: agent.id, content: 'what changed?' })
    expect(String((await refused).payload?.message)).toBe(`${name(engine)} message not sent. Close suggestions with Esc in its terminal, then retry.`)
    await d.tmux.run('send-keys', '-t', agent.tmuxPane, 'Escape', 'BSpace', 'BSpace', 'BSpace')
    await until('the suggestions to be put away', async () => !(await d.capture(agent.tmuxPane)).includes('Set the AI model') || null, 15_000, 250)
    await turn(client, agent.id, 'what changed?')
    client.close()
  })

  it.each(engines)('%s: a message sent while a turn runs is typed, and the engine takes it next', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `busy-${engine}`)
    const first = client.next(isTurn('turn_started', agent.id), 45_000, 'the first turn')
    client.send('message', { agentId: agent.id, content: '!slow 4000' })
    await first
    const second = client.next((frame) => isTurn('turn_started', agent.id)(frame) && frame.payload?.userMessage === 'and then this', 45_000, 'the second turn')
    client.send('message', { agentId: agent.id, content: 'and then this' })
    await second
    client.close()
  })

  it('codex: command examples in the conversation do not block a message appended to an ordinary draft', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'codex', 'command-example')
    await turn(client, agent.id, 'Explain this command:\n  /model     choose what model to use')
    await d.tmux.run('send-keys', '-t', agent.tmuxPane, '-l', 'look in /model')
    await until('the ordinary draft to be drawn', async () => (await d.capture(agent.tmuxPane)).includes('› look in /model') || null, 15_000, 250)
    const started = client.next(isTurn('turn_started', agent.id), 15_000, 'the appended message')
    client.send('message', { agentId: agent.id, content: '/notes' })
    expect((await started).payload?.userMessage).toBe('look in /model/notes')
    client.close()
  })

  it.each(engines)('%s: a message in CJK and emoji goes through in a narrow pane', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `narrow-${engine}`)
    await d.tmux.run('resize-window', '-t', agent.tmuxPane, '-x', '36')
    await until('the composer to be redrawn narrow', async () => {
      const pane = await d.capture(agent.tmuxPane)
      return pane.split('\n').some((line) => line.length > 0 && line.length <= 36 && (line.includes('─'.repeat(36)) || line.startsWith('›'))) || null
    }, 15_000, 250)
    await turn(client, agent.id, '修复登录 🎉 now')
    client.close()
  })
})
