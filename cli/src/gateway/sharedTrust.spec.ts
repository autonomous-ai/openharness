import { describe, expect, it, vi } from 'vitest'
import { applySharedTrust, isSharedKey, sharedPeers, SHARED_TRUST_MAX, type SharedTrustDeps } from './sharedTrust.js'
import type { PairedClient } from '../lib/e2ee/store.js'
import type { LinkedPeer } from '../lib/e2ee/manager.js'

const key = (n: number) => Buffer.alloc(32, n).toString('base64')
const id = (c: string) => c.repeat(32)
type Pin = { machineId: string; pub: string; label: string; linkedAt: number; shared?: true }

function stores(pins: Pin[] = [], paired: PairedClient[] = []) {
  const held = new Map(pins.map((p) => [p.machineId, p]))
  const trusted = new Map(paired.map((p) => [p.identityPub, p]))
  const deps: SharedTrustDeps = {
    peers: {
      get: (machineId) => held.get(machineId) ?? null,
      pin: vi.fn((machineId: string, pub: string, label: string, at = 0, shared = false) => {
        held.set(machineId, { machineId, pub, label, linkedAt: at, ...(shared ? { shared: true as const } : {}) })
      }),
      unlink: vi.fn((machineId: string) => held.delete(machineId)),
      list: () => [...held.values()].map((p) => ({ ...p, fingerprint: 'fp' })),
    },
    paired: () => [...trusted.values()],
    trust: vi.fn((peer: LinkedPeer) => {
      trusted.set(peer.pub, { identityPub: peer.pub, label: peer.label, pairedAt: 1, role: 'web', machineId: peer.machineId, kind: peer.kind,
        ...(peer.shared ? { shared: true as const } : {}), ...(peer.sharedWith ? { sharedWith: peer.sharedWith } : {}) })
    }),
    untrust: vi.fn((pub: string) => { trusted.delete(pub) }),
    dropSessions: vi.fn(),
    selfPub: () => key(99),
  }
  return { deps, held, trusted }
}

describe('sharedPeers', () => {
  it('keeps valid peers once each, trims labels, and caps the list', () => {
    const good = { machineId: id('a'), pub: key(1), label: 'x'.repeat(200) }
    expect(sharedPeers([good, { ...good }, { ...good, machineId: id('b') }, { machineId: '../m', pub: key(2) }, { machineId: id('c'), pub: 'short' },
      null, 'text', { machineId: id('d'), pub: key(4) }])).toEqual([{ ...good, label: 'x'.repeat(120) }, { machineId: id('d'), pub: key(4), label: '' }])
    expect(sharedPeers('nope')).toEqual([])
    const many = Array.from({ length: SHARED_TRUST_MAX + 5 }, (_, i) => ({ machineId: `m${i}`, pub: Buffer.alloc(32, i % 250).toString('base64').slice(0, 40) + `${String(i).padStart(3, '0')}=`, label: '' }))
    expect(sharedPeers(many).length).toBeLessThanOrEqual(SHARED_TRUST_MAX)
  })
})

describe('whom a shared key is shared with', () => {
  // Its sessions are that account's guest (docs/plans/2026-10-19-guest-machine-sharing-plan.md).
  it('keeps a valid address, lowercased, and drops one that is not', () => {
    const peer = { machineId: id('a'), pub: key(1), label: 'Mac' }
    expect(sharedPeers([{ ...peer, email: ' Kim@Acme.io ' }])).toEqual([{ ...peer, email: 'kim@acme.io' }])
    expect(sharedPeers([{ ...peer, email: 'not an address' }])).toEqual([peer])
    expect(sharedPeers([{ ...peer, email: 42 }])).toEqual([peer])
  })

  it('trusts each key with its account, and a key with none as a guest of no one', () => {
    const { deps, trusted } = stores()
    applySharedTrust(deps, { keys: [{ machineId: id('k'), pub: key(1), label: 'Mac · kim', email: 'kim@acme.io' }, { machineId: id('n'), pub: key(2), label: 'Mac' }] })
    expect(trusted.get(key(1))).toMatchObject({ shared: true, sharedWith: 'kim@acme.io' })
    expect(trusted.get(key(2))).toMatchObject({ shared: true })
    expect(trusted.get(key(2))?.sharedWith).toBeUndefined()
  })
})

