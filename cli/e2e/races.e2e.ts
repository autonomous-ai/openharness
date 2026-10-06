/**
 * Lifecycle requests that race each other, for Claude Code and Codex, on the real daemon: stopped while
 * still starting, two restarts at once, two resumes at once, a stop during a restart, a restart while a
 * message is being written, and two agents created in one folder at once. Whatever order they land in,
 * every request is answered, an agent ends with one engine in one pane, and it takes the next message.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
const engines: Engine[] = ['claude', 'codex']

const rows = async (client: LocalClient) =>
  (await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
async function folder(daemon: IsolatedDaemon, name: string): Promise<string> {
  const cwd = join(daemon.projectsDir, name)
  mkdirSync(cwd, { recursive: true })
  return cwd
}
async function create(daemon: IsolatedDaemon, client: LocalClient, engine: Engine, name: string): Promise<Record<string, any>> {
  const created = await client.request('agent_create', { engine, cwd: await folder(daemon, name), bypassPermission: true }, 90_000)
  expect(created.error, `${name}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${name} to bind its conversation`, async () => {
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
const active = (client: LocalClient, agentId: string, sessionId?: string) =>
  until(`${agentId.slice(0, 8)} to be active`, async () => {
    const now = await row(client, agentId)
    return now?.status === 'active' && now.sessionId && (!sessionId || now.sessionId === sessionId) ? now : null
  }, 60_000, 500)
/** The engine as it is installed for the agents created next: its config, plus what the test says
 *  (e2e/harness/fakeEngine.mjs), written beside the old wrapper and renamed over it. */
function install(d: IsolatedDaemon, engine: Engine, extra: Record<string, unknown>): void {
  const config = { ...d.engineConfig, ...extra }
  const module = pathToFileURL(join(CLI_ROOT, 'e2e', 'harness', 'fakeEngine.mjs')).href
  const wrapper = join(d.root, 'bin', engine)
  writeFileSync(`${wrapper}.new`, `#!${process.execPath}\nimport(${JSON.stringify(module)}).then((m) => m.run(${JSON.stringify(engine)}, ${JSON.stringify(config)}))\n`, { mode: 0o755 })
  renameSync(`${wrapper}.new`, wrapper)
}
/** Engines in a pane: a pane must never end with two of them, or none while the agent is active. npm's Codex
 *  is a Node wrapper with the engine as its child (fakeEngine.mjs), one engine in two processes, so a match
 *  whose parent matched too is the same engine. */
async function engineProcesses(daemon: IsolatedDaemon, pane: string): Promise<number> {
  const panePid = Number(await daemon.tmux.run('display-message', '-p', '-t', pane, '#{pane_pid}').catch(() => '0'))
  if (!panePid) return 0
  const { execFileSync } = await import('node:child_process')
  const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command=']).toString().trim().split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean) as RegExpMatchArray[]
  const children = new Map<number, number[]>()
  for (const [, pid, ppid] of table) children.set(Number(ppid), [...(children.get(Number(ppid)) ?? []), Number(pid)])
  const tree = new Set<number>([panePid])
  for (const pid of tree) for (const child of children.get(pid) ?? []) tree.add(child)
  const engines = table.filter(([, pid, , command]) => tree.has(Number(pid)) && /\b(claude|codex)\b/.test(command) && !/\bzsh\b|\bbash\b|\bsh -c\b/.test(command))
  const matched = new Set(engines.map(([, pid]) => Number(pid)))
  return engines.filter(([, , ppid]) => !matched.has(Number(ppid))).length
}

