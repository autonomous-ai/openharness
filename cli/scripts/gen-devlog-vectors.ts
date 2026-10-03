/**
 * Regenerates src/lib/e2ee/deviceLog.vectors.json — the fixture every implementation of the device key
 * log (CLI, backend, desktop and mobile Dart) is held to. Deterministic: fixed seeds, Ed25519 signs
 * deterministically. Run: `npx tsx scripts/gen-devlog-vectors.ts`, then copy the file to the other trees.
 */
import { writeFileSync } from 'fs'
import { join } from 'path'
import { ed25519 } from '@noble/curves/ed25519'
import {
  applyDevLogEntries, DevLogError, emptyDevLogState, nextDevLogEntry, signDevLogEntry,
  type DevLogEntry, type DevLogState,
} from '../src/lib/e2ee/deviceLog.js'

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64')
const seed = (n: number): Uint8Array => new Uint8Array(32).fill(n)
const keys = {
  box1: seed(1), box2: seed(2), browser: seed(3), stranger: seed(4), box2b: seed(5),
}
const pub = (k: keyof typeof keys): string => b64(ed25519.getPublicKey(keys[k]))
const acct = 'acct-vectors-1'
const MID1 = 'a'.repeat(32)
const MID2 = 'b'.repeat(32)

let state: DevLogState = emptyDevLogState(acct)
const entries: DevLogEntry[] = []
function add(k: keyof typeof keys, kind: 'machine' | 'viewer', machineId: string, label: string, at: number): void {
  const e = signDevLogEntry(nextDevLogEntry(state, { op: 'add', pub: pub(k), kind, machineId, label, signer: pub(k) }, at), keys[k])
  state = applyDevLogEntries(state, [e]).state
  entries.push(e)
}
function remove(target: keyof typeof keys, by: keyof typeof keys, at: number): void {
  const m = state.active[pub(target)]
  const e = signDevLogEntry(nextDevLogEntry(state, { op: 'remove', pub: m.pub, kind: m.kind, machineId: m.machineId, label: m.label, signer: pub(by) }, at), keys[by])
  state = applyDevLogEntries(state, [e]).state
  entries.push(e)
}

add('box1', 'machine', MID1, 'box1', 1_000)
add('box2', 'machine', MID2, 'box2', 2_000)
add('browser', 'viewer', '', 'Browser · macOS — “Dee”', 3_000)
add('box1', 'machine', MID1, 'box1 (renamed)', 4_000)
remove('box2', 'browser', 5_000)
add('box2b', 'machine', MID2, 'box2', 6_000)

const valid = { entries, hashes: state.hashes, head: state.head, active: Object.keys(state.active).sort(), removed: state.removed }

/** Each invalid case: apply `after` valid entries, then `entry` must fail with `code`. */
const invalid: Array<{ name: string; after: number; entry: unknown; code: string }> = []
function bad(name: string, after: number, build: (s: DevLogState) => unknown, code: string): void {
  const s = applyDevLogEntries(emptyDevLogState(acct), entries.slice(0, after)).state
  const entry = build(s)
  try {
    applyDevLogEntries(s, [entry])
    throw new Error(`${name}: expected ${code}, got success`)
  } catch (err) {
    if (!(err instanceof DevLogError) || err.code !== code) throw new Error(`${name}: expected ${code}, got ${String(err)}`)
  }
  invalid.push({ name, after, entry, code })
}
const selfAdd = (s: DevLogState, k: keyof typeof keys, kind: 'machine' | 'viewer', machineId: string, label: string) =>
  signDevLogEntry(nextDevLogEntry(s, { op: 'add', pub: pub(k), kind, machineId, label, signer: pub(k) }, 9_000), keys[k])

bad('tampered label', 1, s => ({ ...selfAdd(s, 'box2', 'machine', MID2, 'box2'), label: 'evil' }), 'BAD_SIGNATURE')
bad('add signed by another key', 1, s => signDevLogEntry(nextDevLogEntry(s, { op: 'add', pub: pub('stranger'), kind: 'viewer', machineId: '', label: 'x', signer: pub('box1') }, 9_000), keys.box1), 'NOT_SELF_SIGNED')
bad('machine id of another active machine', 2, s => selfAdd(s, 'stranger', 'machine', MID2, 'imposter'), 'MACHINE_TAKEN')
bad('removed key comes back', 5, s => selfAdd(s, 'box2', 'machine', MID2, 'box2 again'), 'KEY_REMOVED')
bad('remove signed by a key not in the log', 2, s => signDevLogEntry(nextDevLogEntry(s, { op: 'remove', pub: pub('box1'), kind: 'machine', machineId: MID1, label: 'box1', signer: pub('stranger') }, 9_000), keys.stranger), 'SIGNER_NOT_ACTIVE')
bad('remove of a key not in the log', 2, s => signDevLogEntry(nextDevLogEntry(s, { op: 'remove', pub: pub('stranger'), kind: 'viewer', machineId: '', label: '', signer: pub('box1') }, 9_000), keys.box1), 'NOT_ACTIVE')
bad('wrong prev', 2, s => signDevLogEntry({ ...nextDevLogEntry(s, { op: 'add', pub: pub('stranger'), kind: 'viewer', machineId: '', label: 'x', signer: pub('stranger') }, 9_000), prev: s.hashes[0] }, keys.stranger), 'BROKEN_CHAIN')
bad('skipped seq', 2, s => signDevLogEntry({ ...nextDevLogEntry(s, { op: 'add', pub: pub('stranger'), kind: 'viewer', machineId: '', label: 'x', signer: pub('stranger') }, 9_000), seq: 4 }, keys.stranger), 'OUT_OF_ORDER')
bad('other account', 2, s => signDevLogEntry({ ...nextDevLogEntry(s, { op: 'add', pub: pub('stranger'), kind: 'viewer', machineId: '', label: 'x', signer: pub('stranger') }, 9_000), acct: 'acct-other' }, keys.stranger), 'WRONG_ACCOUNT')
bad('machine changes kind', 1, s => selfAdd(s, 'box1', 'viewer', '', 'box1'), 'KIND_CHANGED')
bad('re-add with nothing changed', 1, s => selfAdd(s, 'box1', 'machine', MID1, 'box1'), 'NO_CHANGE')
bad('viewer with a machine id', 0, s => selfAdd(s, 'browser', 'viewer', MID1, 'b'), 'BAD_ENTRY')
bad('control character in label', 0, s => selfAdd(s, 'browser', 'viewer', '', 'a\nb'), 'BAD_ENTRY')

const out = {
  comment: 'Generated by cli/scripts/gen-devlog-vectors.ts. Keys are Ed25519 seeds of 32 identical bytes (box1=1, box2=2, browser=3, stranger=4, box2b=5).',
  acct,
  seeds: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, b64(v)])),
  pubs: Object.fromEntries(Object.keys(keys).map(k => [k, pub(k as keyof typeof keys)])),
  valid,
  invalid,
}
writeFileSync(join(import.meta.dirname, '../src/lib/e2ee/deviceLog.vectors.json'), JSON.stringify(out, null, 2) + '\n')
console.log(`wrote ${entries.length} valid entries, ${invalid.length} invalid cases`)
