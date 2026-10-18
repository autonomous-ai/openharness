import { expect, it, vi } from 'vitest'

// What the initiator hands werift, without negotiating: the peer connection is refused at construction.
const configs: Array<{ iceTransportPolicy?: string }> = []
vi.mock('werift', () => ({
  RTCPeerConnection: class {
    constructor(config: { iceTransportPolicy?: string }) {
      configs.push(config)
      throw new Error('construction is all this spec reads')
    }
  },
}))

const { TerminalP2pInitiator } = await import('./terminalP2p.js')

const turn = { urls: ['turn:turn.example:3478?transport=udp'], username: 'u', credential: 'c' }

async function gatherPolicy(relayOnly: boolean, withTurn = true): Promise<string | undefined> {
  let failed!: () => void
  const done = new Promise<void>((resolve) => { failed = resolve })
  const peer = new TerminalP2pInitiator({
    policy: { enabled: true, protocolVersion: 1, stunUrls: [], openWaitMs: 0, ...(withTurn ? { turn } : {}) },
    relayOnly,
    sendSignal() {},
    onData() {},
    selectStunUrls: async () => ({ urls: [], udpReachable: true }),
    onState: (state) => { if (state === 'failed') failed() },
  })
  peer.start()
  await done
  await peer.stop('test_complete', false)
  return configs.pop()?.iceTransportPolicy
}

// Seen 2026-10-16: every negotiation to a machine only TURN reaches spent 8–10s on direct pairs first.
it('a TURN-first negotiation gathers relay candidates only; every other one gathers everything', async () => {
  expect(await gatherPolicy(true)).toBe('relay')
  expect(await gatherPolicy(false)).toBeUndefined()
  // Nothing to gather TURN-first without a TURN credential.
  expect(await gatherPolicy(true, false)).toBeUndefined()
})
