/**
 * The daemon's everyday contract, end to end, for Claude Code and Codex: a client connects the way the
 * desktop app does, starts an agent, the agent binds its conversation, a message becomes a turn that
 * starts and ends, the daemon restarts and picks the agent back up, and the agent stops.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

const engines = ['claude', 'codex'] as const

describe('the daemon, end to end', () => {
  let daemon: IsolatedDaemon
  beforeAll(async () => { daemon = await IsolatedDaemon.create(); await daemon.start() })
  afterAll(async () => { await daemon?.close() })
  afterEach(() => {})


  const row = async (client: LocalClient, agentId: string) =>
    ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true })).agents)
      .find((agent) => agent.id === agentId)

  it('answers the desktop handshake on its socket and its port, with no agents', async () => {
    for (const tcp of [false, true]) {
      const client = await LocalClient.connect(daemon, { tcp })
      expect((await client.request('agents_list', {})).agents).toEqual([])
      client.close()
    }
  })

  it.each(engines)('%s: start, bind, a message becomes a turn, restart, stop', async (engine) => {
    onTestFailed(() => { console.log(`---- daemon log (${engine})\n${daemon.log().split('\n').slice(-80).join('\n')}`) })
    const client = await LocalClient.connect(daemon)
    const cwd = join(daemon.projectsDir, engine)
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agentId: string = created.agent.id

    const bound = await until(`${engine} to bind its conversation`, async () => {
      const agent = await row(client, agentId)
      return agent?.sessionId ? agent : null
    }, 45_000, 500)
    expect(bound.status).not.toBe('stopped')

    const isTurn = (type: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
    const started = client.next(isTurn('turn_started'), 30_000, 'turn_started')
    const ended = client.next(isTurn('turn_ended'), 30_000, 'turn_ended')
    client.send('message', { agentId, content: 'hello there' })
    expect((await started).payload?.userMessage).toBe('hello there')
    await ended

    // A restart re-attaches the session from its transcript: no turn is replayed as open.
    await daemon.restart()
    const again = await LocalClient.connect(daemon)
    const seen: string[] = []
    const back = await until(`${engine} to be back after a restart`, async () => {
      const agent = await row(again, agentId)
      seen.push(`${agent?.status}:${agent?.sessionId?.slice(0, 8)}`)
      return agent?.sessionId === bound.sessionId && agent.status !== 'stopped' ? agent : null
    }, 45_000, 250)
    console.log(`${engine} rows seen after the restart: ${seen.join(' ')}`)
    expect(back.status).not.toBe('stopped')
    const second = again.next(isTurn('turn_ended'), 30_000, 'second turn_ended')
    again.send('message', { agentId, content: 'and again' })
    await second

    const stopped = await again.request('agent_delete', { agentId }, 60_000)
    expect(stopped.error, JSON.stringify(stopped)).toBeUndefined()
    await until(`${engine} to stop`, async () => (await row(again, agentId))?.status === 'stopped' || null, 45_000, 500)
    again.close()
    client.close()
  })
})
