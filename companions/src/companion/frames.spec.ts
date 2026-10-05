/**
 * P0 — the pair brain's contract and sealing (daemons/BRAIN.md).
 *
 * The frames between two machines' daemons carry question text and recaps, and one of them keys an
 * answer into a pane. Every one is sealed pairwise; the relay reads the outer type and nothing else, and
 * nothing it writes in the clear is believed. Driven against the REAL E2eeManager and RelaySessionCrypto,
 * so a type missing from applicationFrames.ts fails here rather than travelling plaintext.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as C from '../../../cli/src/lib/e2ee/core.js'
import { RelaySessionCrypto } from '../../../cli/src/lib/e2ee/relayClient.js'
import {
  admitRelayedPairFrame, encryptDownFrame, encryptRpcResult, PAIR_PUSHES, PAIR_REQUESTS, PAIR_RESULTS, PLATE_REQUEST, PLATE_RESULT,
} from '../../../cli/src/lib/e2ee/applicationFrames.js'
import { BackendSocket } from '../../../cli/src/backendSocket.js'
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
