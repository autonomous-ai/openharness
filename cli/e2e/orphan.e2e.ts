/**
 * A core whose master dies, for Claude Code and Codex. The master is the one process `harness start`
 * leaves behind and the one the pid file names; a core without it is supervised by nobody, and must
 * leave so nothing holds the port the next start needs. The hard moment is a master killed while its
 * core is still starting: the core has bound and begun to beat, and is a second from finishing.
 */
import { mkdirSync } from 'node:fs'
import { createConnection } from 'node:net'
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
/** Whether anything accepts connections on the port. */
const answers = (port: number) => new Promise<boolean>((resolve) => {
  const socket = createConnection({ host: '127.0.0.1', port })
  socket.once('connect', () => { socket.destroy(); resolve(true) })
  socket.once('error', () => resolve(false))
})

describe('a core whose master dies', () => {
  let daemon: IsolatedDaemon | undefined
  const cores: number[] = []
  afterEach(async () => {
    // A core this test failed to see leave must not outlive it.
    for (const pid of cores.splice(0)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    await daemon?.close(); daemon = undefined
  })

  it.each([
    ['while its core is still starting', 'bound'],
    ['once its core is up', 'ready'],
  ] as const)('killed %s: the core leaves, the port is free, and the next start has every agent', async (_when, moment) => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    let client = await LocalClient.connect(d)
    const agents = [await create(d, client, 'claude', 'orphan-claude'), await create(d, client, 'codex', 'orphan-codex')]
    client.close()
    await d.stop()

    const from = d.log().length
    await d.start({ ready: 'none' })
    const line = moment === 'bound' ? /\[harnessd\] core bound/ : /\[cli\] ready/
    await until(`the core to be ${moment}`, () => line.test(d.log().slice(from)) || null, 60_000, 10)
    const core = d.corePid()!
    cores.push(core)
    await d.kill()
    await until('the core to leave', () => !IsolatedDaemon.alive(core) || null, 60_000, 200)
    await until('the port to be free', async () => !(await answers(d.port)) || null, 10_000, 200)

    await d.start()
    client = await LocalClient.connect(d)
    for (const agent of agents) {
      await until(`${agent.engine} back`, async () => {
        const now = await row(client, agent.id)
        return now?.status === 'active' && now.sessionId === agent.sessionId ? now : null
      }, 60_000, 500)
      await turn(client, agent.id, `after the master died (${agent.engine})`)
    }
    client.close()
  }, 300_000)
})
