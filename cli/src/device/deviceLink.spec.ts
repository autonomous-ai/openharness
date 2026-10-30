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
const LINKED_2 = 'second-linked-machine'
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
  // Each sealed frame carries its counter, as a real envelope does (`__e2e.n`): a refusal names it.
  const counters = new Map<string, number>()
  const sealed = vi.fn(async (machineId: string, frame: Frame): Promise<LaneSealed> => {
    const n = counters.get(machineId) ?? 0
    counters.set(machineId, n + 1)
    return { frame: { ...frame, payload: { __e2e: { of: frame.type, n } } } }
  })
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

async function lane(over: { refuseToken?: string; auth?: { accessToken(options?: { force?: boolean; failedToken?: string }): Promise<string> }; welcome?: boolean; now?: () => number; linked?: Set<string>; handshakeMs?: number; renewEveryMs?: number } = {}) {
  const server = await fakeDeviceWs({ refuseToken: over.refuseToken })
  servers.push(server)
  const seal = fakeSeal()
  const lines: string[] = []
  const peerReads: string[] = []
  const auth = over.auth ?? { accessToken: vi.fn(async () => 'token-1') }
  const link = new DeviceLink({
    auth, backendWsBase: server.url, computerId: 'computer-1', autonomousEnv: 'test', seal,
    peer: (machineId) => {
      peerReads.push(machineId)
      return (over.linked ?? new Set([LINKED, LINKED_2])).has(machineId) ? { machineId, pub: 'LINKED-PUB', label: 'linked', linkedAt: 1 } as never : null
    },
    localMachineId: () => 'this-machine',
    log: (line) => { lines.push(line) },
    ...(over.now ? { now: over.now } : {}),
    ...(over.handshakeMs ? { handshakeTimeoutMs: over.handshakeMs } : {}),
    ...(over.renewEveryMs ? { renewEveryMs: over.renewEveryMs } : {}),
  })
  links.push(link)
  // The far machine answers every hello with a welcome, as a linked daemon does.
  server.on((frame) => {
    if (frame.type === 'e2e_hello' && over.welcome !== false) server.send({ type: 'e2e_welcome', machineId: frame.machineId, payload: { ephPub: 'E' } })
  })
  const heard: DeviceFrame[] = []
  link.onFrame((frame) => { heard.push(frame) })
  return { server, seal, link, lines, auth, heard, peerReads }
}

