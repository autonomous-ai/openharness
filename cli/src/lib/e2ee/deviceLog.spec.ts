import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519'
import vectors from './deviceLog.vectors.json' with { type: 'json' }
import {
  applyDevLogEntries, compareDevLogHead, DevLogError, devLogHash, devLogHashAt, emptyDevLogState,
  nextDevLogEntry, signDevLogEntry, type DevLogState,
} from './deviceLog.js'

const b64d = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'))

describe('device key log vectors', () => {
  it('derives the fixture keys from their seeds', () => {
    for (const [name, seed] of Object.entries(vectors.seeds)) {
      expect(Buffer.from(ed25519.getPublicKey(b64d(seed))).toString('base64')).toBe((vectors.pubs as Record<string, string>)[name])
    }
  })

  it('applies every valid entry to the fixture hashes, head and active set', () => {
    const { state } = applyDevLogEntries(emptyDevLogState(vectors.acct), vectors.valid.entries)
    expect(state.hashes).toEqual(vectors.valid.hashes)
    expect(state.head).toEqual(vectors.valid.head)
    expect(Object.keys(state.active).sort()).toEqual(vectors.valid.active)
    expect(state.removed).toEqual(vectors.valid.removed)
    vectors.valid.entries.forEach((e, i) => expect(devLogHash(e as never)).toBe(vectors.valid.hashes[i]))
  })

  it('re-signs every valid entry to the same signature (Ed25519 is deterministic)', () => {
    const seeds = vectors.seeds as Record<string, string>
    const byPub = new Map(Object.entries(vectors.pubs).map(([name, pub]) => [pub, b64d(seeds[name])]))
    for (const e of vectors.valid.entries) {
      const { sig, ...unsigned } = e
      expect(signDevLogEntry(unsigned as never, byPub.get(e.signer)!).sig).toBe(sig)
    }
  })

  for (const c of vectors.invalid) {
    it(`refuses: ${c.name} (${c.code})`, () => {
      const base = applyDevLogEntries(emptyDevLogState(vectors.acct), vectors.valid.entries.slice(0, c.after)).state
      let code: string | null = null
      try { applyDevLogEntries(base, [c.entry]) } catch (err) { code = err instanceof DevLogError ? err.code : String(err) }
      expect(code).toBe(c.code)
    })
  }
})

describe('applyDevLogEntries', () => {
  const full = (): DevLogState => applyDevLogEntries(emptyDevLogState(vectors.acct), vectors.valid.entries).state

  it('is all or nothing: a bad entry after good ones leaves the state untouched', () => {
    const start = emptyDevLogState(vectors.acct)
    const bad = { ...vectors.valid.entries[1], label: 'tampered' }
    expect(() => applyDevLogEntries(start, [vectors.valid.entries[0], bad])).toThrow(DevLogError)
    expect(start.head.seq).toBe(0)
    expect(start.hashes).toEqual([])
  })

  it('applies incrementally to the same result as all at once', () => {
    let s = emptyDevLogState(vectors.acct)
    for (const e of vectors.valid.entries) s = applyDevLogEntries(s, [e]).state
    expect(s).toEqual(full())
  })

  it('reports what each step added, removed and relabeled', () => {
    const e = vectors.valid.entries
    const upTo3 = applyDevLogEntries(emptyDevLogState(vectors.acct), e.slice(0, 3))
    expect(upTo3.added.map(m => m.label)).toEqual(['box1', 'box2', e[2].label])
    const step = applyDevLogEntries(upTo3.state, e.slice(3, 5))
    expect(step.added).toEqual([])
    expect(step.relabeled.map(m => m.label)).toEqual(['box1 (renamed)'])
    expect(step.removed.map(m => m.pub)).toEqual([vectors.pubs.box2])
  })

  it('lets a device leave on its own signature', () => {
    const s = full()
    const seed = b64d(vectors.seeds.browser)
    const m = s.active[vectors.pubs.browser]
    const leave = signDevLogEntry(nextDevLogEntry(s, { op: 'remove', pub: m.pub, kind: m.kind, machineId: m.machineId, label: m.label, signer: m.pub }, 10_000), seed)
    const after = applyDevLogEntries(s, [leave]).state
    expect(after.active[vectors.pubs.browser]).toBeUndefined()
    expect(after.removed).toContain(vectors.pubs.browser)
  })
})

describe('compareDevLogHead', () => {
  const s = applyDevLogEntries(emptyDevLogState(vectors.acct), vectors.valid.entries.slice(0, 4)).state

  it('tells same, ahead, behind and fork apart', () => {
    expect(compareDevLogHead(s, s.head)).toBe('same')
    expect(compareDevLogHead(s, { seq: 2, hash: devLogHashAt(s, 2)! })).toBe('ahead')
    expect(compareDevLogHead(s, { seq: 0, hash: devLogHashAt(s, 0)! })).toBe('ahead')
    expect(compareDevLogHead(s, { seq: 6, hash: vectors.valid.hashes[5] })).toBe('behind')
    expect(compareDevLogHead(s, { seq: 3, hash: vectors.valid.hashes[1] })).toBe('fork')
  })
})
