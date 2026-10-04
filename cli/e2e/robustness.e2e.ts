/**
 * What the daemon must survive, on the real daemon under a throwaway home and a private tmux server:
 * hostile local clients, strangers and malformed bodies at the hook door, an agent's pane killed from
 * outside, a restart in the middle of a turn, and state files that are garbage when it starts. After
 * each, the same core is serving and a well-behaved client still works.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true })).agents)
    .find((agent) => agent.id === agentId)

async function boundAgent(daemon: IsolatedDaemon, client: LocalClient, name: string): Promise<Record<string, any>> {
  const cwd = join(daemon.projectsDir, name)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
  expect(created.error, JSON.stringify(created)).toBeUndefined()
  const agentId: string = created.agent.id
  return until('the agent to bind its conversation', async () => {
    const agent = await row(client, agentId)
    return agent?.sessionId ? agent : null
  }, 45_000, 500)
}

const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId

async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const started = client.next(isTurn('turn_started', agentId), 30_000, `turn_started (${content})`)
  const ended = client.next(isTurn('turn_ended', agentId), 30_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  await started
  await ended
}

/** A raw local WebSocket, past the handshake or not, for sending what no app would. */
async function rawSocket(daemon: IsolatedDaemon): Promise<WebSocket> {
  const ws = new WebSocket(`ws+unix://${daemon.socketPath}:/api/local-ws`)
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
  ws.on('error', () => {})
  return ws
}

const hook = (daemon: IsolatedDaemon, path: string, body: string | Buffer, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${daemon.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })

