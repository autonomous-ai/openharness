/**
 * P0 — the pair brain's contract and sealing (daemons/BRAIN.md).
 *
 * The frames between two machines' daemons carry question text and recaps, and one of them keys an
 * answer into a pane. Every one is sealed pairwise; the relay reads the outer type and nothing else, and
 * nothing it writes in the clear is believed. Driven against the REAL E2eeManager and RelaySessionCrypto,
 * so a type missing from applicationFrames.ts fails here rather than travelling plaintext.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as C from '../lib/e2ee/core.js'
import { RelaySessionCrypto } from '../lib/e2ee/relayClient.js'
import {
  admitRelayedPairFrame, encryptDownFrame, encryptRpcResult, PAIR_PUSHES, PAIR_REQUESTS, PAIR_RESULTS,
} from '../lib/e2ee/applicationFrames.js'
import { BackendSocket } from '../backendSocket.js'
import type { PairEvent, PairService, PairSnapshot } from './protocol.js'

type Frame = Record<string, unknown>

/** A paired peer (another machine's brain) with a live session on `socket`'s daemon. */
function pairedPeer(socket: BackendSocket, connId: string) {
  const e2ee = socket.e2ee as unknown as { store: { addPaired: (pub: string, label: string, at: number, role: 'web') => void; getIdentity: () => C.Identity } }
  const identity = C.newIdentity()
  e2ee.store.addPaired(C.b64e(identity.pub), 'peer brain', Date.now(), 'web')
  const sent: Array<{ connId: string; frame: Frame }> = []
  vi.spyOn(socket, 'sendTo').mockImplementation((to: string, frame: Frame) => { sent.push({ connId: to, frame }) })
  const crypto = new RelaySessionCrypto({ machineId: socket.machineId, selfIdentity: identity, peerPub: e2ee.store.getIdentity().pub })
  socket.e2ee.handleFrame(connId, crypto.helloFrame())
  const welcome = sent.pop()!
  expect(welcome.frame.type).toBe('e2e_welcome')
  expect(crypto.handleWelcome(welcome.frame.payload as Frame)).toBe(true)
  return { crypto, sent }
}

const SNAPSHOT: PairSnapshot = {
  machineId: 'machine-a', epoch: 'e1', seq: 3, rev: 7,
  harnesses: [{ agentId: 'a1', name: 'api', engine: 'claude', working: true, failing: null, lastDoneAt: null, recap: null,
    question: { requestId: 'q_1', text: 'Run the migration?', options: ['Yes', 'No'], multi: false, deny: false, allow: false, permission: false, since: 1 } }],
}

function fakeService(overrides: Partial<PairService> = {}): PairService & { pushes: Map<string, (e: PairEvent) => boolean> } {
  const pushes = new Map<string, (e: PairEvent) => boolean>()
  return {
    pushes,
    enabled: () => true,
    watch: (connId, push) => { pushes.set(connId, push); return SNAPSHOT },
    unwatch: (connId) => { pushes.delete(connId) },
    journal: () => ({ epoch: 'e1', seq: 3, entries: [] }),
    read: (payload) => ({ agentId: payload.agentId, recap: 'shipped the fix' }),
    local: async (payload) => ({ verb: payload.verb, ok: true }),
    ...overrides,
  }
}

afterEach(() => vi.restoreAllMocks())

