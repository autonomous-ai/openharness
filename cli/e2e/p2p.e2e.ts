/** The gateway must still negotiate a real peer connection after its peer library becomes lazy. */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { expect, it, onTestFailed } from 'vitest'
import { TerminalBinaryKind } from '../src/lib/terminalBinary.js'
import { LocalClient } from './harness/client.js'
import { until } from './harness/daemon.js'
import { startPhoneMachine } from './harness/fleet.js'
import { P2pPhone } from './harness/p2pPhone.js'

it('loads P2P on demand, carries sealed terminal bytes, then keeps the agent working over relay', async () => {
  const world = await startPhoneMachine()
  const { machine, backend } = world
  const daemon = machine.daemon
  let desk: LocalClient | undefined
  let phone: P2pPhone | undefined
  onTestFailed(() => {
    console.log(`---- daemon log\n${daemon.log()}`)
    console.log(`---- peer errors\n${JSON.stringify(phone?.errors)}`)
  })
  try {
    desk = await LocalClient.connect(daemon, { machineId: machine.machineId })
    const corePid = daemon.corePid()
    const cwd = join(daemon.projectsDir, 'peer-terminal')
    mkdirSync(cwd)
    const created = await desk.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agentId = created.agent.id as string
    const inventory = async () => (await desk!.request('agents_list', { includeStopped: true })).agents as Array<Record<string, any>>
    const bound = await until('the P2P agent conversation', async () => (await inventory()).find(a => a.id === agentId && a.sessionId), 45_000)
    phone = await P2pPhone.open(world)
    await phone.negotiate()

    const requestId = randomUUID()
    // QA #908: the opening keyframe can arrive in the same callback as terminal_ready.
    const since = phone.binaries.length
    phone.send('terminal_open', { requestId, protocolVersion: 3, agentId, cols: 100, rows: 30 }, 'p2p')
    const answer = await until('terminal_ready over the peer channel', () => phone!.frames.find(({ frame }) =>
      ['terminal_ready', 'terminal_error'].includes(frame.type) && frame.payload?.requestId === requestId), 30_000)
    expect(answer.transport).toBe('p2p')
    expect(answer.frame.type, JSON.stringify(answer.frame)).toBe('terminal_ready')
    const streamId = answer.frame.payload!.streamId as string
    const opening = await until('the sealed P2P keyframe', () => phone!.binaries.slice(since).find(({ frame }) =>
      frame.streamId === streamId && frame.kind === TerminalBinaryKind.keyframe), 20_000)
    expect(opening.transport).toBe('p2p')
    const bytes = opening.frame.compressed ? inflateSync(opening.frame.bytes) : opening.frame.bytes
    expect(Buffer.from(bytes).toString()).toContain('Welcome to Claude Code (fake)')

    const content = 'typed across the peer channel'
    const ended = desk.next(f => f.type === 'turn_ended' && f.agentId === agentId, 30_000, 'peer input turn ended')
    phone.sendBinary({ kind: TerminalBinaryKind.input, streamId, seq: 0, compressed: false, bytes: Buffer.from(content + '\r') })
    await ended
    await until('the peer terminal to show its response', () => phone!.binaries.slice(since)
      .filter(({ frame, transport }) => transport === 'p2p' && frame.streamId === streamId && frame.kind === TerminalBinaryKind.output)
      .map(({ frame }) => Buffer.from(frame.compressed ? inflateSync(frame.bytes) : frame.bytes).toString()).join('').includes(content), 20_000)
    const connId = backend.webConnections(machine.machineId).at(-1)!
    const relayed = [...backend.webSent.get(connId) ?? [], ...backend.webReceived.get(connId) ?? []]
    expect(relayed.some(f => f.type === 'p2p_offer')).toBe(true)
    expect(relayed.filter(f => f.type?.startsWith('p2p_')).every(f => f.payload?.__e2e)).toBe(true)
    expect(relayed.some(f => f.type === 'terminal_open' || f.type === 'terminal_ready')).toBe(false)
    expect(JSON.stringify(relayed)).not.toContain(content)

    // Keep the sealed session and its agent; remove only the optional peer transport.
    await phone.peer.stop('test_relay_fallback')
    const fallback = randomUUID()
    phone.send('terminal_resync', { streamId }, 'relay')
    const done = desk.next(f => f.type === 'turn_ended' && f.agentId === agentId, 30_000, 'relay turn ended')
    phone.send('message', { agentId, content: fallback }, 'relay')
    await done
    const history = await desk.request('session_get', { sessionId: bound.sessionId, limit: 500 })
    const messages = history.events.filter((event: Record<string, any>) => event.type === 'user_message')
      .map((event: Record<string, any>) => event.payload.content ?? event.payload.text)
    expect(messages.filter((text: string) => text === content)).toHaveLength(1)
    expect(messages.filter((text: string) => text === fallback)).toHaveLength(1)
    expect((await inventory()).find(a => a.id === agentId)).toMatchObject({ sessionId: bound.sessionId, status: 'active' })
    expect(daemon.corePid()).toBe(corePid)
    expect(daemon.coresStarted()).toBe(1)
    expect(phone.errors).toEqual([])
  } finally {
    await phone?.close()
    desk?.close()
    await world.close()
  }
}, 120_000)
