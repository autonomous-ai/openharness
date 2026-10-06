/**
 * The fleet's lane (deviceLink.ts) against a fake `/api/device-ws` on 127.0.0.1, with its tokens from the
 * core and its E2EE sessions in the gateway (step 10, R3; gateway/lane.ts holds the real ones, with real
 * keys, in lane.spec.ts). It held this machine's identity and sealed in line before; each test here fails
 * if a rule of the lane's was lost in the move to sealing through the gateway, a round trip away:
 *
 *   - a frame for a linked machine is never sent in the clear: one the gateway cannot seal (it restarted
 *     under the lane) goes nowhere, and the next call starts a session again;
 *   - what goes out goes in the order it was handed, and what comes in is read in the order it came,
 *     however long the gateway takes over each;
 *   - the handshake goes in the clear, tagged with its machine; what does not open is never passed on;
 *   - the lane signs in with the core's token, with one forced refresh after a 401;
 *   - the lane's sessions end at the gateway when the lane does.
 */
import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import type { LaneOpened, LaneSeal, LaneSealed } from '../core/api.js'
import { DeviceLink, type DeviceFrame } from './deviceLink.js'

const LINKED = 'linked-machine'
const CLOUD = 'cloud-machine'
type Frame = Record<string, unknown>

/** The fake backend's device socket: what the lane sent, and a way to send it frames. */
async function fakeDeviceWs(opts: { refuseToken?: string } = {}) {
  const received: Frame[] = []
  const tokens: string[] = []
  let socket: WebSocket | null = null
  const wss = new WebSocketServer({
    port: 0, host: '127.0.0.1',
    handleProtocols: (protocols) => [...protocols][0] ?? false,
    verifyClient: (info: { req: IncomingMessage }, done: (ok: boolean, code?: number) => void) => {
      const token = String(info.req.headers['sec-websocket-protocol'] ?? '')
      tokens.push(token)
      done(token !== opts.refuseToken, 401)
    },
  })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const listeners = new Set<(frame: Frame) => void>()
  wss.on('connection', (ws) => {
    socket = ws
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame
      received.push(frame)
      for (const listener of listeners) listener(frame)
    })
  })
  const port = (wss.address() as { port: number }).port
  return {
    url: `ws://127.0.0.1:${port}`,
    received,
    tokens,
    /** Frames for machines, as the lane sent them: its own control frames left out. */
    forMachines: () => received.filter((frame) => frame.type !== 'device_hello' && frame.type !== 'machines_watch' && frame.type !== 'ping'),
    send: (frame: Frame) => socket?.send(JSON.stringify(frame)),
    on: (listener: (frame: Frame) => void) => { listeners.add(listener) },
    close: () => new Promise<void>((resolve) => { for (const client of wss.clients) client.terminate(); wss.close(() => resolve()) }),
  }
}

/** The gateway's side of the lane, faked: each seal marks the frame, and a test can make it slow or lost. */
function fakeSeal() {
  const sealed = vi.fn(async (_machineId: string, frame: Frame): Promise<LaneSealed> => ({ frame: { ...frame, payload: { __e2e: { of: frame.type } } } }))
  const opened = vi.fn(async (_machineId: string, frame: Frame): Promise<LaneOpened> =>
    ({ frame: { ...frame, payload: { opened: (frame.payload as { __e2e: unknown }).__e2e } } }))
  const seal = {
    hello: vi.fn(async (machineId: string, peerPub: string) => ({ type: 'e2e_hello', payload: { for: machineId, peerPub } })),
    welcome: vi.fn(async () => true),
    rekey: vi.fn(async () => {}),
    seal: sealed,
    open: opened,
    drop: vi.fn(),
  } satisfies LaneSeal
  return seal
}

const links: DeviceLink[] = []
const servers: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  for (const link of links.splice(0)) link.stop()
  for (const server of servers.splice(0)) await server.close()
})

async function lane(over: { refuseToken?: string; auth?: { accessToken(options?: { force?: boolean; failedToken?: string }): Promise<string> } } = {}) {
  const server = await fakeDeviceWs({ refuseToken: over.refuseToken })
  servers.push(server)
  const seal = fakeSeal()
  const lines: string[] = []
  const auth = over.auth ?? { accessToken: vi.fn(async () => 'token-1') }
  const link = new DeviceLink({
    auth, backendWsBase: server.url, computerId: 'computer-1', autonomousEnv: 'test', seal,
    peer: (machineId) => (machineId === LINKED ? { machineId, pub: 'LINKED-PUB', label: 'linked', linkedAt: 1 } as never : null),
    localMachineId: () => 'this-machine',
    log: (line) => { lines.push(line) },
  })
  links.push(link)
  // The far machine answers every hello with a welcome, as a linked daemon does.
  server.on((frame) => {
    if (frame.type === 'e2e_hello') server.send({ type: 'e2e_welcome', machineId: frame.machineId, payload: { ephPub: 'E' } })
  })
  const heard: DeviceFrame[] = []
  link.onFrame((frame) => { heard.push(frame) })
  return { server, seal, link, lines, auth, heard }
}

