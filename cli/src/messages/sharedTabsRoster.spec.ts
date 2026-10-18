import { describe, expect, it } from 'vitest'
import { b64e, newIdentity, sign } from '../lib/e2ee/core.js'
import { acceptTabSession, SHARED_TAB_FRAME_MAX, startTabSession } from '../lib/e2ee/tabSession.js'
import { encodeRoster, fitsRoster, rosterBytes, ROSTER_LIMITS, type Roster } from './roster.js'
import { compose, composeCut, harnessRef, judge, peerKey, sameRoster, shareOf, signedOf, wireHarness } from './sharedTabsRoster.js'

const TAB = 'a1b2c3d4e5f6a1b2c3d4e5f6'
const alice = b64e(newIdentity().pub), bob = b64e(newIdentity().pub), carol = b64e(newIdentity().pub)
const h = (accountId: string, machineId: string, agentId: string, pub: string) => ({ accountId, machineId, machinePublicKey: pub, agentId, name: agentId, engine: 'claude' })
const base: Roster = {
  sharedTabId: TAB, version: 3, name: 'app', leader: null, invites: [],
  owner: { accountId: 'u-alice', email: 'a@x.io', machineId: 'm-alice', machinePublicKey: alice },
  members: [{ accountId: 'u-bob', email: 'b@y.io', name: 'b', acceptedAt: '2026-10-15T00:00:00.000Z' }],
  harnesses: [h('u-alice', 'm-alice', 'lead', alice), h('u-bob', 'm-bob', 'api', bob)],
}

