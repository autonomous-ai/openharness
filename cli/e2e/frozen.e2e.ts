/**
 * An engine that freezes rather than exits, for Claude Code and Codex: the process is stopped
 * (SIGSTOP, as a debugger, a suspended laptop's swap storm or a stuck network call can leave it), and
 * its pane takes keystrokes it cannot read. A message sent to it must be taken once, not twice, when
 * it wakes; a cancel must leave it able to work; a stop must not wait on it forever; and every other
 * agent must go on as if nothing were wrong.
 */
import { execFileSync } from 'node:child_process'
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

/** The engine's own process in the agent's pane: the fake engine's wrapper, found under the pane. */
async function enginePid(d: IsolatedDaemon, agent: Row): Promise<number> {
  const pane = String(agent.terminal?.runtimes?.[0]?.paneId ?? agent.tmuxPane)
  const root = Number((await d.tmux.run('display-message', '-p', '-t', pane, '#{pane_pid}')).trim())
  const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    .map((m) => ({ pid: Number(m![1]), ppid: Number(m![2]), command: m![3] }))
  const wrapper = join(d.root, 'bin', agent.engine)
  const under = new Set([root])
  for (let grew = true; grew;) {
    grew = false
    for (const p of table) if (under.has(p.ppid) && !under.has(p.pid)) { under.add(p.pid); grew = true }
  }
  const engine = table.find((p) => under.has(p.pid) && p.command.includes(wrapper))
  if (!engine) throw new Error(`no ${agent.engine} process under pane ${pane}`)
  return engine.pid
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

describe('an engine that freezes', () => {
  let daemon: IsolatedDaemon | undefined
  const frozen: number[] = []
  afterEach(async () => {
    // A stopped process left behind would outlive the test.
    for (const pid of frozen.splice(0)) { try { process.kill(pid, 'SIGCONT') } catch { /* gone */ } }
    await daemon?.close(); daemon = undefined
  })
  const fresh = async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    return d
  }

  it.each(['claude', 'codex'] as const)('%s: a message to a frozen engine is taken once when it wakes, and the others go on meanwhile', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `frozen-${engine}`)
    const other = await create(d, client, engine === 'claude' ? 'codex' : 'claude', `awake-${engine}`)
    await turn(client, agent.id, 'before it froze')

    const pid = await enginePid(d, agent)
    process.kill(pid, 'SIGSTOP')
    frozen.push(pid)
    const from = client.frames.length
    client.send('message', { agentId: agent.id, content: 'sent while frozen' })
    // Long enough for every check and retry the daemon makes on a message it cannot see taken.
    await new Promise((resolve) => setTimeout(resolve, 15_000))
    // Meanwhile the other agent works as if nothing were wrong.
    await turn(client, other.id, 'while the other one is frozen')

    process.kill(pid, 'SIGCONT')
    await client.waitFor((frame) => isTurn('turn_ended', agent.id)(frame) && client.frames.indexOf(frame) >= from, 45_000, 'the woken engine to finish the message')
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    const starts = client.frames.slice(from).filter((frame) => isTurn('turn_started', agent.id)(frame))
    expect(starts.map((frame) => frame.payload?.userMessage)).toEqual(['sent while frozen'])
    await turn(client, agent.id, 'after it woke')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('a cancel sent to a frozen engine mid-turn leaves it able to work when it wakes', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'claude', 'cancel-frozen')
    client.send('message', { agentId: agent.id, content: '!slow 6000' })
    await client.next(isTurn('turn_started', agent.id), 30_000, 'turn_started')
    const pid = await enginePid(d, agent)
    process.kill(pid, 'SIGSTOP')
    frozen.push(pid)
    client.send('cancel', { agentId: agent.id })
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    process.kill(pid, 'SIGCONT')
    // The turn ends (cancelled or finished), and the agent is idle and takes the next message.
    await until('the agent to be idle again', async () => (await row(client, agent.id))?.activity?.state !== 'working' || null, 45_000, 500)
    await turn(client, agent.id, 'after the cancel')
    client.close()
  })

  it.each(['claude', 'codex'] as const)('%s: a stop does not wait on a frozen engine forever: it stops, and the process goes', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `stop-frozen-${engine}`)
    await turn(client, agent.id, 'before it froze')
    const pid = await enginePid(d, agent)
    process.kill(pid, 'SIGSTOP')
    frozen.push(pid)
    const startedAt = Date.now()
    const stopped = await client.request('agent_delete', { agentId: agent.id }, 120_000)
    const tookMs = Date.now() - startedAt
    // Stopped, or refused with a reason the app can show: never left hanging.
    if (stopped.error) expect(typeof stopped.error).toBe('string')
    else {
      await until('the agent to read as stopped', async () => (await row(client, agent.id))?.status === 'stopped' || null, 60_000, 500)
      await until('the frozen process to be gone', () => !alive(pid) || null, 60_000, 500)
    }
    expect(tookMs).toBeLessThan(90_000)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })
})
