import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'

type Frame = { type: string; agentId?: string; payload?: Record<string, unknown> }
interface Client {
  readonly frames: Frame[]
  waitFor(test: (frame: Frame) => boolean, ms?: number, what?: string, since?: number): Promise<Frame>
  waitForBinary(test: (frame: unknown) => boolean, ms?: number, what?: string, since?: number): Promise<unknown>
  turn(agentId: string, content: string, ms?: number): Promise<Frame>
  close(): void
}
// The end-to-end harness is outside tsconfig's rootDir (src), so it is loaded untyped, as releaseFixtures.spec.ts
// loads release.ts.
const { LocalClient } = await import('../../e2e/harness/client.js' as string) as {
  LocalClient: {
    connect(daemon: { port: number; computerId: string; localHeaders(): Record<string, string> }, options: { tcp: true }): Promise<Client>
  }
}

const opened: Array<{ close(): void }> = []
afterEach(() => { for (const one of opened.splice(0).reverse()) one.close() })

/** The daemon's local socket, as far as LocalClient needs one: `connected` after `machine_select`, and every other
 *  frame the client sends handed to `heard` with a way to answer. `send` pushes a frame at any time. */
async function stubDaemon(heard: (frame: Frame, send: (frame: Frame) => void) => void = () => {}): Promise<{ client: Client; send(frame: Frame): void }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  opened.push(server)
  await new Promise((resolve) => server.once('listening', resolve))
  let socket: WebSocket | undefined
  const send = (frame: Frame) => socket!.send(JSON.stringify(frame))
  server.on('connection', (ws) => {
    socket = ws
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame
      if (frame.type === 'machine_select') send({ type: 'connected' })
      else heard(frame, send)
    })
  })
  const client = await LocalClient.connect({ port: (server.address() as AddressInfo).port, computerId: 'spec', localHeaders: () => ({}) }, { tcp: true })
  opened.push(client)
  return { client, send }
}

describe('LocalClient.waitFor and waitForBinary take since as an index', () => {
  it('refuses a since that is not an index of the list, and names it', async () => {
    const { client } = await stubDaemon()
    const stamp = Date.now()
    // `frames` holds `connected` alone, and no terminal frame came.
    expect(() => client.waitFor(() => true, 50, 'a frame', stamp)).toThrow(`waitFor: since must be an index into frames (0 to 1), not ${stamp}`)
    expect(() => client.waitForBinary(() => true, 50, 'a terminal frame', stamp)).toThrow(`waitForBinary: since must be an index into binaries (0 to 0), not ${stamp}`)
    // -1 is what `frames.indexOf` answers for a frame that is not in the list.
    for (const since of [-1, 2, 0.5, Number.NaN]) expect(() => client.waitFor(() => true, 50, 'a frame', since)).toThrow(`not ${since}`)
  })

  it('takes every index of the list, its length included: the frames still to come', async () => {
    const { client, send } = await stubDaemon()
    expect(await client.waitFor((frame) => frame.type === 'connected', 50, 'connected', 0)).toEqual({ type: 'connected' })
    const later = client.waitFor((frame) => frame.type === 'later', 2_000, 'later', client.frames.length)
    send({ type: 'later' })
    expect(await later).toEqual({ type: 'later' })
  })
})

describe('LocalClient.turn', () => {
  const said = (frame: Frame) => frame.payload as { agentId: string; content: string }

  it('resolves with the end of its own message\'s turn, not of a turn that was under way', async () => {
    const { client } = await stubDaemon((frame, send) => {
      if (frame.type !== 'message') return
      const { agentId, content } = said(frame)
      // In one go, so they reach the client in one socket read: each wait has to find its frame by index.
      send({ type: 'turn_started', agentId, payload: { userMessage: 'a line the daemon typed' } })
      send({ type: 'turn_started', agentId: 'another-agent', payload: { userMessage: content } })
      send({ type: 'turn_ended', agentId, payload: { n: 1 } })
      send({ type: 'turn_started', agentId, payload: { userMessage: content } })
      send({ type: 'turn_ended', agentId: 'another-agent', payload: { n: 2 } })
      send({ type: 'turn_ended', agentId, payload: { n: 3 } })
    })
    expect(await client.turn('agent-1', 'One turn before the exit', 2_000)).toEqual({ type: 'turn_ended', agentId: 'agent-1', payload: { n: 3 } })
  })

  it('does not take an earlier turn of the same words for its own', async () => {
    let n = 0
    const { client } = await stubDaemon((frame, send) => {
      if (frame.type !== 'message') return
      const { agentId, content } = said(frame)
      send({ type: 'turn_started', agentId, payload: { userMessage: content } })
      send({ type: 'turn_ended', agentId, payload: { n: ++n } })
    })
    expect((await client.turn('agent-1', 'again', 2_000)).payload).toEqual({ n: 1 })
    expect((await client.turn('agent-1', 'again', 2_000)).payload).toEqual({ n: 2 })
  })

  it('names the wait that ran out', async () => {
    const { client } = await stubDaemon((frame, send) => {
      if (frame.type === 'message' && said(frame).content === 'starts, never ends') send({ type: 'turn_started', agentId: 'agent-1', payload: { userMessage: 'starts, never ends' } })
    })
    await expect(client.turn('agent-1', 'never typed', 100)).rejects.toThrow('turn_started (never typed)')
    await expect(client.turn('agent-1', 'starts, never ends', 100)).rejects.toThrow('turn_ended (starts, never ends)')
  })
})