describe('shared tabs\' pure helpers', () => {
  it('reads a harness off the wire only when every field is what the roster takes', () => {
    expect(wireHarness(h('u-bob', 'm-bob', 'api', bob))).toEqual(h('u-bob', 'm-bob', 'api', bob))
    for (const bad of [null, [], 'x', { ...h('u-bob', 'm-bob', 'api', bob), machinePublicKey: 'short' }, { ...h('u-bob', 'm-bob', 'api', bob), engine: 'e'.repeat(65) },
      { ...h('u-bob', 'm-bob', 'api', bob), agentId: '' }, { ...h('u-bob', 'm-bob', 'api', bob), name: 7 }]) expect(wireHarness(bad)).toBeNull()
    // A name is shown to people and to agents: control and format characters (an escape, a bidi override, a zero-width
    // space) are taken out where the roster is built.
    expect(wireHarness({ ...h('u-bob', 'm-bob', 'api', bob), name: '\u001b[2Ja\u202ep\u200bi\u0000' })?.name).toBe('[2Japi')
    expect(harnessRef({ machineId: 'm', agentId: 'a', extra: 1 })).toEqual({ machineId: 'm', agentId: 'a' })
    expect(harnessRef(null)).toBeNull()
  })

  it('reads a signed roster, with its key change only when whole', () => {
    expect(signedOf({ body: 'b', signature: 's', keyChange: { previousPub: 'p', signature: 'k' } })).toEqual({ body: 'b', signature: 's', keyChange: { previousPub: 'p', signature: 'k' } })
    expect(signedOf({ body: 'b', signature: 's', keyChange: { previousPub: 'p' } })).toEqual({ body: 'b', signature: 's' })
    expect(signedOf({ body: 1, signature: 's' })).toBeNull()
    expect(signedOf('x')).toBeNull()
  })

  it('reads a share as the backend lists it, keeping only members and invitations the roster can hold', () => {
    expect(shareOf({ sharedTabId: TAB, owner: true, ownerEmail: 'a@x.io', ownerMachineId: 'm-alice', version: 4, roster: { r: 1 }, tabId: 'tab-1',
      members: [{ userId: 'u-bob', email: 'b@y.io', acceptedAt: '2026-10-15T01:02:03Z' }, { userId: 'u-x', email: 'x@y.io', acceptedAt: 'never' },
        { userId: 'u-y', email: 'y@y.io', acceptedAt: 7 }, null],
      invites: [{ id: 'i1', email: 'c@z.io', expiresAt: '2026-11-01T00:00:00.000Z' }, { id: 'i2', email: 'd@z.io' }, 'x'] })).toEqual({
      sharedTabId: TAB, owner: true, ownerEmail: 'a@x.io', ownerMachineId: 'm-alice', version: 4, roster: { r: 1 }, tabId: 'tab-1',
      members: [{ accountId: 'u-bob', email: 'b@y.io', name: 'b', acceptedAt: '2026-10-15T01:02:03.000Z' }],
      invites: [{ email: 'c@z.io', expiresAt: '2026-11-01T00:00:00.000Z' }],
      pending: [{ id: 'i1', email: 'c@z.io', expiresAt: '2026-11-01T00:00:00.000Z' }],
    })
    // A member's view: no desk tab, no members, no invitations; a version that is not a number reads as none, and an
    // owner's address that is not one as none.
    expect(shareOf({ sharedTabId: TAB, owner: false, ownerEmail: 7, ownerMachineId: 'm-alice', version: '4', roster: null })).toEqual({
      sharedTabId: TAB, owner: false, ownerEmail: '', ownerMachineId: 'm-alice', version: 0, roster: null, tabId: '', members: [], invites: [], pending: [] })
    expect(shareOf({ sharedTabId: TAB, owner: false, ownerEmail: 'x'.repeat(255), ownerMachineId: 'm-alice' })?.ownerEmail).toBe('')
    for (const bad of [null, { sharedTabId: 'tab-1', ownerMachineId: 'm' }, { sharedTabId: TAB }]) expect(shareOf(bad)).toBeNull()
  })

  it('composes the next roster: one entry each, members\' harnesses only while members, a leader only while listed', () => {
    const next = compose(base, { members: [...base.members, base.members[0]], invites: [{ email: 'C@z.io', expiresAt: 'x' }, { email: 'c@z.io', expiresAt: 'y' }],
      others: [h('u-bob', 'm-bob', 'api', bob), h('u-bob', 'm-bob', 'api', bob), h('u-carol', 'm-carol', 'web', carol), h('u-alice', 'm-alice', 'sneak', alice)],
      leader: { machineId: 'm-bob', agentId: 'api' } })
    expect(next.members).toHaveLength(1)
    expect(next.invites).toEqual([{ email: 'C@z.io', expiresAt: 'x' }])
    expect(next.harnesses.map((x) => x.agentId)).toEqual(['lead', 'api'])
    expect(next.leader).toEqual({ machineId: 'm-bob', agentId: 'api' })
    expect(compose(next, { members: [] })).toMatchObject({ leader: null, members: [] })
    expect(compose(base, { own: Array.from({ length: 40 }, (_, i) => h('u-alice', 'm-alice', `a${i}`, alice)) }).harnesses).toHaveLength(ROSTER_LIMITS.harnesses)
    // How many it cut, for the owner to be told (sharedTabs.ts `change`).
    expect(composeCut(base, { own: Array.from({ length: 40 }, (_, i) => h('u-alice', 'm-alice', `a${i}`, alice)) }).cut).toBe(40 + 1 - ROSTER_LIMITS.harnesses)
    expect(composeCut(base, {})).toEqual({ roster: compose(base, {}), cut: 0 })
    expect(sameRoster(base, { ...base, version: 9 })).toBe(true)
    expect(sameRoster(base, { ...base, name: 'other' })).toBe(false)
  })

  it('keeps members by account and invitations by address, whatever order the backend lists them in', () => {
    const m = (accountId: string) => ({ accountId, email: `${accountId}@y.io`, name: accountId, acceptedAt: '2026-10-15T00:00:00.000Z' })
    const i = (email: string) => ({ email, expiresAt: '2026-11-01T00:00:00.000Z' })
    const one = compose(base, { members: [m('u-carol'), m('u-bob'), m('u-dan')], invites: [i('z@z.io'), i('a@z.io'), i('m@z.io')] })
    const other = compose(base, { members: [m('u-dan'), m('u-carol'), m('u-bob')], invites: [i('m@z.io'), i('z@z.io'), i('a@z.io')] })
    expect(one.members.map((x) => x.accountId)).toEqual(['u-bob', 'u-carol', 'u-dan'])
    expect(one.invites.map((x) => x.email)).toEqual(['a@z.io', 'm@z.io', 'z@z.io'])
    // The same people in another order: the same roster, so nothing is signed again.
    expect(sameRoster(one, other)).toBe(true)
  })

  it('gives the key a machine must prove: the one listed under the account the relay stamped, or, to the owner alone, a member\'s claim', () => {
    expect(peerKey(base, 'm-alice', 'u-alice', undefined, false)).toBe(alice)
    expect(peerKey(base, 'm-alice', 'u-bob', alice, false)).toBeNull()
    expect(peerKey(base, 'm-bob', 'u-bob', carol, false)).toBe(bob)
    expect(peerKey(base, 'm-bob', 'u-carol', carol, true)).toBeNull()
    expect(peerKey(base, 'm-bob2', 'u-bob', carol, true)).toBe(carol)
    expect(peerKey(base, 'm-bob2', 'u-bob', carol, false)).toBeNull()
    expect(peerKey(base, 'm-bob2', 'u-bob', 'short', true)).toBeNull()
    expect(peerKey(base, 'm-carol', 'u-carol', carol, true)).toBeNull()
  })
  describe('judging a member\'s request', () => {
    const carolMember = { accountId: 'u-carol', email: 'c@z.io', name: 'c', acceptedAt: '2026-10-15T00:00:00.000Z' }
    const two: Roster = { ...base, members: [...base.members, carolMember] }
    const fromBob = { machineId: 'm-bob', userId: 'u-bob' }

    it('adds a harness only from its own machine, under the key its session proved', () => {
      expect(judge(two, fromBob, bob, 'add', h('u-bob', 'm-bob', 'web', bob))).toEqual({ others: [h('u-bob', 'm-bob', 'api', bob), h('u-bob', 'm-bob', 'web', bob)] })
      // Already listed: nothing to change.
      expect(judge(two, fromBob, bob, 'add', h('u-bob', 'm-bob', 'api', bob))).toBeNull()
    })

    it('refuses an add for another machine than the one asking, even one of the same account', () => {
      expect(judge(two, fromBob, bob, 'add', h('u-bob', 'm-bob2', 'web', carol))).toBe('FORBIDDEN')
      expect(judge(two, fromBob, bob, 'add', h('u-bob', 'm-bob2', 'web', bob))).toBe('FORBIDDEN')
    })

    it('refuses an add on another member\'s machine id the roster does not list yet', () => {
      expect(judge(two, fromBob, bob, 'add', h('u-bob', 'm-carol', 'web', carol))).toBe('FORBIDDEN')
    })

    it('refuses a harness in another account\'s name, on the owner\'s machine, or on a machine listed under another account', () => {
      expect(judge(two, fromBob, bob, 'add', h('u-carol', 'm-bob', 'web', bob))).toBe('FORBIDDEN')
      expect(judge(two, { machineId: 'm-alice', userId: 'u-bob' }, alice, 'add', h('u-bob', 'm-alice', 'web', alice))).toBe('FORBIDDEN')
      expect(judge(two, { machineId: 'm-bob', userId: 'u-carol' }, bob, 'add', h('u-carol', 'm-bob', 'web', bob))).toBe('FORBIDDEN')
      expect(judge(two, { machineId: 'm-dan', userId: 'u-dan' }, carol, 'add', h('u-dan', 'm-dan', 'web', carol))).toBe('FORBIDDEN')
    })

    it('refuses a key that differs from the one the session proved', () => {
      expect(judge(two, fromBob, bob, 'add', h('u-bob', 'm-bob', 'web', carol))).toBe('KEY_MISMATCH')
    })

    it('refuses an add past the harness limit, and a harness that is not one', () => {
      const full: Roster = { ...two, harnesses: Array.from({ length: ROSTER_LIMITS.harnesses }, (_, i) => h('u-alice', 'm-alice', `a${i}`, alice)) }
      expect(judge(full, fromBob, bob, 'add', h('u-bob', 'm-bob', 'web', bob))).toBe('TAB_FULL')
      expect(judge(two, fromBob, bob, 'add', { machineId: 7 })).toBe('INVALID_HARNESS')
    })

    it('refuses an add that would take the roster past what its owner may sign (fitsRoster): TAB_FULL', () => {
      // The tab's name pads the roster to a given room below the most the owner may sign; one more harness here takes
      // about 160 bytes sealed.
      const named = (n: number): Roster => ({ ...two, name: 'x'.repeat(n) })
      let most = 0
      while (fitsRoster(named(most + 1_000))) most += 1_000
      while (fitsRoster(named(most + 1))) most++
      expect(judge(named(most - 60), fromBob, bob, 'add', h('u-bob', 'm-bob', 'web', bob))).toBe('TAB_FULL')
      expect(judge(named(most - 300), fromBob, bob, 'add', h('u-bob', 'm-bob', 'web', bob))).toMatchObject({ others: [h('u-bob', 'm-bob', 'api', bob), h('u-bob', 'm-bob', 'web', bob)] })
    })

    it('lets no roster through that its owner could not send sealed: the worst one the field limits allow fits, or is TAB_FULL', () => {
      // Every field at its limit in the characters JSON writes longest (a lone surrogate: six bytes), the owner and its
      // eight members too; then the member adds the same until it is refused. Each roster it takes is signed and sealed
      // for real, with its key change, and sent as the gateway sends it, to a machine id at the relay's 128 characters.
      const w = (n: number) => '\ud800'.repeat(n)
      const ownerKey = newIdentity(), a = newIdentity(), b = newIdentity(), TAB2 = 'a1b2c3d4e5f6a1b2c3d4e5f6'
      const start = startTabSession(a, TAB2, 'x', 'y')
      const cipher = start.finish(acceptTabSession(b, TAB2, 'x', 'y', start.hello, b64e(a.pub))!.welcome, b64e(b.pub))!
      const frameOf = (r: Roster) => {
        const body = encodeRoster(r), signature = b64e(sign(ownerKey.priv, rosterBytes(r.sharedTabId, r.version, body)))
        const signed = { body, signature, keyChange: { previousPub: alice, signature } }
        return Buffer.byteLength(JSON.stringify({ type: 'amsg_frame', to: 'm'.repeat(128), payload: cipher.seal({ kind: 'roster', signed }) }))
      }
      const bobMachine = `b${w(159)}`, bobs = { machineId: bobMachine, userId: 'u-bob' }
      let roster: Roster = { sharedTabId: TAB2, version: Number.MAX_SAFE_INTEGER, name: w(200), leader: { machineId: w(160), agentId: w(160) },
        owner: { accountId: w(160), email: w(254), machineId: w(160), machinePublicKey: alice },
        members: [{ accountId: 'u-bob', email: w(254), name: w(200), acceptedAt: '2026-10-15T00:00:00.000Z' },
          ...Array.from({ length: ROSTER_LIMITS.members - 1 }, (_, i) => ({ accountId: `${i}${w(159)}`, email: w(254), name: w(200), acceptedAt: '2026-10-15T00:00:00.000Z' }))],
        invites: Array.from({ length: 8 }, (_, i) => ({ email: `${i}${w(253)}`, expiresAt: '2026-11-01T00:00:00.000Z' })),
        harnesses: [{ accountId: w(160), machineId: w(160), machinePublicKey: alice, agentId: w(160), name: w(200), engine: w(64) }] }
      roster.owner.accountId = roster.harnesses[0].accountId
      let verdict: ReturnType<typeof judge> = null
      for (let i = 0; i < ROSTER_LIMITS.harnesses; i++) {
        verdict = judge(roster, bobs, bob, 'add', { accountId: 'u-bob', machineId: bobMachine, machinePublicKey: bob, agentId: `${i}${w(150)}`, name: w(200), engine: w(64) })
        if (typeof verdict === 'string' || !verdict) break
        roster = compose(roster, verdict)
        expect(frameOf(roster)).toBeLessThanOrEqual(SHARED_TAB_FRAME_MAX)
      }
      expect(verdict).toBe('TAB_FULL')
      expect(roster.harnesses.length).toBeLessThan(ROSTER_LIMITS.harnesses)
    })

    it('removes the sender account\'s harness from any machine of that account, and nothing of another\'s', () => {
      expect(judge(two, { machineId: 'm-bob2', userId: 'u-bob' }, carol, 'remove', { machineId: 'm-bob', agentId: 'api' })).toEqual({ others: [] })
      expect(judge(two, fromBob, bob, 'remove', { machineId: 'm-alice', agentId: 'lead' })).toBe('FORBIDDEN')
      expect(judge(two, fromBob, bob, 'remove', { machineId: 'm-bob', agentId: 'ghost' })).toBeNull()
      expect(judge(two, fromBob, bob, 'remove', null)).toBe('INVALID_HARNESS')
    })
  })
})
