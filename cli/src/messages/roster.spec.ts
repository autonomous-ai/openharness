import { describe, expect, it } from 'vitest'
import { b64e, newIdentity, sign } from '../lib/e2ee/core.js'
import { ROSTER_BODY_MAX, SHARED_TAB_FRAME_MAX, sealedFrameBytes } from '../lib/e2ee/tabSession.js'
import { encodeRoster, fitsRoster, keyChangeBytes, parseRoster, ROSTER_LIMITS, rosterBytes, verifyRoster, type Roster } from './roster.js'

const owner = newIdentity(), next = newIdentity(), stranger = newIdentity()
const TAB = 'a1b2c3d4e5f6a1b2c3d4e5f6'
const base = (pub = owner.pub): Roster => ({
  sharedTabId: TAB, version: 3, name: 'app',
  owner: { accountId: 'u-alice', email: 'alice@example.com', machineId: 'alice-mac', machinePublicKey: b64e(pub) },
  leader: { machineId: 'alice-mac', agentId: 'lead' },
  members: [{ accountId: 'u-bob', email: 'bob@example.com', name: 'Bob', acceptedAt: '2026-10-15T00:00:00.000Z' }],
  harnesses: [
    { accountId: 'u-alice', machineId: 'alice-mac', machinePublicKey: b64e(pub), agentId: 'lead', name: 'lead', engine: 'codex' },
    { accountId: 'u-bob', machineId: 'bob-mini', machinePublicKey: b64e(stranger.pub), agentId: 'api', name: 'api', engine: 'claude' },
  ],
  invites: [{ email: 'carol@example.com', expiresAt: '2026-11-14T00:00:00.000Z' }],
})
const signed = (r: Roster, by = owner) => {
  const body = encodeRoster(r)
  return { body, signature: b64e(sign(by.priv, rosterBytes(r.sharedTabId, r.version, body))) }
}

