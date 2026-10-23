import { describe, expect, it, vi } from 'vitest'
import {
  describePair,
  isRelayedPair,
  readTurn,
  relayCanReach,
  TERMINAL_P2P_DOWN_TYPES,
  TERMINAL_P2P_NEGOTIATION_TIMEOUT_MS,
  TERMINAL_P2P_UP_TYPES,
  TerminalP2pInitiator,
  TerminalP2pResponderPool,
  waitForBufferedAmountLow,
  type TerminalP2pSignal,
} from './terminalP2p.js'
import type { StunSelector } from './stunSelect.js'

/** Structurally shaped like the slice of werift's `RTCDataChannel` this function actually reads —
 *  no real WebRTC negotiation needed, same reasoning as `isRelayedPair`'s plain-string fixtures. */
function fakeChannel(initial: {
  readyState?: 'open' | 'closed' | 'connecting' | 'closing'
  bufferedAmount?: number
  asPromise?: () => Promise<unknown[]>
}) {
  return {
    readyState: initial.readyState ?? 'open',
    bufferedAmount: initial.bufferedAmount ?? 0,
    bufferedAmountLow: { asPromise: initial.asPromise ?? (() => new Promise<unknown[]>(() => {})) },
  }
}
type FakeChannel = ReturnType<typeof fakeChannel>

