/**
 * A session between two machines of a shared tab that belong to different accounts
 * (docs/superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md, "Messages across accounts").
 *
 * Not the gateway's handshake for this account's own clients (`E2eeManager`): that one trusts a key it finds
 * paired or in the device log, and answering a member's machine there would pair it as a client of this account.
 * Not `RelaySessionCrypto` either, which seals only the frame types it lists and sends any other in the clear.
 * Here each side proves the identity key the roster lists for its machine, the context binds the shared tab and
 * both machines in order, and every frame is sealed, with a replay window as the account's own sessions have.
 */
import {
  b64d, b64e, helloSig, helloVerify, newEphemeral, sessionKeys, unwrapPayload, welcomeSig, welcomeVerify, wrapPayload,
  type Identity, type WrappedPayload,
} from './core.js'
import { ReplayWindow } from './replayWindow.js'

export type TabHello = { ephemeral: string; signature: string }
export type TabWelcome = { ephemeral: string; signature: string }

/**
 * One size ceiling for a shared tab, end to end. A frame on the relay is at most SHARED_TAB_FRAME_MAX bytes: the
 * gateway refuses a bigger one (gateway/tabRelay.ts `TAB_RELAY_MAX_FRAME`) before the relay would close the socket on
 * it (backend agentMessagesWs.ts `MAX_FRAME`), so a sealed value longer than that never came off the relay whole.
 * Measured 2026-10-15 (tabSession.spec.ts): a 16,000-character message sealed into a frame is 23,007 bytes in plain
 * text and 129,675 at worst (every character one JSON writes as six), 1,397 under the ceiling.
 */
export const SHARED_TAB_FRAME_MAX = 128 * 1024
/**
 * The largest roster body a member takes (roster.ts `verifyRoster`), counted in bytes. Three quarters of the frame,
 * for base64; the backend stores the body with its signature up to 128 KiB (agentMessageShares.ts `ROSTER_MAX_BYTES`).
 * The biggest roster the limits allow with plain names is a 37 KB body, a 52 KB frame.
 */
export const ROSTER_BODY_MAX = 96 * 1024
const MAX_CT = SHARED_TAB_FRAME_MAX

/** A relay frame around an empty sealed value, at its largest: to a machine id at the relay's 128 characters, at the
 *  highest counter a sender reaches. */
const FRAME_OVERHEAD = Buffer.byteLength(JSON.stringify({ type: 'amsg_frame', to: 'm'.repeat(128),
  payload: { __e2e: { v: 1, k: 'p', n: Number.MAX_SAFE_INTEGER, ct: '' } } }))

/**
 * The most bytes `frame` takes on the relay once a `TabCipher` sealed it and the gateway wrapped it (gateway/tabRelay.ts
 * `send`): the arithmetic of `wrapPayload`, without a key. Its JSON in UTF-8 (JSON writes a lone surrogate as an ASCII
 * escape, so UTF-8 never replaces one), a 16-byte tag, base64 (which JSON never escapes). Exact but for the counter's
 * digits and the length of `to`, taken at their largest. The owner checks a roster against it before signing
 * (roster.ts `fitsRoster`): one that does not fit would be refused by its own gateway for every member.
 */
export function sealedFrameBytes(frame: Record<string, unknown>): number {
  return FRAME_OVERHEAD + 4 * Math.ceil((Buffer.byteLength(JSON.stringify(frame)) + 16) / 3)
}

export const tabContext = (sharedTabId: string, initiator: string, responder: string): string =>
  `harness-tab-v1:${sharedTabId}:${initiator}:${responder}`

export class TabCipher {
  private tx = 0
  private readonly window = new ReplayWindow()
  constructor(private readonly sendKey: Uint8Array, private readonly receiveKey: Uint8Array,
    private readonly context: string) {}
  seal(frame: Record<string, unknown>): WrappedPayload {
    return wrapPayload(this.sendKey, 'p', this.tx++, 'tab_frame', this.context, frame)
  }
  open(value: unknown): Record<string, unknown> | null {
    const e = (value as WrappedPayload | null)?.__e2e
    if (!e || e.v !== 1 || e.k !== 'p' || typeof e.ct !== 'string' || e.ct.length > MAX_CT
      || !this.window.allows(e.n)) return null
    const frame = unwrapPayload(this.receiveKey, e, 'tab_frame', this.context)
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null
    this.window.commit(e.n)
    return frame as Record<string, unknown>
  }
}

/** Decodes a base64 value that must be exactly `length` bytes. The values are JSON that came off a relay, so
 *  anything that is not a string is refused here instead of reaching `Buffer.from`. The daemon runs on Node, where `b64d` skips
 *  what is not base64 instead of throwing, so a malformed value shows up as the wrong length. */
const exactly = (value: unknown, length: number): Uint8Array | null => {
  if (typeof value !== 'string') return null
  const bytes = b64d(value)
  return bytes.length === length ? bytes : null
}
const key = (value: unknown): Uint8Array | null => exactly(value, 32)
const sig = (value: unknown): Uint8Array | null => exactly(value, 64)

/** The peer's ephemeral key is wire input: a roster-listed peer can sign a low-order or all-zero point, which
 *  makes the key agreement throw, and that must refuse the session, not crash the caller. */
const derive = (...args: Parameters<typeof sessionKeys>): ReturnType<typeof sessionKeys> | null => {
  try { return sessionKeys(...args) } catch { return null }
}

export function startTabSession(self: Identity, sharedTabId: string, selfMachine: string, peerMachine: string) {
  const context = tabContext(sharedTabId, selfMachine, peerMachine)
  const eph = newEphemeral()
  const hello: TabHello = { ephemeral: b64e(eph.pub), signature: b64e(helloSig(self.priv, context, eph.pub)) }
  // One-shot: a second finish would give a second cipher with the same send key and counter from zero, so a
  // relay replaying the welcome could make this side reuse a nonce. Even a failed first call spends it.
  let done = false
  return {
    hello,
    finish(welcome: TabWelcome, peerPub: string): TabCipher | null {
      if (done) return null
      done = true
      const theirs = key(welcome.ephemeral), pub = key(peerPub), signature = sig(welcome.signature)
      if (!theirs || !pub || !signature || !welcomeVerify(pub, context, eph.pub, theirs, signature)) return null
      const keys = derive(eph.priv, theirs, context, eph.pub, theirs)
      return keys && new TabCipher(keys.c2s, keys.s2c, context)
    },
  }
}

export function acceptTabSession(self: Identity, sharedTabId: string, peerMachine: string, selfMachine: string,
  hello: TabHello, peerPub: string): { welcome: TabWelcome; cipher: TabCipher } | null {
  const context = tabContext(sharedTabId, peerMachine, selfMachine)
  const theirs = key(hello.ephemeral), pub = key(peerPub), signature = sig(hello.signature)
  if (!theirs || !pub || !signature || !helloVerify(pub, context, theirs, signature)) return null
  const eph = newEphemeral()
  const keys = derive(eph.priv, theirs, context, theirs, eph.pub)
  if (!keys) return null
  return {
    welcome: { ephemeral: b64e(eph.pub), signature: b64e(welcomeSig(self.priv, context, theirs, eph.pub)) },
    cipher: new TabCipher(keys.s2c, keys.c2s, context),
  }
}