describe('lifecycle requests that race', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    return d
  }

  it.each(engines)('%s: stopped while still starting, it stays stopped, and nothing binds it afterwards', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const created = await client.request('agent_create', { engine, cwd: await folder(d, `stop-starting-${engine}`), bypassPermission: true }, 90_000)
    expect(created.error).toBeUndefined()
    // Pressed while the engine is still starting: it used to be refused ("Try stopping again"), because
    // the engine the agent launched was read as a replacement the moment it was identified.
    const stopped = await client.request('agent_delete', { agentId: created.agent.id }, 60_000)
    expect(stopped.error, JSON.stringify(stopped)).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    const all = await rows(client)
    const mine = all.filter((agent) => agent.id === created.agent.id)
    expect(mine).toHaveLength(1)
    expect(mine[0].status).toBe('stopped')
    // Nothing came back, and no second agent was minted for its pane.
    expect(all.filter((agent) => agent.status === 'active')).toHaveLength(0)
    client.close()
  })

  it.each(engines)('%s: two restarts at once leave one engine, and the agent takes the next message', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `double-restart-${engine}`)
    const answers = await Promise.all([1, 2].map(() => client.request('agent_restart', { agentId: agent.id }, 90_000)))
    for (const answer of answers) if (answer.error) expect(['AGENT_BUSY'], JSON.stringify(answer)).toContain(answer.error)
    expect(answers.some((answer) => !answer.error), JSON.stringify(answers)).toBe(true)
    const back = await active(client, agent.id, agent.sessionId)
    await until('one engine in the pane', async () => (await engineProcesses(d, back.tmuxPane)) === 1 || null, 20_000, 250)
    await turn(client, agent.id, 'after two restarts at once')
    expect((await rows(client)).filter((one) => one.status === 'active')).toHaveLength(1)
    client.close()
  })

  // The daemon finds the engine and its conversation before the engine's first SessionStart arrives, as on
  // a loaded machine. The first restart kills that engine just as its hook lands: registered for the
  // engine being killed, its attach found the pane's process gone and unbound the conversation, and the
  // second restart, finding none, started a fresh one. Seen once in eighteen runs under load; with the hook
  // this late, two of seven before round 35. Where the hook lands against the kill varies with the
  // machine, so three delays.
  it.each([700, 1_100, 1_500])('codex: two restarts at once, as the engine\'s first hook reaches the daemon %i ms late, bring it back on its conversation', async (delay) => {
    const d = await fresh()
    install(d, 'codex', { firstHookDelayMs: Number(process.env.RACE_FIRST_HOOK_DELAY_MS ?? delay) })
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'codex', `late-first-hook-${delay}`)
    const answers = await Promise.all([1, 2].map(() => client.request('agent_restart', { agentId: agent.id }, 90_000)))
    for (const answer of answers) if (answer.error) expect(['AGENT_BUSY'], JSON.stringify(answer)).toContain(answer.error)
    expect(answers.some((answer) => !answer.error), JSON.stringify(answers)).toBe(true)
    const back = await active(client, agent.id, agent.sessionId)
    await until('one engine in the pane', async () => (await engineProcesses(d, back.tmuxPane)) === 1 || null, 20_000, 250)
    await turn(client, agent.id, 'after two restarts at once')
    expect((await row(client, agent.id))?.sessionId).toBe(agent.sessionId)
    expect((await rows(client)).filter((one) => one.status === 'active')).toHaveLength(1)
    client.close()
  })

  it.each(engines)('%s: two resumes at once resume it once', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `double-resume-${engine}`)
    await turn(client, agent.id, 'before the stop')
    expect((await client.request('agent_delete', { agentId: agent.id }, 60_000)).error).toBeUndefined()
    await until('the agent to stop', async () => (await row(client, agent.id))?.status === 'stopped' || null, 45_000, 500)
    const answers = await Promise.all([1, 2].map(() => client.request('agent_resume', { agentId: agent.id }, 90_000)))
    for (const answer of answers) if (answer.error) expect(['AGENT_BUSY'], JSON.stringify(answer)).toContain(answer.error)
    const back = await active(client, agent.id, agent.sessionId)
    await until('one engine in the pane', async () => (await engineProcesses(d, back.tmuxPane)) === 1 || null, 20_000, 250)
    expect((await rows(client)).filter((one) => one.status === 'active')).toHaveLength(1)
    await turn(client, agent.id, 'after two resumes at once')
    client.close()
  })

  it.each(engines)('%s: a stop that lands during a restart wins: the agent ends stopped, with no engine left running', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `stop-during-restart-${engine}`)
    const restarting = client.request('agent_restart', { agentId: agent.id }, 90_000)
    await new Promise((resolve) => setTimeout(resolve, 150))
    const stopped = await client.request('agent_delete', { agentId: agent.id }, 90_000)
    const restarted = await restarting
    // Each is answered; which one wins depends on where the restart was, but the end state is coherent.
    expect(restarted).toBeTruthy()
    expect(stopped).toBeTruthy()
    const settled = await until('the agent to settle', async () => {
      const now = await row(client, agent.id)
      return now && (now.status === 'stopped' || now.status === 'active') ? now : null
    }, 60_000, 500)
    if (!stopped.error) {
      expect(settled.status).toBe('stopped')
      await until('no engine left in the pane', async () => (await engineProcesses(d, agent.tmuxPane)) === 0 || null, 20_000, 250)
    } else {
      await turn(client, agent.id, 'the restart won')
    }
    client.close()
  })

  it.each(engines)('%s: a restart while a message is being written: the message is answered at most once, and the next one is', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `restart-mid-message-${engine}`)
    const long = `a long message ${'with many words '.repeat(200)}`.trim()
    client.send('message', { agentId: agent.id, content: long })
    const restarted = await client.request('agent_restart', { agentId: agent.id }, 90_000)
    expect(restarted.error, JSON.stringify(restarted)).toBeUndefined()
    await active(client, agent.id, agent.sessionId)
    // The long message may still be on its way: it waits out the restart's hold on the terminal, and the
    // new engine answers it. The next one's own turn is the one to wait for, not just any turn's end.
    const started = client.next((frame) => isTurn('turn_started', agent.id)(frame) && frame.payload?.userMessage === 'the next message', 60_000, 'the next message\'s turn_started')
    client.send('message', { agentId: agent.id, content: 'the next message' })
    const opened = await started
    await client.waitFor(isTurn('turn_ended', agent.id), 45_000, 'the next message\'s turn_ended', client.frames.indexOf(opened) + 1)
    const page = await client.request<{ events: Array<{ type: string; payload: Record<string, any> }> }>('session_get', { sessionId: agent.sessionId, limit: 200 }, 30_000)
    const users = page.events.filter((event) => event.type === 'user_message').map((event) => String(event.payload.content))
    expect(users.filter((content) => content === long).length).toBeLessThanOrEqual(1)
    expect(users.at(-1)).toBe('the next message')
    // Nothing half-typed is left: no prompt made of the long message's tail and the next one.
    expect(users.some((content) => content !== long && content.includes('with many words') && content.includes('the next message'))).toBe(false)
    client.close()
  })

  it('two agents created in one folder at once are two agents, each with its own conversation', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const cwd = await folder(d, 'one-folder')
    const created = await Promise.all((['claude', 'claude', 'codex', 'codex'] as const).map((engine) =>
      client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)))
    for (const one of created) expect(one.error, JSON.stringify(one)).toBeUndefined()
    const ids = created.map((one) => one.agent.id as string)
    expect(new Set(ids).size).toBe(4)
    const bound = await Promise.all(ids.map((id) => active(client, id)))
    expect(new Set(bound.map((agent) => agent.sessionId)).size).toBe(4)
    expect(new Set(bound.map((agent) => agent.tmuxPane)).size).toBe(4)
    await Promise.all(ids.map((id, i) => turn(client, id, `agent ${i} in the shared folder`)))
    client.close()
  })

  it('a client that sends a restart and disconnects at once: the restart completes, and a new client sees it', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'claude', 'restart-and-go')
    client.send('agent_restart', { requestId: 'fire-and-forget', agentId: agent.id })
    client.close()
    const other = await LocalClient.connect(d)
    await active(other, agent.id, agent.sessionId)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const back = await active(other, agent.id, agent.sessionId)
    await until('one engine in the pane', async () => (await engineProcesses(d, back.tmuxPane)) === 1 || null, 20_000, 250)
    await turn(other, agent.id, 'after a restart nobody waited for')
    other.close()
  })
})
