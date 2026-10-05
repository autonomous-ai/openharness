/**
 * The daemon paused while its engines go on, for Claude Code and Codex: the master and the core are
 * stopped (SIGSTOP), as Ctrl-Z on a daemon run in a terminal, a paused virtual machine or a swap storm
 * can leave them, for longer than the master's 30 s heartbeat watchdog. The engines live in tmux and
 * keep working. When the daemon resumes, nothing the person did meanwhile may be lost: a turn typed
 * into a pane is in the conversation once, a message an app sent into the paused socket is taken once,
 * and every agent works as before.
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
/** What the person said in a conversation, oldest first, as the apps read it back. */
async function said(client: LocalClient, sessionId: string): Promise<string[]> {
  const page = await client.request('session_get', { sessionId, limit: 50 }, 60_000)
  expect(page.error, JSON.stringify(page)).toBeUndefined()
  return (page.events as Row[]).filter((event) => event.type === 'user_message').map((event) => String(event.payload.content))
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('the daemon paused while its engines go on', () => {
  let daemon: IsolatedDaemon | undefined
  const paused: number[] = []
  afterEach(async () => {
    // A stopped daemon left behind would hold the test's close until its SIGKILL.
    for (const pid of paused.splice(0)) { try { process.kill(pid, 'SIGCONT') } catch { /* gone */ } }
    await daemon?.close(); daemon = undefined
  })

  it('paused past the watchdog: the typed turn and the app\'s message are each in the conversation once, and the core is not taken for hung', async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    let client = await LocalClient.connect(d)
    const claude = await create(d, client, 'claude', 'paused-claude')
    const codex = await create(d, client, 'codex', 'paused-codex')
    await turn(client, claude.id, 'before the pause (claude)')
    await turn(client, codex.id, 'before the pause (codex)')

    const master = d.pid!, core = d.corePid()!
    for (const pid of [master, core]) { process.kill(pid, 'SIGSTOP'); paused.push(pid) }
    // An app's message into the paused socket: the kernel holds it until the core reads again.
    client.send('message', { agentId: codex.id, content: 'sent while the daemon was paused' })
    // The person types into a pane meanwhile, and the engine takes the turn without the daemon.
    await d.tmux.run('send-keys', '-t', claude.tmuxPane, 'typed while the daemon was paused', 'Enter')
    await sleep(40_000)
    // Everything resumes at once, as it does after Ctrl-Z and fg or a virtual machine's pause.
    for (const pid of paused.splice(0)) process.kill(pid, 'SIGCONT')

    if (client.closed) client = await LocalClient.connect(d)
    await until('the app\'s message to be taken', async () =>
      (await said(client, codex.sessionId).catch(() => [])).includes('sent while the daemon was paused') || null, 60_000, 500)
    await until('the typed turn to be read', async () =>
      (await said(client, claude.sessionId).catch(() => [])).includes('typed while the daemon was paused') || null, 60_000, 500)
    await sleep(5_000)
    expect(await said(client, codex.sessionId)).toEqual(['before the pause (codex)', 'sent while the daemon was paused'])
    expect(await said(client, claude.sessionId)).toEqual(['before the pause (claude)', 'typed while the daemon was paused'])
    for (const agent of [claude, codex]) {
      const now = await row(client, agent.id)
      expect(now?.status, agent.engine).toBe('active')
      expect(now?.sessionId, agent.engine).toBe(agent.sessionId)
      await turn(client, agent.id, `after the pause (${agent.engine})`)
    }
    // The master was paused too, so the silence was not the core's: it is the same core.
    expect(d.log()).not.toMatch(/it is hung/)
    expect(d.coresStarted()).toBe(1)
    client.close()
  }, 240_000)
})