describe('applySharedTrust', () => {
  it('pins the machines shared with this account, marked shared, and takes back only its own', () => {
    const { deps, held } = stores([
      { machineId: id('o'), pub: key(10), label: 'own', linkedAt: 1 },                  // the account's own machine
      { machineId: id('g'), pub: key(11), label: 'gone', linkedAt: 1, shared: true },     // no longer shared
      { machineId: id('k'), pub: key(12), label: 'kept', linkedAt: 1, shared: true },     // still shared, same key
      { machineId: id('r'), pub: key(13), label: 'rekeyed', linkedAt: 1, shared: true },  // still shared, new key
    ])
    const result = applySharedTrust(deps, { pins: [
      { machineId: id('k'), pub: key(12), label: 'kept' },
      { machineId: id('r'), pub: key(14), label: 'rekeyed' },
      { machineId: id('n'), pub: key(15), label: 'new' },
      { machineId: id('o'), pub: key(16), label: 'not over the account’s own' },
      { machineId: id('s'), pub: key(99), label: 'this machine itself' },
    ] })
    expect(result).toEqual({ pins: 3, keys: 0 })
    expect(held.get(id('o'))).toMatchObject({ pub: key(10) })
    expect(held.has(id('g'))).toBe(false)
    expect(held.get(id('r'))).toMatchObject({ pub: key(14), shared: true })
    expect(held.get(id('n'))).toMatchObject({ pub: key(15), shared: true })
    expect(held.has(id('s'))).toBe(false)
    expect(deps.dropSessions).toHaveBeenCalledWith(id('g'))
    expect(deps.dropSessions).toHaveBeenCalledWith(id('r'))
    expect(deps.dropSessions).not.toHaveBeenCalledWith(id('k'))
    expect(deps.peers.pin).not.toHaveBeenCalledWith(id('k'), expect.anything(), expect.anything(), expect.anything(), expect.anything())
  })

  it('trusts the machines of accounts this one is shared with, never over the account’s own trust, and untrusts the rest it gave', () => {
    const { deps, trusted } = stores([], [
      { identityPub: key(20), label: 'own phone', pairedAt: 1, role: 'web' },
      { identityPub: key(21), label: 'old colleague', pairedAt: 1, role: 'web', kind: 'machine', machineId: id('x'), shared: true },
    ])
    const result = applySharedTrust(deps, { keys: [
      { machineId: id('k'), pub: key(22), label: 'Kim’s Mac' },
      { machineId: id('o'), pub: key(20), label: 'already ours' },
      { machineId: id('s'), pub: key(99), label: 'this machine' },
    ] })
    expect(result).toEqual({ pins: 0, keys: 1 })
    expect(deps.untrust).toHaveBeenCalledWith(key(21))
    expect(deps.untrust).not.toHaveBeenCalledWith(key(20))
    expect(trusted.get(key(22))).toMatchObject({ shared: true, kind: 'machine', machineId: id('k'), role: 'web' })
    expect(trusted.get(key(20))?.shared).toBeUndefined()
    expect(trusted.has(key(99))).toBe(false)
  })

  it('leaves a part it was not sent as it is, and says how many sharing holds', () => {
    const { deps } = stores([{ machineId: id('k'), pub: key(12), label: 'kept', linkedAt: 1, shared: true }],
      [{ identityPub: key(21), label: 'colleague', pairedAt: 1, role: 'web', shared: true }])
    expect(applySharedTrust(deps, {})).toEqual({ pins: 1, keys: 1 })
    expect(deps.peers.unlink).not.toHaveBeenCalled()
    expect(deps.untrust).not.toHaveBeenCalled()
  })

  it('knows a key trusted only through sharing', () => {
    const paired: PairedClient[] = [{ identityPub: key(1), label: '', pairedAt: 1, role: 'web', shared: true }, { identityPub: key(2), label: '', pairedAt: 1, role: 'web' }]
    expect(isSharedKey(paired, key(1))).toBe(true)
    expect(isSharedKey(paired, key(2))).toBe(false)
    expect(isSharedKey(paired, key(3))).toBe(false)
  })
})
