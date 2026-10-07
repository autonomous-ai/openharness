/**
 * The tmux server's socket deleted while the server runs, for Claude Code and Codex. A daemon runs for
 * weeks, and a cleaner of /tmp (systemd-tmpfiles on Linux ages entries out after ten days) can remove
 * the socket from under a server that is still running every agent. tmux then says "no server", the
 * same words a dead server leaves. The agents are alive: none may be taken for gone, none may be
 * started a second time beside itself, and they must all be reachable again.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
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
/** The fake engines running for this daemon: a process titled as an engine whose parent is one of this
 *  daemon's launch shells (their command line names its engine wrappers). */
function engines(d: IsolatedDaemon): string[] {
  const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3].trim() }))
  const launchers = new Set(table.filter((p) => p.command.includes(join(d.root, 'bin'))).map((p) => p.pid))
  return table.filter((p) => /^(claude|codex)(?:\s|$)/.test(p.command) && launchers.has(p.ppid))
    .map((p) => `${p.pid} ${p.command}`)
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('the tmux server\'s socket deleted while it runs', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it('no agent is taken for gone or started twice, and every one is reachable again', async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    const client = await LocalClient.connect(d)
    const agents = [await create(d, client, 'claude', 'socket-claude'), await create(d, client, 'codex', 'socket-codex')]
    for (const agent of agents) await turn(client, agent.id, `before the socket went (${agent.engine})`)
    const server = Number(await d.tmux.run('display-message', '-p', '#{pid}'))
    const before = engines(d).length
    expect(before, engines(d).join('\n')).toBe(2)

    rmSync(d.tmux.socket)
    // Several reconcile and reap passes (5 s each here), as a long-running daemon would see.
    await sleep(25_000)
    expect(IsolatedDaemon.alive(server), 'the tmux server still runs').toBe(true)
    for (const agent of agents) {
      const now = await row(client, agent.id)
      expect(now?.status, `${agent.engine} is not taken for gone`).toBe('active')
      expect(now?.sessionId).toBe(agent.sessionId)
    }
    expect(engines(d).length, 'no engine started a second time').toBe(before)

    // Reachable again: each agent takes a turn, through the same server.
    for (const agent of agents) await turn(client, agent.id, `after the socket went (${agent.engine})`)
    expect(Number(await d.tmux.run('display-message', '-p', '#{pid}'))).toBe(server)
    expect(engines(d).length).toBe(before)
    client.close()
  }, 240_000)
})
