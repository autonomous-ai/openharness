import { describe, expect, it } from 'vitest'
import { b64e, helloSig, newIdentity, welcomeSig } from './core.js'
import { acceptTabSession, ROSTER_BODY_MAX, SHARED_TAB_FRAME_MAX, sealedFrameBytes, startTabSession, tabContext, TabCipher } from './tabSession.js'

const alice = newIdentity(), bob = newIdentity(), mallory = newIdentity()
const TAB = 'a1b2c3d4e5f6a1b2c3d4e5f6'

function pair() {
  const start = startTabSession(alice, TAB, 'alice-mac', 'bob-mini')
  const accepted = acceptTabSession(bob, TAB, 'alice-mac', 'bob-mini', start.hello, b64e(alice.pub))!
  const mine = start.finish(accepted.welcome, b64e(bob.pub))!
  return { mine, theirs: accepted.cipher }
}

describe('a session between two machines of a shared tab', () => {
  it('binds the context to the tab and both machines, in order', () => {
    expect(tabContext(TAB, 'a', 'b')).toBe(`harness-tab-v1:${TAB}:a:b`)
    expect(tabContext(TAB, 'a', 'b')).not.toBe(tabContext(TAB, 'b', 'a'))
  })

  it('carries frames both ways once each side proved the key the roster lists', () => {
    const { mine, theirs } = pair()
    expect(theirs.open(mine.seal({ type: 'deliver', text: 'hi' }))).toEqual({ type: 'deliver', text: 'hi' })
    expect(mine.open(theirs.seal({ type: 'status', ok: true }))).toEqual({ type: 'status', ok: true })
  })

  it('refuses a hello signed by a key the roster does not list', () => {
    const start = startTabSession(mallory, TAB, 'alice-mac', 'bob-mini')
    expect(acceptTabSession(bob, TAB, 'alice-mac', 'bob-mini', start.hello, b64e(alice.pub))).toBeNull()
  })

  it('refuses a welcome signed by a key the roster does not list', () => {
    const start = startTabSession(alice, TAB, 'alice-mac', 'bob-mini')
    const forged = acceptTabSession(mallory, TAB, 'alice-mac', 'bob-mini', start.hello, b64e(alice.pub))!
    expect(start.finish(forged.welcome, b64e(bob.pub))).toBeNull()
  })

  it('refuses a hello made for another tab or another machine pair', () => {
    const start = startTabSession(alice, 'f'.repeat(24), 'alice-mac', 'bob-mini')
    expect(acceptTabSession(bob, TAB, 'alice-mac', 'bob-mini', start.hello, b64e(alice.pub))).toBeNull()
    const other = startTabSession(alice, TAB, 'alice-mac', 'carol-pc')
    expect(acceptTabSession(bob, TAB, 'alice-mac', 'bob-mini', other.hello, b64e(alice.pub))).toBeNull()
  })

  it('refuses malformed keys and signatures instead of throwing', () => {
    const start = startTabSession(alice, TAB, 'alice-mac', 'bob-mini')
    expect(acceptTabSession(bob, TAB, 'alice-mac', 'bob-mini', { ...start.hello, ephemeral: 'AAAA' }, b64e(alice.pub))).toBeNull()
    expect(acceptTabSession(bob, TAB, 'alice-mac', 'bob-mini', start.hello, 'AAAA')).toBeNull()
    expect(acceptTabSession(bob, TAB, 'alice-mac', 'bob-mini', { ephemeral: start.hello.ephemeral, signature: '!!' }, b64e(alice.pub))).toBeNull()
    expect(start.finish({ ephemeral: 'AAAA', signature: 'AAAA' }, b64e(bob.pub))).toBeNull()
  })

  it('refuses a replayed, altered or foreign frame', () => {
    const { mine, theirs } = pair()
    const sealed = mine.seal({ n: 1 })
    expect(theirs.open(sealed)).toEqual({ n: 1 })
    expect(theirs.open(sealed)).toBeNull()
    const altered = mine.seal({ n: 2 }); altered.__e2e.ct = altered.__e2e.ct.replace(/^./, c => (c === 'A' ? 'B' : 'A'))
    expect(theirs.open(altered)).toBeNull()
    expect(pair().theirs.open(mine.seal({ n: 3 }))).toBeNull()
    expect(theirs.open(null)).toBeNull()
    expect(theirs.open({ __e2e: { v: 1, k: 'g', n: 9, ct: 'AA' } })).toBeNull()
    expect(theirs.open({ __e2e: { v: 1, k: 'p', n: 9, ct: 'x'.repeat(300_000) } })).toBeNull()
  })

  it('opens frames that arrive out of order within the window', () => {
    const { mine, theirs } = pair()
    const first = mine.seal({ n: 1 }), second = mine.seal({ n: 2 })
    expect(theirs.open(second)).toEqual({ n: 2 })
    expect(theirs.open(first)).toEqual({ n: 1 })
  })

  it('refuses a frame whose plaintext is not an object', () => {
    const { mine, theirs } = pair()
    expect(theirs.open((mine as unknown as { seal(f: unknown): unknown }).seal([1, 2]))).toBeNull()
    expect(TabCipher).toBeTypeOf('function')
  })

  it('refuses values that are not strings instead of throwing', () => {
    const start = startTabSession(alice, TAB, 'alice-mac', 'bob-mini')
    const bad = [undefined, null, 7, {}] as unknown as string[]
    for (const v of bad) {
      expect(acceptTabSession(bob, TAB, 'alice-mac', 'bob-mini', { ...start.hello, ephemeral: v }, b64e(alice.pub))).toBeNull()
      expect(acceptTabSession(bob, TAB, 'alice-mac', 'bob-mini', { ...start.hello, signature: v }, b64e(alice.pub))).toBeNull()
      expect(acceptTabSession(bob, TAB, 'alice-mac', 'bob-mini', start.hello, v)).toBeNull()
    }
    const accepted = acceptTabSession(bob, TAB, 'alice-mac', 'bob-mini', start.hello, b64e(alice.pub))!
    for (const v of bad) {
      expect(startTabSession(alice, TAB, 'alice-mac', 'bob-mini').finish({ ...accepted.welcome, ephemeral: v }, b64e(bob.pub))).toBeNull()
      expect(startTabSession(alice, TAB, 'alice-mac', 'bob-mini').finish({ ...accepted.welcome, signature: v }, b64e(bob.pub))).toBeNull()
      expect(startTabSession(alice, TAB, 'alice-mac', 'bob-mini').finish(accepted.welcome, v)).toBeNull()
    }
  })

  it('refuses a correctly signed all-zero ephemeral key on both sides', () => {
    const zero = new Uint8Array(32)
    const ctx = tabContext(TAB, 'alice-mac', 'bob-mini')
    const hello = { ephemeral: b64e(zero), signature: b64e(helloSig(alice.priv, ctx, zero)) }
    expect(acceptTabSession(bob, TAB, 'alice-mac', 'bob-mini', hello, b64e(alice.pub))).toBeNull()
    const start = startTabSession(alice, TAB, 'alice-mac', 'bob-mini')
    const mine = new Uint8Array(Buffer.from(start.hello.ephemeral, 'base64'))
    const welcome = { ephemeral: b64e(zero), signature: b64e(welcomeSig(bob.priv, ctx, mine, zero)) }
    expect(start.finish(welcome, b64e(bob.pub))).toBeNull()
  })

  it('finishes only once, so a replayed welcome cannot make a second cipher with the same nonces', () => {
    const start = startTabSession(alice, TAB, 'alice-mac', 'bob-mini')
    const accepted = acceptTabSession(bob, TAB, 'alice-mac', 'bob-mini', start.hello, b64e(alice.pub))!
    expect(start.finish(accepted.welcome, b64e(bob.pub))).not.toBeNull()
    expect(start.finish(accepted.welcome, b64e(bob.pub))).toBeNull()
  })

  it('one size ceiling: a 128 KiB frame and a 96 KiB roster body, and a sealed frame longer than the frame is refused', () => {
    expect(SHARED_TAB_FRAME_MAX).toBe(128 * 1024)
    expect(ROSTER_BODY_MAX).toBe(96 * 1024)
    const { mine, theirs } = pair()
    // Sealed for real, so only the length can refuse it: the cipher's old 256 KiB ceiling opened it.
    const big = mine.seal({ pad: 'x'.repeat(100_000) })
    expect(big.__e2e.ct.length).toBeGreaterThan(SHARED_TAB_FRAME_MAX)
    expect(theirs.open(big)).toBeNull()
    expect(theirs.open(mine.seal({ pad: 'x'.repeat(90_000) }))).toEqual({ pad: 'x'.repeat(90_000) })
  })

  it('fits a 16,000-character message in one relay frame, whatever its characters', () => {
    // The relay frame a sealed message travels in (gateway/tabRelay.ts `send`), to a machine id at the relay's 128.
    const { mine } = pair()
    const frame = (payload: Record<string, unknown>) =>
      Buffer.byteLength(JSON.stringify({ type: 'amsg_frame', to: 'm'.repeat(128), payload: mine.seal(payload) }))
    const person = (i: number) => ({ machineId: '6f1c2a4e-1b7d-4c55-9a0e-1234567890ab', agentId: `agent-${i}-0123456789`, name: `teammate-${i}` })
    const message = (text: string) => ({ kind: 'message', message: { id: 'm1234567', tabId: 'tab-1',
      from: { ...person(0), engine: 'claude', machine: 'alice-studio' }, to: Array.from({ length: 8 }, (_, i) => person(i + 1)), text, at: 1_760_000_000_000 } })
    // Measured 2026-10-15: plain text 23,007 bytes; three-byte characters 65,675; quotes 44,343. The worst is a
    // character JSON writes as six (a control character, a lone surrogate): 129,675 bytes, 1,397 under the ceiling
    // with eight ordinary recipients. That margin is all a message frame's other fields may grow by.
    for (const ch of ['x', '中', '"', '\u0001', '\ud800']) expect(frame(message(ch.repeat(16_000)))).toBeLessThanOrEqual(SHARED_TAB_FRAME_MAX)
    expect(SHARED_TAB_FRAME_MAX - frame(message('\u0001'.repeat(16_000)))).toBeGreaterThan(1_000)
  })

  it('says how many bytes a frame takes on the relay once sealed, without a key: exact but for the counter\'s digits', () => {
    const { mine } = pair()
    for (const frame of [{}, { kind: 'roster', signed: { body: 'x'.repeat(1_000), signature: 's' } }, { a: '\ud800'.repeat(500) },
      { b: '中"\u0001'.repeat(3_001) }, { c: 'y'.repeat(2) }, { d: 'y'.repeat(3) }]) {
      const real = Buffer.byteLength(JSON.stringify({ type: 'amsg_frame', to: 'm'.repeat(128), payload: mine.seal(frame) }))
      // The real frame's counter is a single digit; the estimate takes the highest a sender reaches.
      expect(sealedFrameBytes(frame) - real).toBe(String(Number.MAX_SAFE_INTEGER).length - 1)
    }
  })
})