describe('the roster', () => {
  it('encodes the same roster to the same bytes whatever the key order', () => {
    const r = base()
    const shuffled = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(r).reverse())))
    expect(encodeRoster(shuffled)).toBe(encodeRoster(r))
    expect(parseRoster(encodeRoster(r))).toEqual(r)
  })

  it('verifies a roster signed by the pinned owner key', () => {
    const result = verifyRoster(signed(base()), b64e(owner.pub))
    expect(result).toEqual({ roster: base(), ownerPub: b64e(owner.pub) })
  })

  it('refuses a roster signed by another key, or altered after signing', () => {
    expect(verifyRoster(signed(base(), stranger), b64e(owner.pub))).toEqual({ error: 'bad_signature' })
    const s = signed(base())
    expect(verifyRoster({ ...s, body: s.body.replace('"app"', '"ppa"') }, b64e(owner.pub))).toEqual({ error: 'bad_signature' })
  })

  it('refuses a roster whose owner key is not the pinned one, unless the pinned key signed the change', () => {
    const r = base(next.pub)
    const s = signed(r, next)
    expect(verifyRoster(s, b64e(owner.pub))).toEqual({ error: 'unpinned_key' })
    const keyChange = { previousPub: b64e(owner.pub), signature: b64e(sign(owner.priv, keyChangeBytes(TAB, b64e(next.pub)))) }
    expect(verifyRoster({ ...s, keyChange }, b64e(owner.pub))).toEqual({ roster: r, ownerPub: b64e(next.pub) })
    const forged = { previousPub: b64e(owner.pub), signature: b64e(sign(stranger.priv, keyChangeBytes(TAB, b64e(next.pub)))) }
    expect(verifyRoster({ ...s, keyChange: forged }, b64e(owner.pub))).toEqual({ error: 'unpinned_key' })
    expect(verifyRoster({ ...s, keyChange: { ...keyChange, previousPub: b64e(stranger.pub) } }, b64e(owner.pub))).toEqual({ error: 'unpinned_key' })
  })

  it('refuses malformed and oversized rosters', () => {
    expect(verifyRoster({ body: '{', signature: 'AA' }, b64e(owner.pub))).toEqual({ error: 'malformed' })
    expect(verifyRoster({ body: encodeRoster(base()), signature: 'AA' }, b64e(owner.pub))).toEqual({ error: 'bad_signature' })
    expect(parseRoster(JSON.stringify({ ...base(), version: 0 }))).toBeNull()
    expect(parseRoster(JSON.stringify({ ...base(), sharedTabId: 'tab-1' }))).toBeNull()
    const many = { ...base(), harnesses: Array.from({ length: ROSTER_LIMITS.harnesses + 1 }, (_, i) => ({ ...base().harnesses[1], agentId: `a${i}` })) }
    expect(verifyRoster(signed(many), b64e(owner.pub))).toEqual({ error: 'too_large' })
    const crowd = { ...base(), members: Array.from({ length: ROSTER_LIMITS.members + 1 }, (_, i) => ({ ...base().members[0], accountId: `u${i}` })) }
    expect(verifyRoster(signed(crowd), b64e(owner.pub))).toEqual({ error: 'too_large' })
  })

  it('reads the roster strictly, as the zod schema did: an unknown key anywhere, a field out of its limits or pattern', () => {
    const body = (change: (r: Record<string, any>) => void) => { const r = JSON.parse(JSON.stringify(base())); change(r); return JSON.stringify(r) }
    expect(parseRoster(body(() => {}))).toEqual(base())
    const refused: Array<[string, (r: Record<string, any>) => void]> = [
      ['an unknown key', (r) => { r.extra = 1 }],
      ['an unknown owner key', (r) => { r.owner.extra = 1 }],
      ['an unknown leader key', (r) => { r.leader.extra = 1 }],
      ['an unknown member key', (r) => { r.members[0].extra = 1 }],
      ['an unknown harness key', (r) => { r.harnesses[0].extra = 1 }],
      ['an unknown invite key', (r) => { r.invites[0].extra = 1 }],
      ['a missing key', (r) => { delete r.invites }],
      ['a missing leader', (r) => { delete r.leader }],
      ['an upper-case tab id', (r) => { r.sharedTabId = TAB.toUpperCase() }],
      ['a version that is not an integer', (r) => { r.version = 1.5 }],
      ['a version as a string', (r) => { r.version = '3' }],
      ['a name over 200', (r) => { r.name = 'x'.repeat(201) }],
      ['an empty account id', (r) => { r.owner.accountId = '' }],
      ['an id over 160', (r) => { r.harnesses[0].agentId = 'x'.repeat(161) }],
      ['an owner key of the wrong shape', (r) => { r.owner.machinePublicKey = 'A'.repeat(44) }],
      ['a harness key of the wrong shape', (r) => { r.harnesses[1].machinePublicKey = 'A'.repeat(43) + '_' }],
      ['an email over 254', (r) => { r.owner.email = 'x'.repeat(255) }],
      ['a member name over 200', (r) => { r.members[0].name = 'x'.repeat(201) }],
      ['an acceptedAt with an offset', (r) => { r.members[0].acceptedAt = '2026-10-15T00:00:00+01:00' }],
      ['an expiresAt that is no date', (r) => { r.invites[0].expiresAt = 'soon' }],
      ['an engine over 64', (r) => { r.harnesses[0].engine = 'x'.repeat(65) }],
      ['a harness name over 200', (r) => { r.harnesses[0].name = 'x'.repeat(201) }],
      ['harnesses that are no list', (r) => { r.harnesses = {} }],
    ]
    for (const [what, change] of refused) expect(parseRoster(body(change)), what).toBeNull()
    expect(parseRoster('[]')).toBeNull()
    expect(parseRoster('null')).toBeNull()
    // At the limits, and with no leader: still a roster.
    const edge = body((r) => { r.leader = null; r.name = 'x'.repeat(200); r.owner.email = 'x'.repeat(254); r.harnesses[0].agentId = 'x'.repeat(160); r.harnesses[0].engine = 'x'.repeat(64) })
    expect(parseRoster(edge)).toMatchObject({ leader: null, name: 'x'.repeat(200) })
  })

  it('binds the signature to the tab and version', () => {
    const r = base(), body = encodeRoster(r)
    const wrongTab = { body, signature: b64e(sign(owner.priv, rosterBytes('f'.repeat(24), r.version, body))) }
    const wrongVersion = { body, signature: b64e(sign(owner.priv, rosterBytes(TAB, r.version + 1, body))) }
    expect(verifyRoster(wrongTab, b64e(owner.pub))).toEqual({ error: 'bad_signature' })
    expect(verifyRoster(wrongVersion, b64e(owner.pub))).toEqual({ error: 'bad_signature' })
  })

  it('treats a signature or key that is not a string as not verifying, never as a crash', () => {
    const s = signed(base())
    const wire = (value: unknown) => value as string
    expect(verifyRoster({ ...s, signature: wire(7) }, b64e(owner.pub))).toEqual({ error: 'bad_signature' })
    const r = base(next.pub), moved = signed(r, next)
    const keyChange = { previousPub: b64e(owner.pub), signature: wire(null) }
    expect(verifyRoster({ ...moved, keyChange }, b64e(owner.pub))).toEqual({ error: 'unpinned_key' })
  })

  it('refuses a body over ROSTER_BODY_MAX bytes as too_large, counting bytes rather than characters', () => {
    // Padded with whitespace JSON allows after the value, and signed: only the size can refuse it.
    const padded = (r: Roster, bytes: number) => {
      const body = encodeRoster(r), pad = ' '.repeat(bytes - Buffer.byteLength(body))
      return { body: body + pad, signature: b64e(sign(owner.priv, rosterBytes(r.sharedTabId, r.version, body + pad))) }
    }
    expect(verifyRoster(padded(base(), ROSTER_BODY_MAX), b64e(owner.pub))).toEqual({ roster: base(), ownerPub: b64e(owner.pub) })
    expect(verifyRoster(padded(base(), ROSTER_BODY_MAX + 1), b64e(owner.pub))).toEqual({ error: 'too_large' })
    // Three bytes a character: within the ceiling by its length, over it by its bytes.
    const wide = { ...base(), name: '€'.repeat(200) }, over = padded(wide, ROSTER_BODY_MAX + 1)
    expect(over.body.length).toBeLessThan(ROSTER_BODY_MAX)
    expect(verifyRoster(over, b64e(owner.pub))).toEqual({ error: 'too_large' })
    // The owner's side: never a body over the members' ceiling.
    expect(fitsRoster({ ...base(), name: 'x'.repeat(ROSTER_BODY_MAX) })).toBe(false)
  })

  it('fits only a roster whose sealed frame fits the relay: a body under the ceiling can still seal to more (review of A7)', () => {
    // A member's fields full of lone surrogates, six bytes each in JSON and every one within its limit.
    const heavy = (k: number): Roster => ({ ...base(), harnesses: Array.from({ length: ROSTER_LIMITS.harnesses }, (_, i) => ({ ...base().harnesses[1],
      agentId: `${i}${'\ud800'.repeat(k)}`, name: '\ud800'.repeat(200), engine: '\ud800'.repeat(64) })) })
    const sealed = (r: Roster) => {
      const body = encodeRoster(r)
      return sealedFrameBytes({ kind: 'roster', signed: { body, signature: 'A'.repeat(86) + '==', keyChange: { previousPub: 'A'.repeat(43) + '=', signature: 'A'.repeat(86) + '==' } } })
    }
    const over = heavy(150)
    expect(Buffer.byteLength(encodeRoster(over))).toBeLessThan(ROSTER_BODY_MAX)
    expect(sealed(over)).toBeGreaterThan(SHARED_TAB_FRAME_MAX)
    expect(fitsRoster(over)).toBe(false)
    expect(sealed(heavy(50))).toBeLessThanOrEqual(SHARED_TAB_FRAME_MAX)
    expect(fitsRoster(heavy(50))).toBe(true)
    // At the edge, plain text: it fits up to the last byte the sealed frame allows, and not one base64 group more.
    const named = (n: number) => ({ ...base(), name: 'x'.repeat(n) })
    let n = 0
    while (fitsRoster(named(n + 1_000))) n += 1_000
    while (fitsRoster(named(n + 1))) n++
    expect(sealed(named(n))).toBeLessThanOrEqual(SHARED_TAB_FRAME_MAX)
    expect(sealed(named(n + 3))).toBeGreaterThan(SHARED_TAB_FRAME_MAX)
    // There the body is still under the members' ceiling: the frame is the tighter of the two.
    expect(Buffer.byteLength(encodeRoster(named(n)))).toBeLessThan(ROSTER_BODY_MAX)
  })

  it('strips control and format characters from harness names as it reads them, and the signature still holds', () => {
    const r = base()
    r.harnesses[1] = { ...r.harnesses[1], name: 'a\u0007p‮i​\u001b[2J' }
    const result = verifyRoster(signed(r), b64e(owner.pub))
    expect('roster' in result && result.roster.harnesses[1].name).toBe('api[2J')
    expect(parseRoster(encodeRoster(r))?.harnesses[1].name).toBe('api[2J')
  })
})