describe('what the daemon survives', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  const fresh = async (options: Parameters<typeof IsolatedDaemon.create>[0] = {}) => {
    const d = await IsolatedDaemon.create(options)
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    return d
  }

  it('hostile local clients: garbage, wrong shapes, unknown requests and a flood hurt neither the daemon nor other clients', async () => {
    const d = await fresh()
    await d.start()
    const good = await LocalClient.connect(d)
    expect((await good.request('agents_list', {})).agents).toEqual([])

    // Before the handshake, and after it: nothing a client sends can take the daemon down.
    const early = await rawSocket(d)
    for (const junk of ['not json', '{', '[]', 'null', '42', '{"type":5}', JSON.stringify({ type: 'agents_list', payload: 'nope' })]) early.send(junk)
    early.send(Buffer.from([0xde, 0xad, 0xbe, 0xef]), { binary: true })

    const bad = await LocalClient.connect(d)
    const unsupported = await bad.request('no_such_request', { anything: true }, 10_000).catch((error: Error) => ({ error: error.message }))
    expect(unsupported).toBeTruthy()
    const shapes: Array<Record<string, unknown>> = [
      { type: 'agents_list', payload: null }, { type: 'agents_list' }, { type: 'message', payload: { agentId: 42, content: { not: 'text' } } },
      { type: 'agent_create', payload: { engine: 'not-an-engine', cwd: 7 } }, { type: 'machine_select', payload: { machineId: 'someone-else' } },
      { type: 'session_search', payload: { requestId: 'x', query: 'a'.repeat(100_000) } },
    ]
    const rawBad = await rawSocket(d)
    rawBad.send(JSON.stringify({ type: 'machine_select', payload: { machineId: d.computerId, localProtocolVersion: 1 } }))
    for (const frame of shapes) rawBad.send(JSON.stringify(frame))
    // A flood of well-formed requests from one client.
    for (let i = 0; i < 500; i++) rawBad.send(JSON.stringify({ type: 'agents_list', payload: { requestId: `flood-${i}` } }))
    // One frame larger than any app sends: that connection is cut, nobody else's.
    const huge = await rawSocket(d)
    const cut = new Promise<number>((resolve) => huge.once('close', (code) => resolve(code)))
    huge.send('x'.repeat(64 * 1024 * 1024))
    expect(await cut).toBeGreaterThan(0)

    // The good client never noticed, and it is the same core.
    expect((await good.request('agents_list', {}, 15_000)).agents).toEqual([])
    const agent = await boundAgent(d, good, 'after-hostile-clients')
    await turn(good, agent.id, 'still works')
    expect(d.coresStarted()).toBe(1)
    for (const ws of [early, rawBad]) ws.close()
    bad.close()
    good.close()
  })

  it('strangers and malformed bodies at the hook door are refused or answered, and real hooks still bind', async () => {
    const d = await fresh()
    await d.start()
    const token = { 'x-harness-hook-token': d.hookCredential() }
    const valid = JSON.stringify({ engine: 'claude', sessionId: 'not-a-real-session', tmuxPane: '%999', cwd: '/nowhere' })
    expect((await hook(d, '/api/hook/session-start', valid)).status).toBe(401)
    expect((await hook(d, '/api/hook/session-start', valid, { 'x-harness-hook-token': 'wrong' })).status).toBe(401)
    for (const path of ['/api/hook/session-start', '/api/hook/session-end', '/api/hook/tool-start', '/api/hook/turn-stop']) {
      expect((await hook(d, path, '{not json', token)).status, path).toBe(400)
      expect((await hook(d, path, JSON.stringify({ engine: 42 }), token)).status, path).toBeGreaterThanOrEqual(400)
      // Larger than any hook sends: read and dropped, never held in memory.
      expect((await hook(d, path, Buffer.alloc(2 * 1024 * 1024, 'a'), token)).status, path).toBe(400)
    }
    // A well-formed hook for a pane and a session nobody has: ignored or refused, said out loud.
    const stray = await hook(d, '/api/hook/session-start', valid, token)
    expect([200, 403]).toContain(stray.status)
    const unknown = await fetch(`http://127.0.0.1:${d.port}/api/hook/does-not-exist`, { method: 'POST', headers: token, body: '{}' })
    expect(unknown.status).toBe(404)

    const client = await LocalClient.connect(d)
    const agent = await boundAgent(d, client, 'after-hook-abuse')
    await turn(client, agent.id, 'hooks still bind')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('an agent whose pane is killed from outside goes offline, and the daemon carries on', async () => {
    const d = await fresh()
    await d.start()
    const client = await LocalClient.connect(d)
    const survivor = await boundAgent(d, client, 'keeps-its-pane')
    const agent = await boundAgent(d, client, 'killed-from-outside')
    expect(agent.status).toBe('active')
    const pane = String(agent.terminal?.runtimes?.[0]?.paneId ?? agent.tmuxPane)
    await d.tmux.run('kill-pane', '-t', pane)
    const gone = await until('the agent to stop counting as active', async () => {
      const now = await row(client, agent.id)
      return !now || now.status !== 'active' ? (now ?? { status: 'removed' }) : null
    }, 45_000, 500)
    expect(['offline', 'stopped', 'removed']).toContain(gone.status)
    expect((await row(client, survivor.id))?.status).toBe('active')
    const other = await boundAgent(d, client, 'after-the-kill')
    await turn(client, other.id, 'the next agent is fine')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('a turn that outlives a restart ends live, once, and the agent takes the next message', async () => {
    const d = await fresh()
    await d.start()
    const client = await LocalClient.connect(d)
    const agent = await boundAgent(d, client, 'restart-mid-turn')
    const started = client.next(isTurn('turn_started', agent.id), 30_000, 'turn_started')
    client.send('message', { agentId: agent.id, content: '!slow 8000' })
    await started
    await d.restart()
    const again = await LocalClient.connect(d)
    const ended = await again.waitFor(isTurn('turn_ended', agent.id), 45_000, 'the slow turn to end after the restart')
    expect(ended.replay, 'the end of a turn that finished after the restart is live news').toBeFalsy()
    // Never announced twice as a turn starting now.
    const liveStarts = again.frames.filter((frame) => isTurn('turn_started', agent.id)(frame) && !frame.replay && !(frame.payload as any)?.replay)
    expect(liveStarts).toHaveLength(0)
    await turn(again, agent.id, 'after the restart')
    again.close()
    client.close()
  })

  it('a turn that ends while the daemon is down is not left working, and the agent takes the next message', async () => {
    const d = await fresh()
    await d.start()
    const client = await LocalClient.connect(d)
    const agent = await boundAgent(d, client, 'ends-while-down')
    const started = client.next(isTurn('turn_started', agent.id), 30_000, 'turn_started')
    client.send('message', { agentId: agent.id, content: '!slow 1000' })
    await started
    await d.restart()
    const again = await LocalClient.connect(d)
    const settled = await until('the agent to read as not working', async () => {
      const now = await row(again, agent.id)
      return now && now.activity?.state !== 'working' ? now : null
    }, 30_000, 500)
    expect(settled.status).toBe('active')
    await turn(again, agent.id, 'after a turn that ended while the daemon was down')
    again.close()
    client.close()
  })

  it('the dial, the window bridges and the device service failing on every call never disconnect the desktop', async () => {
    const d = await fresh({ env: { HARNESSD_TEST_FAULTS: 'dial,window,devices' } })
    await d.start()
    // The handshake itself asks the dial for its status.
    const desktop = await LocalClient.connect(d)
    const agent = await boundAgent(d, desktop, 'devices-failing')
    // What a desktop sends on every pane change, focus, read and spoken reply — each one reaching the dial,
    // a window bridge or the WiFi device service.
    for (let i = 0; i < 3; i++) {
      desktop.send('app_panes', { agentIds: [agent.id], foreground: true })
      desktop.send('app_focus', { agentId: agent.id })
      desktop.send('agent_seen', { agentId: agent.id })
      desktop.send('app_unread', { items: [{ agentId: agent.id, machineId: d.computerId, text: 'done' }] })
      desktop.send('voice_route_reply', { voiceId: 'v1', state: 'taken' })
      desktop.send('dial_settings', { id: 'dial-1', brightness: 3 })
    }
    expect((await desktop.request('agents_list', {}, 15_000)).agents).toHaveLength(1)
    await turn(desktop, agent.id, 'the desktop is still connected')
    expect(desktop.closed).toBe(false)
    expect(d.log()).toContain('[devices] dial failed · injected fault: dial')
    expect(d.log()).toContain('[devices] window failed · injected fault: window')
    expect(d.log()).toContain('[devices] devices failed · injected fault: devices')
    expect(d.log()).not.toContain('local dispatch failed')
    expect(d.coresStarted()).toBe(1)
    desktop.close()
  })

  it('state files that are garbage at start: the daemon starts, keeps what it can, and runs a new agent', async () => {
    const d = await fresh()
    await d.start()
    const first = await LocalClient.connect(d)
    await boundAgent(d, first, 'before-the-corruption')
    first.close()
    await d.stop()
    // Every file the core reads at start, written over with garbage of different kinds.
    writeFileSync(join(d.dataDir, 'registry.json'), '{"agents": [ {"agentId": "half', { mode: 0o600 })
    writeFileSync(join(d.dataDir, 'agent-names.json'), '\u0000\u0001 not json', { mode: 0o600 })
    mkdirSync(join(d.dataDir, 'stopped-agents'), { recursive: true, mode: 0o700 })
    writeFileSync(join(d.dataDir, 'stopped-agents', 'garbage.json'), '[[[', { mode: 0o600 })
    writeFileSync(join(d.dataDir, 'registry-boot'), 'not a boot id', { mode: 0o600 })
    await d.start()
    const client = await LocalClient.connect(d)
    expect(Array.isArray((await client.request('agents_list', { includeStopped: true })).agents)).toBe(true)
    const agent = await boundAgent(d, client, 'after-the-corruption')
    await turn(client, agent.id, 'runs on garbage state')
    client.close()
    void mkdtempSync
  })
})