const until = async (what: string, check: () => boolean, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('the fleet\'s lane, sealed by the gateway', () => {
  it('sends a linked machine nothing in the clear: what the gateway cannot seal goes nowhere, and a session starts again', async () => {
    const { server, seal, link, lines } = await lane()
    await link.online()
    await link.sendSealed({ type: 'message', machineId: LINKED, payload: { content: 'the owner typed this' } })
    await until('the sealed message', () => server.forMachines().some((frame) => frame.type === 'message'))
    // The handshake went first, in the clear and tagged with its machine; the message sealed after it.
    expect(server.forMachines().map((frame) => frame.type)).toEqual(['e2e_hello', 'message'])
    expect(server.forMachines()[0]).toEqual({ type: 'e2e_hello', machineId: LINKED, payload: { for: LINKED, peerPub: 'LINKED-PUB' } })
    expect(seal.welcome).toHaveBeenCalledWith(LINKED, { ephPub: 'E' })
    // The gateway restarted under the lane: it holds no session, and the frame is dropped, never sent as is.
    seal.seal.mockResolvedValueOnce({ lost: true })
    await link.sendSealed({ type: 'message', machineId: LINKED, payload: { content: 'never in the clear' } })
    await until('the drop to be said', () => lines.some((line) => line.includes('its E2EE session is gone')))
    // And the next call starts a session again before it sends.
    await link.sendSealed({ type: 'message', machineId: LINKED, payload: { content: 'after the restart' } })
    await until('the second sealed message', () => server.forMachines().filter((frame) => frame.type === 'message').length === 2)
    expect(seal.hello).toHaveBeenCalledTimes(2)
    expect(server.forMachines().map((frame) => frame.type)).toEqual(['e2e_hello', 'message', 'e2e_hello', 'message'])
    expect(JSON.stringify(server.received)).not.toContain('the owner typed this')
    expect(JSON.stringify(server.received)).not.toContain('never in the clear')
    expect(JSON.stringify(server.received)).not.toContain('after the restart')
  })

  it('sends a frame that would be sealed nowhere while the gateway cannot start a session', async () => {
    const { server, seal, link, lines } = await lane()
    await link.online()
    seal.hello.mockRejectedValueOnce(new Error('the gateway could not start an E2EE session: it is not running'))
    await link.sendSealed({ type: 'message', machineId: LINKED, payload: { content: 'never in the clear' } })
    expect(lines.some((line) => line.includes('dropped message for linked-machine') && line.includes('not running'))).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(server.forMachines()).toEqual([])
  })

  it('sends in the order it was handed, however long the gateway takes to seal', async () => {
    const { server, seal, link } = await lane()
    await link.online()
    await link.establish(LINKED)
    let release!: () => void
    seal.seal.mockImplementationOnce(async (_m, frame) => {
      await new Promise<void>((resolve) => { release = resolve })
      return { frame: { ...frame, payload: { __e2e: { of: frame.type } } } }
    })
    link.send({ type: 'first', machineId: LINKED, payload: {} })
    // A frame for a machine the backend runs itself is never sealed: it waits its turn all the same.
    link.send({ type: 'second', machineId: CLOUD, payload: {} })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(server.forMachines().map((frame) => frame.type)).toEqual(['e2e_hello'])
    release()
    await until('both frames', () => server.forMachines().length === 3)
    expect(server.forMachines().map((frame) => frame.type)).toEqual(['e2e_hello', 'first', 'second'])
    expect(server.forMachines()[1].payload).toEqual({ __e2e: { of: 'first' } })
    expect(server.forMachines()[2].payload).toEqual({})
  })

  it('reads what comes in in order, opens only what was sealed, and never passes on what does not open', async () => {
    const { server, seal, link, heard, lines } = await lane()
    await link.online()
    await link.establish(LINKED)
    let release!: () => void
    seal.open.mockImplementationOnce(async (_m, frame) => {
      await new Promise<void>((resolve) => { release = resolve })
      return { frame: { ...frame, payload: { opened: 'first' } } }
    })
    server.send({ type: 'card', machineId: LINKED, payload: { __e2e: { n: 1 } } })
    server.send({ type: 'status', machineId: LINKED, payload: { plain: true } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(heard).toEqual([])
    release()
    await until('both frames', () => heard.length === 2)
    expect(heard).toEqual([
      { type: 'card', machineId: LINKED, payload: { opened: 'first' } },
      { type: 'status', machineId: LINKED, payload: { plain: true } },
    ])
    // Only the sealed one went to the gateway.
    expect(seal.open).toHaveBeenCalledTimes(1)
    seal.open.mockResolvedValueOnce({ unreadable: true })
    server.send({ type: 'card', machineId: LINKED, payload: { __e2e: { n: 2 } } })
    await until('the drop to be said', () => lines.some((line) => line === 'device: could not decrypt card — dropped'))
    // The gateway lost the session: nothing passed on, and the next call starts one again.
    seal.open.mockResolvedValueOnce({ lost: true })
    server.send({ type: 'card', machineId: LINKED, payload: { __e2e: { n: 3 } } })
    await until('the loss to be said', () => lines.some((line) => line.includes('the E2EE session with linked-machine is gone')))
    expect(heard).toHaveLength(2)
    await link.establish(LINKED)
    expect(seal.hello).toHaveBeenCalledTimes(2)
  })

  it('asks a linked machine through the gateway both ways: the request sealed, the reply opened before it is read', async () => {
    const { server, seal, link } = await lane()
    await link.online()
    const answer = link.rpc('agents_list', { scope: 'all' }, LINKED)
    await until('the request', () => server.forMachines().some((frame) => frame.type === 'agents_list'))
    expect(server.forMachines().find((frame) => frame.type === 'agents_list')!.payload).toEqual({ __e2e: { of: 'agents_list' } })
    // What the gateway sealed carried the request id; the reply that comes back sealed is opened to it.
    const asked = seal.seal.mock.calls.find(([, frame]) => frame.type === 'agents_list')![1] as { payload: { requestId: string } }
    seal.open.mockResolvedValueOnce({ frame: { type: 'agents_list_result', machineId: LINKED, payload: { requestId: asked.payload.requestId, agents: ['on B'] } } })
    server.send({ type: 'agents_list_result', machineId: LINKED, payload: { __e2e: { n: 1 } } })
    expect(await answer).toEqual({ requestId: asked.payload.requestId, agents: ['on B'] })
  })

  it('a machine that refuses this one\'s key fails its session, and it ends at the gateway', async () => {
    const { server, seal, link } = await lane()
    await link.online()
    await link.establish(LINKED)
    server.send({ type: 'e2e_rekey', machineId: LINKED, payload: { epoch: 'next' } })
    await until('the rekey', () => seal.rekey.mock.calls.length === 1)
    expect(seal.rekey).toHaveBeenCalledWith(LINKED, { epoch: 'next' })
    // A rekey for a machine with no session is not the gateway's business.
    server.send({ type: 'e2e_rekey', machineId: 'nobody', payload: {} })
    server.send({ type: 'e2e_denied', machineId: LINKED, payload: {} })
    await until('the session to end at the gateway', () => seal.drop.mock.calls.length === 1)
    expect(seal.drop).toHaveBeenCalledWith(LINKED)
    expect(seal.rekey).toHaveBeenCalledTimes(1)
    // A welcome the gateway turns down fails the handshake.
    seal.welcome.mockResolvedValueOnce(false)
    await expect(link.establish(LINKED)).rejects.toThrow('E2EE_HANDSHAKE_FAILED')
    // A reset says so to the gateway too, and the lane stopping ends every session it has there.
    await link.establish(LINKED)
    expect(link.resetSession(LINKED)).toBe(true)
    expect(seal.drop).toHaveBeenLastCalledWith(LINKED)
    await link.establish(LINKED)
    const drops = seal.drop.mock.calls.length
    link.stop()
    expect(seal.drop.mock.calls.length).toBe(drops + 1)
  })

  it('signs in with the core\'s token, refreshed once after a 401, and holds none of its own', async () => {
    const auth = { accessToken: vi.fn(async (options?: { force?: boolean; failedToken?: string }) => (options?.force ? 'token-2' : 'token-1')) }
    const { server, link } = await lane({ refuseToken: 'token-1', auth })
    await link.online()
    expect(auth.accessToken).toHaveBeenNthCalledWith(1)
    expect(auth.accessToken).toHaveBeenNthCalledWith(2, { force: true, failedToken: 'token-1' })
    expect(server.tokens).toEqual(['token-1', 'token-2'])
  })
})