describe('terminal WebRTC data channel', () => {
  it('negotiates locally and carries ordered text and binary frames in both directions', async () => {
    let resolveResponderData!: (value: string) => void
    let resolveInitiatorData!: (value: Buffer) => void
    const responderData = new Promise<string>((resolve) => { resolveResponderData = resolve })
    const initiatorData = new Promise<Buffer>((resolve) => { resolveInitiatorData = resolve })
    let initiator!: TerminalP2pInitiator
    const responder = new TerminalP2pResponderPool({
      sendSignal: (_connId, type, payload) => { void initiator.handleSignal(type, payload) },
      onData: (_connId, data) => resolveResponderData(typeof data === 'string' ? data : data.toString()),
    })
    initiator = new TerminalP2pInitiator({
      policy: { enabled: true, protocolVersion: 1, stunUrls: [], openWaitMs: 1_500 },
      sendSignal: (type, payload) => { void responder.handleSignal('source-1', type, payload) },
      onData: (data) => resolveInitiatorData(typeof data === 'string' ? Buffer.from(data) : data),
    })

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      initiator.start()
      expect(await initiator.waitUntilReady(5_000)).toBe(true)
      expect(initiator.send('terminal-input')).toBe(true)
      expect(await responderData).toBe('terminal-input')
      // The answering side says where its time went: the phone times only its own steps.
      const said = log.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('[terminal-p2p] conn=source-1'))
      expect(said).toEqual([
        expect.stringMatching(/^\[terminal-p2p\] conn=source-1 answered \+\d+ms after the offer \(stun \d+ms, peer library \d+ms, gather and answer \d+ms\)$/),
        expect.stringMatching(/^\[terminal-p2p\] conn=source-1 channel open \+\d+ms after the offer, over host→host \(direct\)$/),
      ])

      expect(responder.send('source-1', Buffer.from([0x48, 0x54, 0x52, 0x4d]))).toBe(true)
      expect(await initiatorData).toEqual(Buffer.from([0x48, 0x54, 0x52, 0x4d]))
    } finally {
      log.mockRestore()
      await initiator.stop('test_complete', false)
      await responder.stop()
    }
  }, 10_000)

  it('races the policy stun urls but still offers the raw list, since peers need not agree', async () => {
    const policyUrls = ['stun:a.example:3478', 'stun:b.example:3478']
    // Returning [] keeps werift on host candidates, so the offer is emitted immediately instead of
    // waiting out a gather against hosts that do not resolve.
    const selectStunUrls = vi.fn<StunSelector>(async () => ({ urls: [], udpReachable: null }))
    let resolveOffer!: (payload: TerminalP2pSignal) => void
    const offered = new Promise<TerminalP2pSignal>((resolve) => { resolveOffer = resolve })
    const initiator = new TerminalP2pInitiator({
      policy: { enabled: true, protocolVersion: 1, stunUrls: policyUrls, openWaitMs: 1_500 },
      sendSignal: (type, payload) => { if (type === 'p2p_offer') resolveOffer(payload) },
      onData: () => { /* no peer in this test */ },
      selectStunUrls,
    })

    try {
      initiator.start()
      const offer = await offered
      expect(selectStunUrls).toHaveBeenCalledTimes(1)
      expect(selectStunUrls).toHaveBeenCalledWith(policyUrls)
      // The winner is deliberately NOT pinned into the offer: the responder races the same list for
      // itself, and a srflx candidate is each peer's own public address, so they need not agree.
      expect(offer.stunUrls).toEqual(policyUrls)
    } finally {
      await initiator.stop('test_complete', false)
    }
  }, 15_000)

  it('builds one peer connection when start() is called twice during the stun race', async () => {
    let release!: (selection: { urls: string[]; udpReachable: boolean | null }) => void
    const gate = new Promise<{ urls: string[]; udpReachable: boolean | null }>((resolve) => { release = resolve })
    const selectStunUrls = vi.fn<StunSelector>(() => gate)
    const initiator = new TerminalP2pInitiator({
      policy: { enabled: true, protocolVersion: 1, stunUrls: ['stun:a.example:3478', 'stun:b.example:3478'], openWaitMs: 1_500 },
      sendSignal: () => { /* nothing to signal in this test */ },
      onData: () => { /* no peer in this test */ },
      selectStunUrls,
    })

    try {
      initiator.start()
      initiator.start()
      expect(selectStunUrls).toHaveBeenCalledTimes(1)
    } finally {
      release({ urls: [], udpReachable: null })
      await initiator.stop('test_complete', false)
    }
  })

  it('builds nothing at all when stop() lands while the stun race is still in flight', async () => {
    let release!: (selection: { urls: string[]; udpReachable: boolean | null }) => void
    const gate = new Promise<{ urls: string[]; udpReachable: boolean | null }>((resolve) => { release = resolve })
    const states: string[] = []
    const signals: string[] = []
    const initiator = new TerminalP2pInitiator({
      policy: { enabled: true, protocolVersion: 1, stunUrls: ['stun:a.example:3478', 'stun:b.example:3478'], openWaitMs: 1_500 },
      sendSignal: (type) => { signals.push(type) },
      onData: () => { /* no peer in this test */ },
      onState: (state) => { states.push(state) },
      selectStunUrls: () => gate,
    })

    initiator.start()
    const ready = initiator.waitUntilReady(5_000)
    await initiator.stop('test_complete', false)
    release({ urls: [], udpReachable: null })
    await new Promise((resolve) => setTimeout(resolve, 20))

    // No offer was ever sent, which is the observable proof no RTCPeerConnection was constructed —
    // one built after stop() would be an orphan with live UDP sockets nothing would ever close.
    expect(signals).not.toContain('p2p_offer')
    expect(await ready).toBe(false)
    expect(states).toEqual(['connecting', 'closed'])
  })

  it('fails on the negotiation timeout even if the stun race never settles', async () => {
    vi.useFakeTimers()
    const states: Array<{ state: string; reason?: string }> = []
    const initiator = new TerminalP2pInitiator({
      policy: { enabled: true, protocolVersion: 1, stunUrls: ['stun:a.example:3478', 'stun:b.example:3478'], openWaitMs: 1_500 },
      sendSignal: () => { /* nothing to signal in this test */ },
      onData: () => { /* no peer in this test */ },
      onState: (state, _setupMs, reason) => { states.push({ state, reason }) },
      selectStunUrls: () => new Promise(() => { /* wedged on purpose */ }),
    })

    try {
      initiator.start()
      await vi.advanceTimersByTimeAsync(TERMINAL_P2P_NEGOTIATION_TIMEOUT_MS + 1)
      expect(states).toContainEqual({ state: 'failed', reason: 'negotiation_timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('builds no responder for a connection that went away while its offer was in the stun race', async () => {
    // The gateway's P2P signals no longer wait behind the connection's other frames, so its disconnect can
    // land while an offer is still racing STUN — and the responder used to be built anyway, a TURN
    // allocation with it, for nobody, until the negotiation timeout.
    let resolveOffer!: (payload: TerminalP2pSignal) => void
    const offered = new Promise<TerminalP2pSignal>((resolve) => { resolveOffer = resolve })
    const initiator = new TerminalP2pInitiator({
      policy: { enabled: true, protocolVersion: 1, stunUrls: [], openWaitMs: 1_500 },
      sendSignal: (type, payload) => { if (type === 'p2p_offer') resolveOffer(payload) },
      onData: () => { /* no peer in this test */ },
      selectStunUrls: async () => ({ urls: [], udpReachable: null }),
    })
    initiator.start()
    const offer = await offered
    await initiator.stop('test_complete', false)

    let release!: (selection: { urls: string[]; udpReachable: boolean | null }) => void
    const gate = new Promise<{ urls: string[]; udpReachable: boolean | null }>((resolve) => { release = resolve })
    const signals: string[] = []
    const responder = new TerminalP2pResponderPool({
      sendSignal: (_connId, type) => { signals.push(type) },
      onData: () => { /* no data in this test */ },
      selectStunUrls: () => gate,
    })
    try {
      const answering = responder.handleSignal('source-1', 'p2p_offer', offer)
      await responder.closeConnection('source-1', 'client_disconnected', false)
      release({ urls: [], udpReachable: null })
      await answering
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(signals).toEqual([])
      expect(responder.send('source-1', 'anything')).toBe(false)
    } finally {
      await responder.stop()
    }
  })

  it('hands the responder the offered urls, filtered and capped, to race on its own', async () => {
    const selectStunUrls = vi.fn<StunSelector>(async (urls) => ({ urls, udpReachable: true }))
    const responder = new TerminalP2pResponderPool({
      sendSignal: () => { /* the offer below is deliberately unanswerable */ },
      onData: () => { /* no data in this test */ },
      selectStunUrls,
    })

    try {
      await responder.handleSignal('source-1', 'p2p_offer', {
        sessionId: '00000000-0000-4000-8000-000000000000',
        protocolVersion: 1,
        sdp: 'not-a-real-sdp',
        stunUrls: [
          'stun:1.example:3478', 'stun:2.example:3478', 'stun:3.example:3478',
          'stun:4.example:3478', 'stun:5.example:3478', 'stun:6.example:3478',
          'stun:7.example:3478', 'stun:8.example:3478', 'stun:9.example:3478',
          'stun:10.example:3478', 'stun:11.example:3478', 'turn:12.example:3478', 42,
        ] as unknown as string[],
      })
      expect(selectStunUrls).toHaveBeenCalledWith([
        'stun:1.example:3478', 'stun:2.example:3478', 'stun:3.example:3478', 'stun:4.example:3478',
        'stun:5.example:3478', 'stun:6.example:3478', 'stun:7.example:3478', 'stun:8.example:3478',
        'stun:9.example:3478', 'stun:10.example:3478', // the 11th valid stun: url is capped off
      ])
    } finally {
      await responder.stop()
    }
  })

  it('forwards the turn credential in the offer so the responder can allocate too', async () => {
    // Loopback discard port: werift really does try to allocate against whatever we hand it, so a real
    // hostname here would make this test wait out a live TURN negotiation. A closed local port fails
    // immediately and still proves the credential travelled.
    const turn = { urls: ['turn:127.0.0.1:9?transport=udp'], username: 'cf-user', credential: 'cf-secret' }
    let resolveOffer!: (payload: TerminalP2pSignal) => void
    const offered = new Promise<TerminalP2pSignal>((resolve) => { resolveOffer = resolve })
    const initiator = new TerminalP2pInitiator({
      policy: { enabled: true, protocolVersion: 1, stunUrls: ['stun:a.example:3478'], openWaitMs: 1_500, turn },
      sendSignal: (type, payload) => { if (type === 'p2p_offer') resolveOffer(payload) },
      onData: () => { /* no peer in this test */ },
      selectStunUrls: async () => ({ urls: [], udpReachable: null }),
    })

    try {
      initiator.start()
      // The responder is never sent a policy of its own, so the offer is its only source of credentials.
      expect((await offered).turn).toEqual(turn)
    } finally {
      await initiator.stop('test_complete', false)
    }
  }, 15_000)

  it('gives the responder the offered turn credential, and drops a malformed one', async () => {
    const seen: Array<unknown> = []
    const responder = new TerminalP2pResponderPool({
      sendSignal: () => { /* the offers below are deliberately unanswerable */ },
      onData: () => { /* no data in this test */ },
      selectStunUrls: async (urls) => ({ urls, udpReachable: true }),
    })
    const offer = (turn: unknown, sessionId: string): Promise<boolean> => responder.handleSignal('source-1', 'p2p_offer', {
      sessionId,
      protocolVersion: 1,
      sdp: 'not-a-real-sdp',
      stunUrls: ['stun:1.example:3478'],
      turn,
    })

    try {
      await offer({ urls: ['turn:x:3478?transport=udp'], username: 'u', credential: 'c' },
        '00000000-0000-4000-8000-000000000001')
      seen.push(readTurn({ urls: ['turn:x:3478?transport=udp'], username: 'u', credential: 'c' }))
      // Each of these is rejected for a different reason; all must degrade to STUN-only, not throw.
      for (const bad of [
        undefined,
        { urls: [], username: 'u', credential: 'c' },
        { urls: ['stun:x:3478'], username: 'u', credential: 'c' },
        { urls: ['turn:x:3478'], username: '', credential: 'c' },
        { urls: ['turn:x:3478'], username: 'u', credential: 42 },
        'not-an-object',
      ]) {
        expect(readTurn(bad)).toBeUndefined()
        await offer(bad, '00000000-0000-4000-8000-000000000002')
      }
      expect(seen[0]).toEqual({ urls: ['turn:x:3478?transport=udp'], username: 'u', credential: 'c' })
    } finally {
      await responder.stop()
    }
  }, 15_000)

  // Real candidate lines, captured from a forced relay-only run against Cloudflare.
  const RELAY = 'candidate:856fe30cc 1 udp 16777215 104.30.136.14 29000 typ relay raddr 14.161.43.75 rport 55397'
  const SRFLX = 'candidate:2b1f0a4c9 1 udp 1686052607 14.161.43.75 55397 typ srflx raddr 192.168.1.16 rport 55397'
  const HOST = 'candidate:9d3e77bb1 1 udp 2130706431 192.168.1.16 55397 typ host'

  it('counts a pair as relayed when EITHER end is a turn allocation', () => {
    // The half that used to be missed: our side is srflx, the peer allocated the relay, and every byte
    // still crosses Cloudflare — reading only the local candidate reported that as direct and
    // under-counted the traffic that gets billed.
    expect(isRelayedPair(SRFLX, RELAY)).toBe(true)
    expect(isRelayedPair(RELAY, SRFLX)).toBe(true)
    expect(isRelayedPair(RELAY, RELAY)).toBe(true)
  })

  it('counts a pair as direct only when neither end relays', () => {
    expect(isRelayedPair(HOST, HOST)).toBe(false)
    expect(isRelayedPair(SRFLX, SRFLX)).toBe(false)
    expect(isRelayedPair(HOST, SRFLX)).toBe(false)
    expect(isRelayedPair(SRFLX)).toBe(false) // remote unknown
  })

  it('names the nominated pair by its candidate types and says when it crosses TURN', () => {
    expect(describePair(HOST, HOST)).toBe('host→host (direct)')
    expect(describePair(SRFLX, SRFLX)).toBe('srflx→srflx (direct)')
    // A phone on 4G behind carrier NAT: its own relay candidate carries the pair.
    expect(describePair(SRFLX, RELAY)).toBe('srflx→relay (TURN)')
    expect(describePair(RELAY, HOST)).toBe('relay→host (TURN)')
    expect(describePair(SRFLX)).toBe('srflx→? (direct)') // remote unknown
  })

  it('does not mistake a host address that merely contains the word', () => {
    expect(isRelayedPair('candidate:1 1 udp 1 10.0.0.1 1 typ host raddr relay.example')).toBe(false)
  })

  describe('relayCanReach', () => {
    const pair = (local: string, remote: string) =>
      relayCanReach({ localCandidate: { type: local }, remoteCandidate: { host: remote } })

    // The 8x4090's host candidates (its LAN card, Docker and libvirt bridges): Cloudflare refuses them,
    // and waiting each one out cost the whole TURN-first negotiation (2026-10-20).
    it('drops our relay paired with an address no TURN server can reach', () => {
      for (const host of [
        '192.168.86.22', '172.17.0.1', '172.18.0.1', '192.168.122.1',
        '10.1.2.3', '172.31.255.255', '100.64.0.1', '100.127.255.254',
        '127.0.0.1', '169.254.10.10', '0.0.0.0',
        '::1', '::', 'fd7a:115c:a1e0::1', 'fc00::1', 'fe80::1', 'fe80::1%en0', '::ffff:192.168.1.1',
      ]) expect(pair('relay', host), host).toBe(false)
    })

    it('keeps our relay paired with a public address', () => {
      // 172.168/16 and 100.128/9 sit next to private ranges but are public: an office network uses 172.168.20.x.
      for (const host of [
        '42.96.33.130', '104.30.147.145', '172.168.20.132', '172.15.0.1', '172.32.0.1',
        '100.63.255.255', '100.128.0.1', '2606:4700::1', '::ffff:42.96.33.130',
      ]) expect(pair('relay', host), host).toBe(true)
    })

    it('keeps every pair our relay is not part of, so a LAN or a tailnet still connects directly', () => {
      for (const local of ['host', 'srflx', 'prflx']) {
        expect(pair(local, '192.168.86.22')).toBe(true)
        expect(pair(local, '100.101.102.103')).toBe(true)
        expect(pair(local, '127.0.0.1')).toBe(true)
      }
    })

    it('leaves a named candidate to ICE', () => {
      expect(pair('relay', '4c3b2a19-0d1e-4f5a-8b6c-7d8e9f0a1b2c.local')).toBe(true)
    })
  })

  // Regression: a burst of sends (a chunked upload's chunks, fired back-to-back) can cross
  // TERMINAL_P2P_MAX_BUFFERED_BYTES well before the real network drains the backlog — this is the
  // wait this puts to use instead of every send() in that window being mistaken for a dead channel.
  describe('waitForBufferedAmountLow', () => {
    const wait = (channel: FakeChannel, timeoutMs = 1_000) =>
      waitForBufferedAmountLow(channel as unknown as Parameters<typeof waitForBufferedAmountLow>[0], timeoutMs)

    it('resolves immediately when the buffer is already under the ceiling', async () => {
      const channel = fakeChannel({ bufferedAmount: 0 })
      await expect(wait(channel)).resolves.toBe(true)
    })

    it('fails fast with no wait when the channel is not open', async () => {
      const asPromise = vi.fn(() => new Promise<unknown[]>(() => {}))
      const channel = fakeChannel({ readyState: 'closed', bufferedAmount: 5_000_000, asPromise })
      await expect(wait(channel)).resolves.toBe(false)
      expect(asPromise).not.toHaveBeenCalled() // a dead channel is never worth waiting on
    })

    it('waits for the drain event, then re-checks the buffer before resolving true', async () => {
      const channel = fakeChannel({ bufferedAmount: 5_000_000, asPromise: () => Promise.resolve([]) })
      const result = wait(channel)
      channel.bufferedAmount = 0 // the buffer clears right as the event fires
      await expect(result).resolves.toBe(true)
    })

    it('resolves false if the buffer is still over the ceiling once the event fires', async () => {
      const channel = fakeChannel({ bufferedAmount: 5_000_000, asPromise: () => Promise.resolve([]) })
      await expect(wait(channel)).resolves.toBe(false) // bufferedAmount never actually dropped
    })

    it('resolves false when the wait itself times out', async () => {
      const channel = fakeChannel({ bufferedAmount: 5_000_000, asPromise: () => Promise.reject(new Error('timeout')) })
      await expect(wait(channel)).resolves.toBe(false)
    })
  })

  // Regression: a JSON type these two allowlists don't know about is silently dropped the instant a
  // pane's connection is on a direct p2p data channel (backendSocket.ts's `handleP2pData` / remoteRelay.ts's
  // p2p-data handler) — no error, no log, indistinguishable from the wire itself hanging. That's exactly
  // what happened to the chunked-upload types when they were added to the JSON protocol but not here.
  it('carries the chunked-upload begin/cancel down and its results/progress up', () => {
    expect(TERMINAL_P2P_DOWN_TYPES.has('terminal_chunked_upload_begin')).toBe(true)
    expect(TERMINAL_P2P_DOWN_TYPES.has('terminal_chunked_upload_cancel')).toBe(true)
    expect(TERMINAL_P2P_UP_TYPES.has('terminal_chunked_upload_begin_result')).toBe(true)
    expect(TERMINAL_P2P_UP_TYPES.has('terminal_chunked_upload_progress')).toBe(true)
    expect(TERMINAL_P2P_UP_TYPES.has('terminal_paste_image_result')).toBe(true)
    expect(TERMINAL_P2P_UP_TYPES.has('terminal_paste_file_result')).toBe(true)
  })
})
