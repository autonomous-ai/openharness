/**
 * Regenerates src/lib/e2ee/deviceHistory.vectors.json — the fixture the device history (`devLogHistory`)
 * and the fork locator (`devLogDivergence`) are held to by the CLI and by both Dart ports. Deterministic:
 * fixed seeds, Ed25519 signs deterministically. Run: `npx tsx scripts/gen-devhistory-vectors.ts`, then
 * copy the file to desktop/test/viewer/ and mobile/test/viewer/.
 */
import { writeFileSync } from 'fs'
import { join } from 'path'
import { ed25519 } from '@noble/curves/ed25519'
import { applyDevLogEntries, emptyDevLogState, nextDevLogEntry, signDevLogEntry, type DevLogEntry, type DevLogState } from '../src/lib/e2ee/deviceLog.js'
import { devLogHistory } from '../src/lib/e2ee/deviceHistory.js'

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64')
const seeds = { a: new Uint8Array(32).fill(1), b: new Uint8Array(32).fill(2), c: new Uint8Array(32).fill(3), d: new Uint8Array(32).fill(4) }
type Who = keyof typeof seeds
const pubs = Object.fromEntries(Object.entries(seeds).map(([k, s]) => [k, b64(ed25519.getPublicKey(s))])) as Record<Who, string>
const acct = 'acct-history-1'
const MID = 'a'.repeat(32)

function chain(steps: Array<[op: 'add' | 'remove', key: Who, signer: Who, label: string, kind: 'machine' | 'viewer', at: number]>): { entries: DevLogEntry[]; state: DevLogState } {
  let state = emptyDevLogState(acct)
  const entries: DevLogEntry[] = []
  for (const [op, key, signer, label, kind, at] of steps) {
    const e = signDevLogEntry(nextDevLogEntry(state, {
      op, pub: pubs[key], kind, machineId: kind === 'machine' ? MID : '', label, signer: pubs[signer],
    }, at), seeds[signer])
    state = applyDevLogEntries(state, [e]).state
    entries.push(e)
  }
  return { entries, state }
}

// The remove entries carry labels and kinds of their own choosing ('LIE', viewer): what the history
// and the notices say must come from the key's add.
const main = chain([
  ['add', 'a', 'a', 'mac', 'machine', 10],
  ['add', 'b', 'b', 'phone', 'viewer', 20],
  ['add', 'b', 'b', 'pixel', 'viewer', 30],
  ['add', 'c', 'c', 'ipad', 'viewer', 40],
  ['remove', 'c', 'a', 'LIE', 'machine', 50],
  ['remove', 'b', 'b', 'pixel', 'viewer', 60],
])
// A log that shares entries 1-2 with `main` and then goes its own way.
const fork = chain([
  ['add', 'a', 'a', 'mac', 'machine', 10],
  ['add', 'b', 'b', 'phone', 'viewer', 20],
  ['add', 'd', 'd', 'evil', 'viewer', 31],
  ['add', 'c', 'c', 'ipad', 'viewer', 41],
])

const row = (r: ReturnType<typeof devLogHistory>[number]) => ({
  seq: r.seq, op: r.op, label: r.label, kind: r.kind, ...(r.previousLabel !== undefined ? { previousLabel: r.previousLabel } : {}),
  ...(r.by ? { by: r.by.label } : {}), thisDevice: r.thisDevice, afterJoin: r.afterJoin, pending: r.pending, active: r.active, whileFrozen: r.whileFrozen,
})

const histCases = [
  { name: 'the whole log, newest first', self: 'a', joinedSeq: 1, pending: ['b'], seqs: [1, 2, 3, 4, 5, 6], loose: [] as number[] },
  { name: 'only the recent tail is known (offline)', self: 'a', joinedSeq: 1, pending: [], seqs: [4, 5, 6], loose: [] },
  { name: 'a removal whose add is outside the known window', self: 'a', joinedSeq: 1, pending: [], seqs: [5, 6], loose: [] },
  { name: 'a removal applied while frozen', self: 'a', joinedSeq: 1, pending: [], seqs: [1, 2, 3, 4, 6], loose: [5] },
  { name: 'no joined point known', self: 'b', pending: [], seqs: [1, 2, 3, 4, 5, 6], loose: [] },
].map((c) => {
  const pick = (seqs: number[]) => seqs.map((s) => main.entries[s - 1])
  const rows = devLogHistory(pick(c.seqs), {
    selfPub: pubs[c.self as Who], ...('joinedSeq' in c ? { joinedSeq: c.joinedSeq } : {}),
    pending: c.pending.map((k) => pubs[k as Who]), active: main.state.active, loose: pick(c.loose),
  })
  return { ...c, rows: rows.map(row) }
})

// `from`..`to` is the window of `log`'s hashes the peer sends; `tamper` breaks it on purpose.
const divCases: Array<{ name: string; log: 'main' | 'fork'; from: number; to: number; tamper?: 'gap' | 'head' | 'junk'; expect: number | null }> = [
  { name: 'the first differing position, the one before it matching', log: 'fork', from: 1, to: 4, expect: 3 },
  { name: 'a window that starts at the split cannot prove it', log: 'fork', from: 3, to: 4, expect: null },
  { name: 'the same log has no split', log: 'main', from: 1, to: 4, expect: null },
  { name: 'a window with a gap is not usable', log: 'fork', from: 1, to: 4, tamper: 'gap', expect: null },
  { name: 'a window that does not end at the peer head is not usable', log: 'fork', from: 1, to: 4, tamper: 'head', expect: null },
  { name: 'not a window at all', log: 'fork', from: 1, to: 4, tamper: 'junk', expect: null },
]

writeFileSync(join(import.meta.dirname, '../src/lib/e2ee/deviceHistory.vectors.json'), `${JSON.stringify({
  acct, pubs, entries: main.entries, fork: fork.entries, history: histCases, divergence: divCases,
}, null, 2)}\n`)