const until = async (what: string, check: () => boolean, ms = 4_000): Promise<void> => {
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
    // The gateway lost the session: the frame is not passed on as it came, but held, a session started
    // again for it, and read under that one.
    seal.open.mockResolvedValueOnce({ lost: true })
    server.send({ type: 'card', machineId: LINKED, payload: { __e2e: { n: 3 } } })
    await until('the loss to be said', () => lines.some((line) => line.includes('the E2EE session with linked-machine is gone')))
    await until('the card, under the new session', () => heard.length === 3)
    expect(heard[2]).toEqual({ type: 'card', machineId: LINKED, payload: { opened: { n: 3 } } })
    await link.establish(LINKED)
    expect(seal.hello).toHaveBeenCalledTimes(2)
  })

  it('asks a linked machine through the gateway both ways: the request sealed, the reply opened before it is read', async () => {
    const { server, seal, link } = await lane()
    await link.online()
    const answer = link.rpc('agents_list', { scope: 'all' }, LINKED)
    await until('the request', () => server.forMachines().some((frame) => frame.type === 'agents_list'))
    expect(server.forMachines().find((frame) => frame.type === 'agents_list')!.payload).toEqual({ __e2e: { of: 'agents_list', n: 0 } })
    // What the gateway sealed carried the request id; the reply that comes back sealed is opened to it.
    const asked = seal.seal.mock.calls.find(([, frame]) => frame.type === 'agents_list')![1] as { payload: { requestId: string } }
    seal.open.mockResolvedValueOnce({ frame: { type: 'agents_list_result', machineId: LINKED, payload: { requestId: asked.payload.requestId, agents: ['on B'] } } })
    server.send({ type: 'agents_list_result', machineId: LINKED, payload: { __e2e: { n: 1 } } })
    expect(await answer).toEqual({ requestId: asked.payload.requestId, agents: ['on B'] })
  })

  it('a machine that refuses this one\'s key fails its session, and it ends at the gateway', async () => {
    const { server, seal, link } = await lane({ handshakeMs: 300 })
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
    // A welcome the gateway turns down is ignored, and the hello it answered times out with nothing in its place.
    seal.welcome.mockResolvedValueOnce(false)
    await expect(link.establish(LINKED)).rejects.toThrow('did not answer the E2EE hello')
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

/** The request id the gateway was handed to seal for a machine's `type`, the nth such. */
function askedId(seal: ReturnType<typeof fakeSeal>, machineId: string, type: string, nth = 0): string {
  const asked = seal.seal.mock.calls.filter(([m, frame]) => m === machineId && frame.type === type)[nth]![1] as { payload: { requestId: string } }
  return asked.payload.requestId
}

/** The counter the gateway sealed a machine's `type` under, the nth such: what a refusal names. */
async function sealedCounter(seal: ReturnType<typeof fakeSeal>, machineId: string, type: string, nth = 0): Promise<number> {
  const at = seal.seal.mock.calls.findIndex(([m, frame], i) => m === machineId && frame.type === type
    && seal.seal.mock.calls.slice(0, i).filter(([m2, f2]) => m2 === machineId && f2.type === type).length === nth)
  const result = await seal.seal.mock.results[at]!.value as { frame: { payload: { __e2e: { n: number } } } }
  return result.frame.payload.__e2e.n
}

// Diego, 10-30: every CLI release restarts the far daemon. This Mac kept using the session the old process had
// agreed to, so a dial turn, a stop or an answer for its agents vanished, its open questions with them, and the
// log filled with "could not decrypt" until two agents_list timeouts happened to reset it.
describe('a linked machine\'s daemon restarts', () => {
  it('its "session unknown" drops that session at once: only its requests fail, and the next call says hello again', async () => {
    const { server, seal, link, lines } = await lane()
    await link.online()
    await link.establish(LINKED)
    await link.establish(LINKED_2)
    expect(seal.hello).toHaveBeenCalledTimes(2)
    const toLinked = link.rpc('agents_list', {}, LINKED)
    const toOther = link.rpc('agents_list', {}, LINKED_2)
    await until('both requests', () => server.forMachines().filter((frame) => frame.type === 'agents_list').length === 2)
    const n = await sealedCounter(seal, LINKED, 'agents_list')
    const asked = Date.now()
    server.send({ type: 'e2e_session_unknown', machineId: LINKED, payload: { refused: { type: 'agents_list', n } } })
    // At once, not after the request's own 15-second timeout.
    await expect(toLinked).rejects.toThrow('E2EE_SESSION_GONE')
    expect(Date.now() - asked).toBeLessThan(2_000)
    expect(seal.drop).toHaveBeenCalledWith(LINKED)
    expect(seal.drop).not.toHaveBeenCalledWith(LINKED_2)
    expect(lines.some((line) => line.includes(`${LINKED} restarted (it no longer knows this session)`))).toBe(true)
    // The other machine's request is still waiting, and is answered.
    seal.open.mockResolvedValueOnce({ frame: { type: 'agents_list_result', machineId: LINKED_2, payload: { requestId: askedId(seal, LINKED_2, 'agents_list'), agents: ['still here'] } } })
    server.send({ type: 'agents_list_result', machineId: LINKED_2, payload: { __e2e: { n: 1 } } })
    expect(await toOther).toMatchObject({ agents: ['still here'] })
    // The next sealed frame for the restarted machine starts a new session first.
    await link.sendSealed({ type: 'message', machineId: LINKED, payload: { agentId: 'a1', content: 'after the restart' } })
    await until('the message', () => server.forMachines().some((frame) => frame.type === 'message'))
    expect(seal.hello).toHaveBeenCalledTimes(3)
    expect(server.forMachines().filter((frame) => frame.machineId === LINKED).map((frame) => frame.type)).toEqual(['e2e_hello', 'agents_list', 'e2e_hello', 'message'])
  })

  it('a turn, a stop or an answer it refused is reported not delivered, never re-sent; one it took before is not', async () => {
    let now = 1_000_000
    const { server, seal, link } = await lane({ now: () => now })
    const undelivered: Array<Record<string, unknown>> = []
    link.onUndelivered((what) => { undelivered.push({ ...what }) })
    await link.online()
    await link.sendSealed({ type: 'message', machineId: LINKED, payload: { agentId: 'a0', content: 'before the restart' } })
    await link.sendSealed({ type: 'message', machineId: LINKED, payload: { agentId: 'a1', content: 'run the tests' } })
    await link.sendSealed({ type: 'cancel', machineId: LINKED, payload: { agentId: 'a2' } })
    await link.sendSealed({ type: 'question_response', machineId: LINKED, payload: { agentId: 'a3', requestId: 'q1', answers: { k: 'v' } } })
    await until('all four', () => server.forMachines().filter((frame) => frame.type !== 'e2e_hello').length === 4)
    // The far side restarted after the first: it refuses the second, the first it never saw refused.
    const n = await sealedCounter(seal, LINKED, 'message', 1)
    server.send({ type: 'e2e_session_unknown', machineId: LINKED, payload: { refused: { type: 'message', n } } })
    await until('the three reports', () => undelivered.length === 3)
    expect(undelivered).toEqual([
      { machineId: LINKED, type: 'message', agentId: 'a1' },
      { machineId: LINKED, type: 'cancel', agentId: 'a2' },
      { machineId: LINKED, type: 'question_response', agentId: 'a3', requestId: 'q1' },
    ])
    // Nothing went out again: the refusal is a clear frame the relay could have written, and re-sending on its
    // word would let it replay a turn into a fresh session.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(server.forMachines().filter((frame) => frame.type !== 'e2e_hello')).toHaveLength(4)
    expect(seal.hello).toHaveBeenCalledTimes(1)
    // The next turn starts a new session. A refusal of it moments later is still reported (only the drop
    // waits for the limit), and one with no counter names what that session sealed in the last minute.
    await link.sendSealed({ type: 'message', machineId: LINKED, payload: { agentId: 'a4', content: 'again' } })
    await until('the fifth', () => server.forMachines().filter((frame) => frame.type !== 'e2e_hello').length === 5)
    server.send({ type: 'e2e_session_unknown', machineId: LINKED, payload: { refused: { type: 'message' } } })
    await until('the fourth report', () => undelivered.length === 4)
    expect(undelivered[3]).toEqual({ machineId: LINKED, type: 'message', agentId: 'a4' })
    expect(seal.drop).toHaveBeenCalledTimes(1)
    // Nothing is reported twice.
    now += 30_001
    server.send({ type: 'e2e_session_unknown', machineId: LINKED, payload: { refused: { type: 'message' } } })
    await until('the second drop', () => seal.drop.mock.calls.length === 2)
    expect(undelivered).toHaveLength(4)
  })

  it('a turn that could not be sealed at all is reported not delivered too', async () => {
    const { seal, link } = await lane()
    const undelivered: Array<Record<string, unknown>> = []
    link.onUndelivered((what) => { undelivered.push({ ...what }) })
    await link.online()
    seal.hello.mockRejectedValueOnce(new Error('the gateway could not start an E2EE session: it is not running'))
    await link.sendSealed({ type: 'message', machineId: LINKED, payload: { agentId: 'a1', content: 'x' } })
    expect(undelivered).toEqual([{ machineId: LINKED, type: 'message', agentId: 'a1' }])
    // The gateway lost the session as it sealed.
    await link.establish(LINKED)
    seal.seal.mockResolvedValueOnce({ lost: true })
    await link.sendSealed({ type: 'cancel', machineId: LINKED, payload: { agentId: 'a2' } })
    await until('the second report', () => undelivered.length === 2)
    expect(undelivered[1]).toEqual({ machineId: LINKED, type: 'cancel', agentId: 'a2' })
  })

  it('a refusal that lands while the new hello is out is about the old session, and kills nothing', async () => {
    let now = 1_000_000
    const { server, seal, link } = await lane({ welcome: false, now: () => now })
    await link.online()
    const first = link.establish(LINKED)
    await until('the hello', () => server.forMachines().some((frame) => frame.type === 'e2e_hello'))
    // Refusals of what the old session sealed come back before the welcome to the new hello.
    server.send({ type: 'e2e_session_unknown', machineId: LINKED, payload: { refused: { type: 'message', n: 7 } } })
    server.send({ type: 'e2e_welcome', machineId: LINKED, payload: { ephPub: 'E' } })
    await first
    expect(seal.drop).not.toHaveBeenCalled()
    // Once the session is up, a refusal is believed and drops it.
    server.send({ type: 'e2e_session_unknown', machineId: LINKED, payload: { refused: { type: 'message', n: 0 } } })
    await until('the drop', () => seal.drop.mock.calls.length === 1)
    // But another right after a forced drop waits for the limit: a relay repeating it cannot make re-handshakes cheap.
    const again = link.establish(LINKED)
    await until('the second hello', () => server.forMachines().filter((frame) => frame.type === 'e2e_hello').length === 2)
    server.send({ type: 'e2e_welcome', machineId: LINKED, payload: { ephPub: 'E' } })
    await again
    server.send({ type: 'e2e_session_unknown', machineId: LINKED, payload: { refused: { type: 'message', n: 0 } } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(seal.drop).toHaveBeenCalledTimes(1)
    // Half a minute on, it is believed again.
    now += 30_001
    server.send({ type: 'e2e_session_unknown', machineId: LINKED, payload: { refused: { type: 'message', n: 0 } } })
    await until('the second drop', () => seal.drop.mock.calls.length === 2)
  })

  it('a machine the backend says went offline loses its session at once; when it is back the next request says hello', async () => {
    const { server, seal, link, heard } = await lane()
    await link.online()
    await link.establish(LINKED)
    await link.establish(LINKED_2)
    const pending = link.rpc('agents_list', {}, LINKED)
    await until('the request', () => server.forMachines().some((frame) => frame.type === 'agents_list'))
    server.send({ type: 'node_status', machineId: LINKED, payload: { online: false } })
    await expect(pending).rejects.toThrow('E2EE_SESSION_GONE')
    expect(seal.drop).toHaveBeenCalledWith(LINKED)
    server.send({ type: 'node_status', machineId: LINKED, payload: { online: true } })
    // The fleet still hears both: they are the wheel's dots.
    await until('both statuses', () => heard.filter((frame) => frame.type === 'node_status').length === 2)
    const listed = link.rpc('agents_list', {}, LINKED)
    await until('the new hello', () => seal.hello.mock.calls.length === 3)
    await until('the request, sealed', () => seal.seal.mock.calls.filter(([m, frame]) => m === LINKED && frame.type === 'agents_list').length === 2)
    seal.open.mockResolvedValueOnce({ frame: { type: 'agents_list_result', machineId: LINKED, payload: { requestId: askedId(seal, LINKED, 'agents_list', 1), agents: [] } } })
    server.send({ type: 'agents_list_result', machineId: LINKED, payload: { __e2e: { n: 0 } } })
    expect(await listed).toMatchObject({ agents: [] })
    // The live machine list says the same for the other machine; a row still online changes nothing.
    server.send({ type: 'machines_status', payload: { statuses: [{ machineId: LINKED, online: true }, { machineId: LINKED_2, online: false }] } })
    await until('the second drop', () => seal.drop.mock.calls.length === 2)
    expect(seal.drop).toHaveBeenLastCalledWith(LINKED_2)
  })

  it('the restarted daemon\'s replay is held, a new session made by itself, and the replay read after its welcome, in order', async () => {
    const { server, seal, link, heard, lines } = await lane()
    await link.online()
    await link.establish(LINKED)
    // The first frame of the replay is sealed under the new process's epoch.
    seal.open.mockResolvedValueOnce({ unknownEpoch: true })
    server.send({ type: 'commander_question', machineId: LINKED, agentId: 'a1', payload: { __e2e: { n: 0, k: 'g' } } })
    server.send({ type: 'commander_event', machineId: LINKED, agentId: 'a1', payload: { __e2e: { n: 1, k: 'g' } } })
    await until('both, after the new welcome', () => heard.length === 2)
    expect(seal.hello).toHaveBeenCalledTimes(2)
    expect(seal.drop).toHaveBeenCalledWith(LINKED)
    expect(heard.map((frame) => frame.type)).toEqual(['commander_question', 'commander_event'])
    expect(heard[0].payload).toEqual({ opened: { n: 0, k: 'g' } })
    expect(lines.some((line) => line.includes(`${LINKED} restarted`))).toBe(true)
    expect(lines.some((line) => line.includes('could not decrypt'))).toBe(false)
    // A frame after them is read as before.
    server.send({ type: 'commander_event', machineId: LINKED, agentId: 'a1', payload: { __e2e: { n: 2, k: 'g' } } })
    await until('the third', () => heard.length === 3)
  })

  it('a sealed frame from a linked machine with no session is held and a session started for it', async () => {
    const { server, seal, link, heard } = await lane()
    await link.online()
    server.send({ type: 'commander_question', machineId: LINKED, agentId: 'a1', payload: { __e2e: { n: 0, k: 'g' } } })
    await until('the question, opened', () => heard.length === 1)
    expect(seal.hello).toHaveBeenCalledTimes(1)
    expect(heard[0]).toEqual({ type: 'commander_question', machineId: LINKED, agentId: 'a1', payload: { opened: { n: 0, k: 'g' } } })
    // A machine with no pinned key is not one this daemon makes sessions with: its frame passes as before.
    server.send({ type: 'commander_event', machineId: CLOUD, agentId: 'c1', payload: { __e2e: { n: 0, k: 'g' } } })
    await until('the cloud frame', () => heard.length === 2)
    expect(seal.hello).toHaveBeenCalledTimes(1)
  })

  it('a relay forging new epochs gets one new session per machine per half minute, and nothing it forged is read', async () => {
    let now = 1_000_000
    const { server, seal, link, heard, lines } = await lane({ now: () => now })
    await link.online()
    await link.establish(LINKED)
    seal.open.mockResolvedValue({ unknownEpoch: true })
    server.send({ type: 'commander_event', machineId: LINKED, agentId: 'a1', payload: { __e2e: { n: 0, k: 'g', epoch: 'forged-1' } } })
    await until('the one renewal', () => seal.hello.mock.calls.length === 2)
    // Under the new session it still does not open: thrown away, not held again, no third hello.
    await until('the forged frame dropped', () => lines.some((line) => line.includes('not from the session it renewed — dropped')))
    server.send({ type: 'commander_event', machineId: LINKED, agentId: 'a1', payload: { __e2e: { n: 1, k: 'g', epoch: 'forged-2' } } })
    server.send({ type: 'commander_event', machineId: LINKED, agentId: 'a1', payload: { __e2e: { n: 2, k: 'g', epoch: 'forged-3' } } })
    await until('the limit said', () => lines.filter((line) => line.includes('renewed its session moments ago — held')).length === 2)
    expect(seal.hello).toHaveBeenCalledTimes(2)
    expect(heard).toEqual([])
    now += 30_001
    server.send({ type: 'commander_event', machineId: LINKED, agentId: 'a1', payload: { __e2e: { n: 3, k: 'g', epoch: 'forged-4' } } })
    await until('one more renewal', () => seal.hello.mock.calls.length === 3)
  })

  it('never asks a linked machine in the clear: a request with no session up fails as session gone', async () => {
    // A machine linked between the handshake and the send (`harness link connect` runs as its own process):
    // establish() saw no pin and made no session, and the request must not go out unsealed.
    const linked = new Set<string>()
    const { server, seal, link } = await lane({ linked })
    await link.online()
    const peerAppears = vi.spyOn(link, 'establish').mockImplementationOnce(async () => { linked.add(LINKED) })
    await expect(link.rpc('agents_list', { scope: 'all' }, LINKED)).rejects.toThrow('E2EE_SESSION_GONE')
    peerAppears.mockRestore()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(server.forMachines()).toEqual([])
    expect(seal.seal).not.toHaveBeenCalled()
  })

  it('access revoked mid-renewal: nothing held is read afterwards, and every waiting request fails at once', async () => {
    const { server, seal, link, heard } = await lane({ welcome: false })
    await link.online()
    server.send({ type: 'commander_question', machineId: LINKED, agentId: 'a1', payload: { __e2e: { n: 0, k: 'g' } } })
    await until('the renewal', () => seal.hello.mock.calls.length === 1)
    const pending = link.rpc('agents_list', {}, LINKED_2)
    pending.catch(() => {})
    await until('the other machine\'s hello', () => seal.hello.mock.calls.length === 2)
    server.send({ type: 'device_revoked', payload: {} })
    await expect(pending).rejects.toThrow()
    // A welcome that lands after the revocation opens nothing that was held before it.
    server.send({ type: 'e2e_welcome', machineId: LINKED, payload: { ephPub: 'E' } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(heard).toEqual([])
    expect(seal.open).not.toHaveBeenCalled()
  })

  it('a welcome no hello is waiting for is ignored: forged or replayed ones cannot drop a healthy session', async () => {
    // Security review 1 on #2356: three forged welcomes in 30 s cost three drops and four hellos.
    const { server, seal, link, lines } = await lane()
    await link.online()
    await link.establish(LINKED)
    seal.welcome.mockResolvedValue(false)
    for (let i = 0; i < 3; i++) server.send({ type: 'e2e_welcome', machineId: LINKED, payload: { ephPub: 'replayed' } })
    await until('the three said', () => lines.filter((line) => line.includes('no hello of this daemon is waiting')).length === 3)
    expect(seal.welcome).toHaveBeenCalledTimes(1)
    expect(seal.drop).not.toHaveBeenCalled()
    expect(seal.hello).toHaveBeenCalledTimes(1)
    // The session is still the one in use.
    await link.sendSealed({ type: 'message', machineId: LINKED, payload: { agentId: 'a1', content: 'still sealed' } })
    await until('the message', () => server.forMachines().some((frame) => frame.type === 'message'))
    expect(seal.hello).toHaveBeenCalledTimes(1)
  })

  it('while a hello waits, a welcome that does not verify is ignored, and the real one still brings the held replay', async () => {
    const { server, seal, link, heard, lines } = await lane({ welcome: false })
    await link.online()
    server.send({ type: 'commander_question', machineId: LINKED, agentId: 'a1', payload: { __e2e: { n: 0, k: 'g' } } })
    await until('the hello', () => seal.hello.mock.calls.length === 1)
    seal.welcome.mockResolvedValueOnce(false)
    server.send({ type: 'e2e_welcome', machineId: LINKED, payload: { ephPub: 'forged' } })
    await until('the forged one said', () => lines.some((line) => line.includes('does not verify')))
    expect(seal.drop).not.toHaveBeenCalled()
    server.send({ type: 'e2e_welcome', machineId: LINKED, payload: { ephPub: 'E' } })
    await until('the replay, read', () => heard.length === 1)
    expect(heard[0]).toMatchObject({ type: 'commander_question', payload: { opened: { n: 0, k: 'g' } } })
    expect(seal.hello).toHaveBeenCalledTimes(1)
  })

  it('an offline notice drops a machine\'s session at most once per half minute', async () => {
    let now = 1_000_000
    const { server, seal, link, lines } = await lane({ now: () => now })
    await link.online()
    await link.establish(LINKED)
    server.send({ type: 'node_status', machineId: LINKED, payload: { online: false } })
    await until('the drop', () => seal.drop.mock.calls.length === 1)
    await link.establish(LINKED)
    // Repeated at once (by the relay, or a flapping machine): the new session is kept.
    server.send({ type: 'node_status', machineId: LINKED, payload: { online: false } })
    server.send({ type: 'machines_status', payload: { statuses: [{ machineId: LINKED, online: false }] } })
    await until('the two said', () => lines.filter((line) => line.includes('reported offline again')).length === 2)
    expect(seal.drop).toHaveBeenCalledTimes(1)
    now += 30_001
    server.send({ type: 'node_status', machineId: LINKED, payload: { online: false } })
    await until('the second drop', () => seal.drop.mock.calls.length === 2)
  })

  it('counts the size cap in bytes as they came, not characters', async () => {
    const { server, link, lines } = await lane({ welcome: false })
    await link.online()
    // 300 Ki characters of a three-byte character: 900 KiB a frame, so two fit under 2 MiB.
    const wide = '€'.repeat(300 * 1024)
    for (let n = 0; n < 4; n++) server.send({ type: 'commander_event', machineId: LINKED, agentId: 'a1', payload: { __e2e: { n, k: 'g', ct: wide } } })
    await until('the excess said', () => lines.filter((line) => line.includes('held too much')).length === 2)
  })

  it('holds frames up to a size as well as a count', async () => {
    const { server, seal, link, heard, lines } = await lane({ welcome: false })
    await link.online()
    const big = 'x'.repeat(300 * 1024)
    for (let n = 0; n < 10; n++) server.send({ type: 'commander_event', machineId: LINKED, agentId: 'a1', payload: { __e2e: { n, k: 'g', ct: big } } })
    await until('the excess said', () => lines.filter((line) => line.includes('held too much')).length === 4)
    expect(seal.hello).toHaveBeenCalledTimes(1)
    server.send({ type: 'e2e_welcome', machineId: LINKED, payload: { ephPub: 'E' } })
    await until('the six held', () => heard.length === 6)
  })

  // Security review 2 on #2356.
  it('a refusal within the limit is still reported, and the session renewed once the limit allows', async () => {
    // The limit is read from this clock, so a slow machine running the suite cannot push the second refusal
    // outside it; the deferred renewal's timer still runs on real time (300 ms).
    let now = 1_000_000
    const { server, seal, link } = await lane({ renewEveryMs: 300, now: () => now })
    const undelivered: Array<Record<string, unknown>> = []
    link.onUndelivered((what) => { undelivered.push({ ...what }) })
    await link.online()
    await link.sendSealed({ type: 'message', machineId: LINKED, payload: { agentId: 'a1', content: 'one' } })
    await until('the first', () => server.forMachines().filter((frame) => frame.type === 'message').length === 1)
    server.send({ type: 'e2e_session_unknown', machineId: LINKED, payload: { refused: { type: 'message', n: await sealedCounter(seal, LINKED, 'message') } } })
    await until('the first report', () => undelivered.length === 1)
    await link.sendSealed({ type: 'message', machineId: LINKED, payload: { agentId: 'a2', content: 'two' } })
    await until('the second', () => server.forMachines().filter((frame) => frame.type === 'message').length === 2)
    // Restarted again moments later: what it refused is reported at once, the drop waits for the limit.
    server.send({ type: 'e2e_session_unknown', machineId: LINKED, payload: { refused: { type: 'message', n: await sealedCounter(seal, LINKED, 'message', 1) } } })
    await until('the second report', () => undelivered.length === 2)
    expect(undelivered[1]).toEqual({ machineId: LINKED, type: 'message', agentId: 'a2' })
    expect(seal.drop).toHaveBeenCalledTimes(1)
    now += 300
    await until('the deferred drop', () => seal.drop.mock.calls.length === 2)
    await link.sendSealed({ type: 'message', machineId: LINKED, payload: { agentId: 'a3', content: 'three' } })
    await until('the third hello', () => seal.hello.mock.calls.length === 3)
  })

  it('a new epoch within the limit is held, not dropped, and read after the deferred renewal', async () => {
    // The limit is read from this clock (see the test above); the deferred renewal's timer runs on real time.
    let now = 1_000_000
    const { server, seal, link, heard } = await lane({ renewEveryMs: 300, now: () => now })
    await link.online()
    await link.establish(LINKED)
    seal.open.mockResolvedValueOnce({ unknownEpoch: true })
    server.send({ type: 'commander_question', machineId: LINKED, agentId: 'a1', payload: { __e2e: { n: 0, k: 'g' } } })
    await until('the first replay', () => heard.length === 1)
    expect(seal.hello).toHaveBeenCalledTimes(2)
    // A second restart inside the limit: its replay waits for the next renewal instead of being lost.
    seal.open.mockResolvedValueOnce({ unknownEpoch: true })
    server.send({ type: 'commander_question', machineId: LINKED, agentId: 'a2', payload: { __e2e: { n: 0, k: 'g' } } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(seal.hello).toHaveBeenCalledTimes(2)
    now += 300
    await until('the second replay', () => heard.length === 2)
    expect(seal.hello).toHaveBeenCalledTimes(3)
    expect(heard[1]).toMatchObject({ type: 'commander_question', agentId: 'a2' })
  })

  it('evicts held frames past their time when holding more, and drops them when the hello times out or is denied', async () => {
    let now = 1_000_000
    const { server, seal, link, lines } = await lane({ welcome: false, handshakeMs: 300, now: () => now })
    await link.online()
    for (let n = 0; n < 64; n++) server.send({ type: 'commander_event', machineId: LINKED, agentId: 'a1', payload: { __e2e: { n, k: 'g' } } })
    await until('the hello', () => seal.hello.mock.calls.length === 1)
    // Past the hold time: the renewal limit, the hello's timeout and some slack (41 s here).
    now += 41_000
    server.send({ type: 'commander_event', machineId: LINKED, agentId: 'a1', payload: { __e2e: { n: 64, k: 'g' } } })
    await until('the eviction said', () => lines.some((line) => line.includes('64 held frame(s) from linked-machine waited too long')))
    expect(lines.some((line) => line.includes('held too many'))).toBe(false)
    // The hello is never answered: what was held goes with it.
    await until('the timeout drop', () => lines.some((line) => line.includes('dropped 1 held frame(s) from linked-machine')))
    // Denied: held frames go too.
    now += 41_000
    server.send({ type: 'commander_event', machineId: LINKED_2, agentId: 'b1', payload: { __e2e: { n: 0, k: 'g' } } })
    await until('the second hello', () => seal.hello.mock.calls.length === 2)
    server.send({ type: 'e2e_denied', machineId: LINKED_2, payload: {} })
    await until('the denied drop', () => lines.some((line) => line.includes('dropped 1 held frame(s) from second-linked-machine')))
  })

  it('an offline notice during a renewal leaves the hello and what was held alone', async () => {
    const { server, seal, link, heard } = await lane({ welcome: false })
    await link.online()
    server.send({ type: 'commander_question', machineId: LINKED, agentId: 'a1', payload: { __e2e: { n: 0, k: 'g' } } })
    await until('the hello', () => seal.hello.mock.calls.length === 1)
    server.send({ type: 'node_status', machineId: LINKED, payload: { online: false } })
    await until('the notice passed on', () => heard.some((frame) => frame.type === 'node_status'))
    // The machine answers the hello when it is back: the replay is read.
    server.send({ type: 'e2e_welcome', machineId: LINKED, payload: { ephPub: 'E' } })
    await until('the held question', () => heard.some((frame) => frame.type === 'commander_question'))
    expect(heard.find((frame) => frame.type === 'commander_question')).toMatchObject({ agentId: 'a1' })
    expect(seal.drop).not.toHaveBeenCalled()
    expect(seal.hello).toHaveBeenCalledTimes(1)
  })

  it('reads the pinned keys once in a while for sealed frames from a machine it has no session with, not per frame', async () => {
    const { server, link, heard, peerReads } = await lane()
    await link.online()
    for (let n = 0; n < 20; n++) server.send({ type: 'commander_event', machineId: CLOUD, agentId: 'c1', payload: { __e2e: { n, k: 'g' } } })
    await until('the twenty', () => heard.length === 20)
    expect(peerReads.filter((machineId) => machineId === CLOUD).length).toBe(1)
  })

  it('holds a bounded number of frames, and none survive the lane stopping', async () => {
    const { server, seal, link, heard, lines } = await lane({ welcome: false })
    await link.online()
    for (let n = 0; n < 70; n++) server.send({ type: 'commander_event', machineId: LINKED, agentId: 'a1', payload: { __e2e: { n, k: 'g' } } })
    await until('the overflow said', () => lines.filter((line) => line.includes('held too many')).length === 6)
    expect(seal.hello).toHaveBeenCalledTimes(1)
    server.send({ type: 'e2e_welcome', machineId: LINKED, payload: { ephPub: 'E' } })
    await until('the 64 held', () => heard.length === 64)
    expect((heard[0].payload as { opened: { n: number } }).opened.n).toBe(0)
    // Held again, then the lane stops: nothing is read afterwards.
    seal.open.mockResolvedValueOnce({ unknownEpoch: true })
    server.send({ type: 'commander_event', machineId: LINKED, agentId: 'a1', payload: { __e2e: { n: 100, k: 'g' } } })
    await until('the renewal', () => seal.hello.mock.calls.length === 2)
    link.stop()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(heard).toHaveLength(64)
  })
})

// Security review 2 on #2356, its two follow-ups.
describe('the lane\'s own bounds', () => {
  afterEach(() => { vi.useRealTimers() })

  it('keeps its linked-or-not cache bounded however many made-up machine ids a relay names', async () => {
    let now = 1_000_000
    const { server, link, heard, peerReads } = await lane({ now: () => now })
    await link.online()
    const cache = (link as unknown as { linkedCache: Map<string, unknown> }).linkedCache
    for (let n = 0; n < 1_000; n++) server.send({ type: 'commander_event', machineId: `made-up-${n}`, agentId: 'x', payload: { __e2e: { n, k: 'g' } } })
    await until('the thousand passed on', () => heard.length === 1_000, 10_000)
    expect(cache.size).toBeLessThanOrEqual(256)
    // Entries past their time go first: a few seconds on, the cache holds only what was read since.
    now += 6_000
    server.send({ type: 'commander_event', machineId: 'made-up-late', agentId: 'x', payload: { __e2e: { n: 0, k: 'g' } } })
    await until('the late one', () => heard.length === 1_001)
    expect(cache.size).toBe(1)
    // A machine read again is read fresh, never answered from an evicted entry.
    expect(peerReads.filter((machineId) => machineId === 'made-up-0')).toHaveLength(1)
    server.send({ type: 'commander_event', machineId: 'made-up-0', agentId: 'x', payload: { __e2e: { n: 1, k: 'g' } } })
    await until('made-up-0 again', () => heard.length === 1_002)
    expect(peerReads.filter((machineId) => machineId === 'made-up-0')).toHaveLength(2)
    // And the lane stopping (a revoked dial, a sign-out) forgets every machine it was told about.
    link.stop()
    expect(cache.size).toBe(0)
  })

  it('acts on a refused key only for a machine it is linked to or has a session with: made-up ids grow nothing', async () => {
    // Security review 1 on #2357: every e2e_denied recorded a quiet time for whatever id it named, never removed.
    const { server, link, lines, seal } = await lane()
    await link.online()
    const startedAt = (link as unknown as { startedAt: Map<string, unknown> }).startedAt
    for (let n = 0; n < 1_000; n++) server.send({ type: 'e2e_denied', machineId: `made-up-${n}`, payload: {} })
    // A frame the lane does act on, sent after them, marks when they have all been read.
    await link.establish(LINKED)
    server.send({ type: 'e2e_denied', machineId: LINKED, payload: {} })
    await until('the linked machine\'s denial', () => lines.some((line) => line.includes(`e2e denied ${LINKED}`)))
    expect(startedAt.size).toBe(1)
    expect(startedAt.has(LINKED)).toBe(true)
    expect(lines.filter((line) => line.includes('e2e denied made-up-'))).toHaveLength(0)
    expect(seal.drop).toHaveBeenCalledTimes(1)
  })

  it('keeps a frame held just after a renewal until the delayed renewal reads it, however slow its welcome', async () => {
    // Held at the start of the per-machine limit (30 s), renewed when it ends, welcomed just inside the hello's
    // 15 s: read 45 s after it was held. A hold time of 30 s threw it away before the renewal could read it.
    let now = 1_000_000
    const { server, seal, link, heard, lines } = await lane({ welcome: false, now: () => now })
    await link.online()
    const first = link.establish(LINKED)
    await until('the hello', () => seal.hello.mock.calls.length === 1)
    server.send({ type: 'e2e_welcome', machineId: LINKED, payload: { ephPub: 'E' } })
    await first
    // A restart: renewed at once.
    seal.open.mockResolvedValueOnce({ unknownEpoch: true })
    server.send({ type: 'commander_question', machineId: LINKED, agentId: 'a1', payload: { __e2e: { n: 0, k: 'g' } } })
    await until('the renewal hello', () => seal.hello.mock.calls.length === 2)
    server.send({ type: 'e2e_welcome', machineId: LINKED, payload: { ephPub: 'E' } })
    await until('the first replay', () => heard.some((frame) => frame.agentId === 'a1'))
    // Another restart moments later: held, and the renewal waits for the limit.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    now += 100
    seal.open.mockResolvedValueOnce({ unknownEpoch: true })
    server.send({ type: 'commander_question', machineId: LINKED, agentId: 'a2', payload: { __e2e: { n: 0, k: 'g' } } })
    await until('the limit said', () => lines.some((line) => line.includes('held until it may renew again')))
    now += 30_000
    vi.advanceTimersByTime(30_000)
    await until('the delayed renewal hello', () => seal.hello.mock.calls.length === 3)
    // Its welcome comes just inside the hello's own timeout.
    now += 14_900
    server.send({ type: 'e2e_welcome', machineId: LINKED, payload: { ephPub: 'E' } })
    await until('the second replay', () => heard.some((frame) => frame.agentId === 'a2') || lines.some((line) => line.includes('waited too long')))
    expect(lines.some((line) => line.includes('waited too long'))).toBe(false)
    expect(heard.find((frame) => frame.agentId === 'a2')).toMatchObject({ type: 'commander_question' })
  })
})