describe('pair frames are sealed application frames', () => {
  it('registers every request, result and push, and nothing else under pair_', () => {
    expect([...PAIR_REQUESTS].sort()).toEqual(['pair_answer', 'pair_journal', 'pair_list', 'pair_pause', 'pair_read',
      'pair_resume', 'pair_send', 'pair_start', 'pair_stop', 'pair_watch'])
    expect([...PAIR_PUSHES]).toEqual(['pair_event'])
    for (const type of PAIR_REQUESTS) {
      expect(encryptDownFrame(type)).toBe(true)
      expect(encryptRpcResult(`${type}_result`)).toBe(true)
      expect(PAIR_RESULTS.has(`${type}_result`)).toBe(true)
    }
    // The loopback `pair` is never sealed going down (it never leaves this computer) but its reply is,
    // should a relayed one ever be answered LOCAL_ONLY.
    expect(encryptDownFrame('pair')).toBe(false)
    expect(encryptRpcResult('pair_result')).toBe(true)
  })

  it('seals every pair request end to end; the relay sees only the type', async () => {
    const socket = new BackendSocket('token')
    const { crypto } = pairedPeer(socket, 'peer-1')
    for (const type of PAIR_REQUESTS) {
      const request = { requestId: `${type}-1`, agentId: 'a1', question: 'Run the migration?' }
      const sealed = crypto.wrapOutgoing({ type, payload: request })
      expect(JSON.stringify(sealed)).not.toContain('migration')
      expect(sealed.payload).not.toHaveProperty('agentId')
      expect(socket.e2ee.unwrapDown('peer-1', sealed)?.payload).toEqual(request)
    }
    await socket.stop()
  })

  it('pair_event pushed with wrapTarget opens on the watching machine, and only there', async () => {
    const socket = new BackendSocket('token')
    const { crypto } = pairedPeer(socket, 'peer-1')
    const event: PairEvent = { machineId: 'machine-a', rev: 8, agentId: 'a1', harness: SNAPSHOT.harnesses[0] }
    const sealed = socket.e2ee.wrapTarget('peer-1', 'pair_event', event as unknown as Frame)!
    expect(JSON.stringify(sealed)).not.toContain('migration')
    expect(admitRelayedPairFrame(sealed)).toBe(true)
    expect(crypto.unwrapIncoming(sealed)?.payload).toEqual(event)
    // A connection with no session gets nothing at all rather than a plaintext push.
    expect(socket.e2ee.wrapTarget('stranger', 'pair_event', event as unknown as Frame)).toBeNull()
    await socket.stop()
  })

  it('the watching machine believes no pair frame the relay wrote in the clear or under the group key', () => {
    expect(admitRelayedPairFrame({ type: 'pair_event', payload: { machineId: 'm', harness: {} } })).toBe(false)
    expect(admitRelayedPairFrame({ type: 'pair_watch_result', payload: { requestId: 'r', snapshot: SNAPSHOT } })).toBe(false)
    expect(admitRelayedPairFrame({ type: 'pair_event', payload: { __e2e: { v: 1, k: 'g', n: 1, ct: 'x' } } })).toBe(false)
    expect(admitRelayedPairFrame({ type: 'pair_event', payload: null })).toBe(false)
    // An older daemon's bare refusal is the one plaintext pair frame heard: it names the machine as too old.
    expect(admitRelayedPairFrame({ type: 'pair_watch_result', payload: { requestId: 'r', error: 'UNSUPPORTED' } })).toBe(true)
    expect(admitRelayedPairFrame({ type: 'pair_event', payload: { requestId: 'r', error: 'UNSUPPORTED' } })).toBe(false)
  })
})

