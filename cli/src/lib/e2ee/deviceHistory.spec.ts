import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { ed25519 } from '@noble/curves/ed25519'
import { emptyDevLogState, nextDevLogEntry, signDevLogEntry, applyDevLogEntries, type DevLogEntry, type DevLogState } from './deviceLog.js'
import { devLogHistory } from './deviceHistory.js'
import { devLogDivergence } from './deviceLogSyncer.js'
import vectors from './deviceHistory.vectors.json' with { type: 'json' }

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64')
const key = (n: number) => { const priv = new Uint8Array(32).fill(n); return { priv, pub: b64(ed25519.getPublicKey(priv)) } }
const a = key(1), b = key(2), c = key(3)

function build() {
  let state: DevLogState = emptyDevLogState('acct')
  const entries: DevLogEntry[] = []
  const push = (op: 'add' | 'remove', k: { pub: string }, signer: { pub: string; priv: Uint8Array }, label: string, at: number, kind: 'machine' | 'viewer' = 'viewer') => {
    const e = signDevLogEntry(nextDevLogEntry(state, { op, pub: k.pub, kind, machineId: kind === 'machine' ? 'a'.repeat(32) : '', label, signer: signer.pub }, at), signer.priv)
    state = applyDevLogEntries(state, [e]).state
    entries.push(e)
  }
  push('add', a, a, 'mac', 10, 'machine')
  push('add', b, b, 'phone', 20)
  push('add', b, b, 'pixel', 30)
  push('add', c, c, 'ipad', 40)
  push('remove', c, a, 'ipad', 50)
  push('remove', b, b, 'pixel', 60)
  return { state, entries }
}

describe('devLogHistory', () => {
  const { state, entries } = build()
  const rows = devLogHistory(entries, { selfPub: a.pub, joinedSeq: 1, pending: [b.pub], active: state.active })

  it('is newest first and tells each operation apart', () => {
    expect(rows.map((r) => [r.seq, r.op])).toEqual([[6, 'signedOut'], [5, 'removed'], [4, 'added'], [3, 'renamed'], [2, 'added'], [1, 'added']])
  })
  it('names who removed a key that is gone, and the old label of a rename', () => {
    expect(rows[1]).toMatchObject({ label: 'ipad', by: { pub: a.pub, label: 'mac' }, active: false })
    expect(rows[3]).toMatchObject({ label: 'pixel', previousLabel: 'phone' })
  })
  it('flags this device, entries after joining, pending and active', () => {
    expect(rows[5]).toMatchObject({ thisDevice: true, afterJoin: false, active: true })
    expect(rows[4]).toMatchObject({ afterJoin: true, pending: true, active: false })
  })
  it('marks loose removals as applied while frozen, and does not duplicate', () => {
    const loose = entries[4]
    const out = devLogHistory(entries.slice(0, 4), { selfPub: a.pub, pending: [], active: state.active, loose: [loose, loose] })
    expect(out[0]).toMatchObject({ seq: 5, whileFrozen: true })
    expect(out).toHaveLength(5)
  })
  it('reads a partial tail: an add of an already-active key is a rename', () => {
    const out = devLogHistory(entries.slice(2, 3), { selfPub: a.pub, pending: [], active: { [b.pub]: { pub: b.pub, kind: 'viewer', machineId: '', label: 'pixel', addedAt: 20, seq: 2 } } })
    expect(out[0].op).toBe('renamed')
  })
})

// The same fixture the Dart ports are held to (desktop|mobile/test/viewer/device_history_test.dart).
describe('shared history and divergence vectors', () => {
  it('the Dart copies are byte-identical to this fixture', () => {
    const here = readFileSync(fileURLToPath(new URL('./deviceHistory.vectors.json', import.meta.url)))
    for (const app of ['desktop', 'mobile']) {
      const copy = readFileSync(fileURLToPath(new URL(`../../../../${app}/test/viewer/deviceHistory.vectors.json`, import.meta.url)))
      expect(copy.equals(here), `${app} copy differs: run scripts/gen-devhistory-vectors.ts and copy it`).toBe(true)
    }
  })
  const pubs = vectors.pubs as Record<string, string>
  const entries = vectors.entries as unknown as DevLogEntry[]
  const state = applyDevLogEntries(emptyDevLogState(vectors.acct), entries).state

  for (const c of vectors.history) {
    it(`history: ${c.name}`, () => {
      const pick = (seqs: number[]) => seqs.map((n) => entries[n - 1])
      const rows = devLogHistory(pick(c.seqs), {
        selfPub: pubs[c.self], ...('joinedSeq' in c ? { joinedSeq: c.joinedSeq as number } : {}),
        pending: c.pending.map((k) => pubs[k]), active: state.active, loose: pick(c.loose),
      })
      expect(rows.map((r) => ({
        seq: r.seq, op: r.op, label: r.label, kind: r.kind, ...(r.previousLabel !== undefined ? { previousLabel: r.previousLabel } : {}),
        ...(r.by ? { by: r.by.label } : {}), thisDevice: r.thisDevice, afterJoin: r.afterJoin, pending: r.pending, active: r.active, whileFrozen: r.whileFrozen,
      }))).toEqual(c.rows)
    })
  }

  for (const c of vectors.divergence) {
    it(`divergence: ${c.name}`, () => {
      const other = applyDevLogEntries(emptyDevLogState(vectors.acct), (c.log === 'fork' ? vectors.fork : vectors.entries) as unknown as DevLogEntry[]).state
      const hashes: Array<{ seq: number; hash: string }> = []
      for (let seq = c.from; seq <= c.to; seq++) hashes.push({ seq, hash: other.hashes[seq - 1] })
      let theirs: unknown = { head: { seq: c.to, hash: other.hashes[c.to - 1] }, hashes }
      if (c.tamper === 'gap') theirs = { head: (theirs as { head: unknown }).head, hashes: hashes.filter((h) => h.seq !== 2) }
      if (c.tamper === 'head') theirs = { head: { seq: c.to, hash: 'nope' }, hashes }
      if (c.tamper === 'junk') theirs = { head: (theirs as { head: unknown }).head, hashes: 'junk' }
      expect(devLogDivergence(state, theirs)).toBe(c.expect)
    })
  }
})