describe('the daemon answering another machine\'s brain', () => {
  function harness(service: PairService | null = fakeService()) {
    const socket = new BackendSocket('token')
    socket.pairService = service
    const internals = socket as unknown as { dispatchDown: (f: Frame, c: string, t?: string) => Promise<void> }
    return { socket, dispatch: (f: Frame, connId: string, transport: 'relay' | 'local' = 'relay') => internals.dispatchDown(f, connId, transport) }
  }

  it.each([...PAIR_REQUESTS])('refuses a plaintext %s from the relay with E2EE_REQUIRED, and never reaches the sensor', async (type) => {
    const service = fakeService()
    const watch = vi.spyOn(service, 'watch')
    const read = vi.spyOn(service, 'read')
    const { socket, dispatch } = harness(service)
    const replies: Frame[] = []
    vi.spyOn(socket, 'sendTo').mockImplementation((_c: string, f: Frame) => { replies.push(f) })
    await dispatch({ type, payload: { requestId: 'r1', agentId: 'a1' } }, 'web-1')
    expect(watch).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(replies).toEqual([{ type: `${type}_result`, payload: { requestId: 'r1', error: 'E2EE_REQUIRED' } }])
    await socket.stop()
  })

  it('a sealed pair_watch answers the snapshot sealed, then pushes sealed pair_event to that watcher alone', async () => {
    const service = fakeService()
    const { socket, dispatch } = harness(service)
    const { crypto, sent } = pairedPeer(socket, 'peer-1')
    vi.spyOn(socket, 'isConnected').mockReturnValue(true)
    await dispatch(crypto.wrapOutgoing({ type: 'pair_watch', payload: { requestId: 'w1' } }), 'peer-1')
    const result = sent.shift()!
    expect(result.connId).toBe('peer-1')
    expect(JSON.stringify(result.frame)).not.toContain('migration')
    expect(crypto.unwrapIncoming(result.frame)?.payload).toEqual({ requestId: 'w1', snapshot: SNAPSHOT })

    const push = service.pushes.get('peer-1')!
    expect(push({ machineId: 'machine-a', rev: 9, agentId: 'a1', harness: null, removed: true })).toBe(true)
    const pushed = sent.shift()!
    expect(pushed).toMatchObject({ connId: 'peer-1', frame: { type: 'pair_event' } })
    expect(crypto.unwrapIncoming(pushed.frame)?.payload).toMatchObject({ rev: 9, removed: true })

    // The watcher went away: its session is gone, so the next push says stop instead of going out plain.
    await dispatch({ type: '__client_disconnected', payload: {} }, 'peer-1')
    expect(service.pushes.has('peer-1')).toBe(false)
    expect(push({ machineId: 'machine-a', rev: 10, agentId: 'a1', harness: null })).toBe(false)
    await socket.stop()
  })

  it('the writes and pair_list/pair_read go to the owning machine\'s floor, sealed both ways', async () => {
    const { socket, dispatch } = harness()
    const handled: Array<[string, Frame]> = []
    socket.pairOwner = { handle: async (type, payload) => { handled.push([type, payload]); return type === 'pair_answer' ? { error: 'STALE_QUESTION', detail: 'changed' } : { ok: true } } }
    const { crypto, sent } = pairedPeer(socket, 'peer-1')
    await dispatch(crypto.wrapOutgoing({ type: 'pair_answer', payload: { requestId: 'r1', agentId: 'a1', expectRequestId: 'q1', choice: 'Yes', by: 'key' } }), 'peer-1')
    await vi.waitFor(() => expect(sent.length).toBe(1))
    const reply = sent.shift()!
    expect(JSON.stringify(reply.frame)).not.toContain('STALE_QUESTION')
    expect(crypto.unwrapIncoming(reply.frame)?.payload).toEqual({ requestId: 'r1', error: 'STALE_QUESTION', detail: 'changed' })
    for (const type of ['pair_send', 'pair_stop', 'pair_start', 'pair_pause', 'pair_resume', 'pair_list', 'pair_read']) {
      await dispatch(crypto.wrapOutgoing({ type, payload: { requestId: type, agentId: 'a1' } }), 'peer-1')
      await vi.waitFor(() => expect(sent.length).toBe(1))
      expect(crypto.unwrapIncoming(sent.shift()!.frame)?.payload).toEqual({ requestId: type, ok: true })
    }
    expect(handled.map(([type]) => type)).toEqual(['pair_answer', 'pair_send', 'pair_stop', 'pair_start', 'pair_pause', 'pair_resume', 'pair_list', 'pair_read'])
    expect(handled[0][1]).toMatchObject({ agentId: 'a1', expectRequestId: 'q1', choice: 'Yes', by: 'key' })
    await socket.stop()
  })

  it('tells the owner where a request came from; a loopback pair_* is a local process posing as a machine, refused', async () => {
    const { socket, dispatch } = harness()
    const from: unknown[] = []
    socket.pairOwner = { handle: async (_type, _payload, origin) => { from.push(origin); return { ok: true } } }
    const { crypto, sent } = pairedPeer(socket, 'peer-1')
    await dispatch(crypto.wrapOutgoing({ type: 'pair_answer', payload: { requestId: 'r1', agentId: 'a1', expectRequestId: 'q1', choice: 'Yes' } }), 'peer-1')
    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(from).toEqual([{ connId: 'peer-1', label: 'peer brain' }])
    sent.length = 0
    socket.registerLocalClient('local:script', { sendFrame: () => true, sendBinary: () => true })
    for (const type of ['pair_answer', 'pair_send', 'pair_watch', 'pair_read']) {
      await dispatch({ type, payload: { requestId: type, agentId: 'a1', expectRequestId: 'q1', choice: 'Yes', by: 'key' } }, 'local:script', 'local')
    }
    await vi.waitFor(() => expect(sent.length).toBe(4))
    expect(sent.map((r) => [r.connId, (r.frame.payload as Frame).error])).toEqual([['local:script', 'REMOTE_ONLY'], ['local:script', 'REMOTE_ONLY'], ['local:script', 'REMOTE_ONLY'], ['local:script', 'REMOTE_ONLY']])
    expect(from).toHaveLength(1)
    await socket.unregisterLocalClient('local:script')
    await socket.stop()
  })

  it('pair_journal and pair_read answer sealed; the writes are UNSUPPORTED with no owner, like an older daemon', async () => {
    const { socket, dispatch } = harness()
    const { crypto, sent } = pairedPeer(socket, 'peer-1')
    for (const [type, expected] of [
      ['pair_journal', { epoch: 'e1', seq: 3, entries: [] }],
      ['pair_read', { agentId: 'a1', recap: 'shipped the fix' }],
      ['pair_answer', { error: 'UNSUPPORTED' }],
      ['pair_pause', { error: 'UNSUPPORTED' }],
    ] as const) {
      await dispatch(crypto.wrapOutgoing({ type, payload: { requestId: type, agentId: 'a1', choice: 'Yes' } }), 'peer-1')
      const reply = sent.shift()!
      expect(reply.frame.type).toBe(`${type}_result`)
      expect(crypto.unwrapIncoming(reply.frame)?.payload).toEqual({ requestId: type, ...expected })
    }
    await socket.stop()
  })

  it('answers like an older daemon with no sensor, and PAIR_OFF while pairing is off', async () => {
    for (const [service, error] of [[null, 'UNSUPPORTED'], [fakeService({ enabled: () => false }), 'PAIR_OFF']] as const) {
      const { socket, dispatch } = harness(service)
      const { crypto, sent } = pairedPeer(socket, 'peer-1')
      await dispatch(crypto.wrapOutgoing({ type: 'pair_watch', payload: { requestId: 'w' } }), 'peer-1')
      expect(crypto.unwrapIncoming(sent.shift()!.frame)?.payload).toEqual({ requestId: 'w', error })
      await socket.stop()
    }
  })

  it('the `pair` request is local-only: a relayed one, even sealed, is refused without reaching the sensor', async () => {
    const service = fakeService()
    const local = vi.spyOn(service, 'local')
    const { socket, dispatch } = harness(service)
    const { crypto, sent } = pairedPeer(socket, 'peer-1')
    // A client never seals `pair` (it is not a machine-to-machine type), so seal one by hand: a paired
    // peer that goes out of its way to must still be refused.
    const keys = crypto as unknown as { c2s: Uint8Array; c2sCounter: number }
    const sealedPair = { type: 'pair', payload: C.wrapPayload(keys.c2s, 'p', keys.c2sCounter++, 'pair', undefined, { requestId: 'p1', verb: 'list' }) }
    await dispatch(sealedPair, 'peer-1')
    await dispatch({ type: 'pair', payload: { requestId: 'p2', verb: 'list' } }, 'peer-1')
    expect(local).not.toHaveBeenCalled()
    // Sealed or not, the relayed reply is a refusal, sealed to that connection — never a broadcast.
    const refusals = sent.map(({ frame }) => crypto.unwrapIncoming(frame)?.payload)
    expect(refusals).toContainEqual({ requestId: 'p1', error: 'LOCAL_ONLY', detail: 'Ask the pair brain on this computer.' })
    expect(refusals).toContainEqual({ requestId: 'p2', error: 'E2EE_REQUIRED' })

    socket.registerLocalClient('local:window', { sendFrame: () => true, sendBinary: () => true })
    socket.handleLocalFrame('local:window', { type: 'pair', payload: { requestId: 'p3', verb: 'list' } })
    await vi.waitFor(() => expect(sent).toContainEqual({ connId: 'local:window', frame: { type: 'pair_result', payload: { requestId: 'p3', verb: 'list', ok: true } } }))
    expect(local).toHaveBeenCalledTimes(1)
    await socket.unregisterLocalClient('local:window')
    await socket.stop()
  })

  it('the `pair` request answers DAEMONS_OFF while daemons are off, before the control interface or the sensor', async () => {
    const service = fakeService()
    const local = vi.spyOn(service, 'local')
    const { socket } = harness(service)
    const control = vi.fn(async (payload: Record<string, unknown>) => ({ ok: true, verb: payload.verb }))
    socket.pairControl = { verbs: new Set(['list_harnesses', 'lessons']), local: control }
    let on = false
    socket.daemonsOn = () => on
    const sent: Array<{ connId: string; frame: Frame }> = []
    vi.spyOn(socket, 'sendTo').mockImplementation((to: string, frame: Frame) => { sent.push({ connId: to, frame }) })
    socket.registerLocalClient('local:tool', { sendFrame: () => true, sendBinary: () => true }, { tool: true })
    for (const [requestId, verb] of [['p1', 'status'], ['p2', 'list_harnesses'], ['p3', 'lessons']]) {
      socket.handleLocalFrame('local:tool', { type: 'pair', payload: { requestId, verb } })
    }
    await vi.waitFor(() => expect(sent).toHaveLength(3))
    for (const { frame } of sent) expect((frame.payload as Frame).error).toBe('DAEMONS_OFF')
    expect(local).not.toHaveBeenCalled()
    expect(control).not.toHaveBeenCalled()
    // On again: the verbs run as they always did.
    on = true
    socket.handleLocalFrame('local:tool', { type: 'pair', payload: { requestId: 'p4', verb: 'list_harnesses' } })
    await vi.waitFor(() => expect(sent).toContainEqual({ connId: 'local:tool', frame: { type: 'pair_result', payload: { requestId: 'p4', ok: true, verb: 'list_harnesses' } } }))
    await socket.unregisterLocalClient('local:tool')
    await socket.stop()
  })
})
