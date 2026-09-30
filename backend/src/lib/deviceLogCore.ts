/**
 * The device key log — an account's append-only, hash-chained list of the identity keys its devices
 * (machines and viewer apps) hold. Every device trusts the keys the log says are active, so signing in
 * is all it takes for an account's machines to reach each other end to end, with no remote password.
 *
 * The backend stores and serves the log but cannot forge an entry: an `add` is signed by the key it
 * adds, a `remove` by a key that is active at that point. What the backend CAN do — add a device of its
 * own — is not prevented, only made visible: every device announces a key it has not trusted before
 * ("New device: X"), and devices gossip the log's head over their E2EE sessions (`group_sync`), so a
 * backend that shows two devices different logs, or hides an entry from one, is caught.
 *
 * Pure: no I/O. Signatures and hashes cover a length-prefixed binary encoding of the fields in a fixed
 * order (as `helloSig` does) — never JSON, whose canonical form drifts between TS and Dart. JSON is
 * only the wire format.
 *
 * ⚠ A copy of cli/src/lib/e2ee/deviceLog.ts, identical below the imports (noble v2 import paths here).
 * Also ported to Dart (desktop/lib/viewer/device_log.dart, mobile/lib/viewer/device_log.dart). All of them are
 * held to deviceLog.vectors.json; change the format in every copy together.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'

export const DEVLOG_VERSION = 1
/** How many keys one account may have active at once. */
export const DEVLOG_MAX_ACTIVE = 256
export const DEVLOG_LABEL_MAX = 60

export type DevLogOp = 'add' | 'remove'
export type DevLogKind = 'machine' | 'viewer'

export interface DevLogEntry {
  v: number
  /** The account (backend User id) the log belongs to. */
  acct: string
  /** 1-based position in the log. */
  seq: number
  /** base64 hash of the previous entry; 32 zero bytes for the first. */
  prev: string
  op: DevLogOp
  /** base64 Ed25519 key the entry is about. */
  pub: string
  kind: DevLogKind
  /** A machine's id; '' for a viewer. */
  machineId: string
  label: string
  /** Milliseconds since the epoch, as the signer's clock read it. */
  at: number
  /** base64 Ed25519 key that signed the entry. */
  signer: string
  sig: string
}

export type UnsignedDevLogEntry = Omit<DevLogEntry, 'sig'>

export interface DevLogMember {
  pub: string
  kind: DevLogKind
  machineId: string
  label: string
  /** `at` of the entry that added it. */
  addedAt: number
  /** seq of the entry that added it. */
  seq: number
}

export interface DevLogHead { seq: number; hash: string }

export interface DevLogState {
  acct: string
  head: DevLogHead
  /** hashes[i] is the hash of the entry with seq i + 1. */
  hashes: string[]
  /** Active keys, by pub. */
  active: Record<string, DevLogMember>
  /** Keys a `remove` took out. A removed key never comes back: a device that returns uses a new one. */
  removed: string[]
}

export type DevLogErrorCode =
  | 'BAD_ENTRY'
  | 'WRONG_ACCOUNT'
  | 'OUT_OF_ORDER'
  | 'BROKEN_CHAIN'
  | 'BAD_SIGNATURE'
  | 'NOT_SELF_SIGNED'
  | 'KEY_REMOVED'
  | 'KIND_CHANGED'
  | 'NO_CHANGE'
  | 'MACHINE_TAKEN'
  | 'TOO_MANY'
  | 'SIGNER_NOT_ACTIVE'
  | 'NOT_ACTIVE'

export class DevLogError extends Error {
  constructor(readonly code: DevLogErrorCode, readonly seq: number) {
    super(`device log entry ${seq}: ${code}`)
  }
}

const HAS_BUFFER = typeof Buffer !== 'undefined'
const MACHINE_ID_RE = /^[a-f0-9]{32}$/
const ZERO_HASH = b64e(new Uint8Array(32))

function b64e(u: Uint8Array): string {
  if (HAS_BUFFER) return Buffer.from(u).toString('base64')
  let s = ''
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i])
  return btoa(s)
}
function b64d(s: string): Uint8Array {
  if (HAS_BUFFER) return new Uint8Array(Buffer.from(s, 'base64'))
  const bin = atob(s)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}
/** base64 of exactly [n] bytes, in its one canonical spelling; null otherwise. */
function bytesOf(s: unknown, n: number): Uint8Array | null {
  if (typeof s !== 'string' || s.length > 128) return null
  try {
    const u = b64d(s)
    return u.length === n && b64e(u) === s ? u : null
  } catch { return null }
}
function lvCat(...parts: Array<Uint8Array | string>): Uint8Array {
  const chunks: Uint8Array[] = []
  let total = 0
  for (const p of parts) {
    const b = typeof p === 'string' ? new TextEncoder().encode(p) : p
    const len = new Uint8Array(4)
    new DataView(len.buffer).setUint32(0, b.length, false)
    chunks.push(len, b)
    total += 4 + b.length
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out
}

/** The bytes a signature covers. Numbers are written in decimal, so every language agrees. */
export function devLogMessage(e: UnsignedDevLogEntry): Uint8Array {
  return lvCat(
    'harness-devlog-v1', String(e.v), e.acct, String(e.seq), b64d(e.prev), e.op, b64d(e.pub),
    e.kind, e.machineId, e.label, String(e.at), b64d(e.signer),
  )
}

/** The entry's hash: what the next entry's `prev` names. */
export function devLogHash(e: DevLogEntry): string {
  return b64e(sha256(lvCat(devLogMessage(e), b64d(e.sig))))
}

export function signDevLogEntry(e: UnsignedDevLogEntry, priv: Uint8Array): DevLogEntry {
  return { ...e, sig: b64e(ed25519.sign(devLogMessage(e), priv)) }
}

export function emptyDevLogState(acct: string): DevLogState {
  return { acct, head: { seq: 0, hash: ZERO_HASH }, hashes: [], active: {}, removed: [] }
}

/** Every field present, of its type and within bounds; null when anything is off. */
export function parseDevLogEntry(raw: unknown): DevLogEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const { v, acct, seq, prev, op, pub, kind, machineId, label, at, signer, sig } = r
  if (v !== DEVLOG_VERSION) return null
  if (typeof acct !== 'string' || !acct || acct.length > 128) return null
  if (!Number.isSafeInteger(seq) || (seq as number) < 1) return null
  if (!bytesOf(prev, 32) || !bytesOf(pub, 32) || !bytesOf(signer, 32) || !bytesOf(sig, 64)) return null
  if (op !== 'add' && op !== 'remove') return null
  if (kind !== 'machine' && kind !== 'viewer') return null
  if (typeof machineId !== 'string') return null
  if (kind === 'machine' ? !MACHINE_ID_RE.test(machineId) : machineId !== '') return null
  // A label is shown as is: refuse control characters rather than rewrite what was signed.
  if (typeof label !== 'string' || label.length > DEVLOG_LABEL_MAX || /[\u0000-\u001f\u007f]/.test(label)) return null
  if (!Number.isSafeInteger(at) || (at as number) <= 0) return null
  return {
    v, acct, seq: seq as number, prev: prev as string, op, pub: pub as string, kind, machineId, label,
    at: at as number, signer: signer as string, sig: sig as string,
  }
}

function cloneState(s: DevLogState): DevLogState {
  return { acct: s.acct, head: { ...s.head }, hashes: [...s.hashes], active: { ...s.active }, removed: [...s.removed] }
}

export interface DevLogApplied {
  state: DevLogState
  /** Keys that became active (a label change is not one). */
  added: DevLogMember[]
  /** Keys that were active and are not any more. */
  removed: DevLogMember[]
  /** Keys whose label changed. */
  relabeled: DevLogMember[]
}

/**
 * Apply [entries], in order, on top of [state]. All or nothing: the first entry that breaks a rule
 * throws a [DevLogError] and [state] is left as it was.
 */
export function applyDevLogEntries(state: DevLogState, entries: readonly unknown[]): DevLogApplied {
  const s = cloneState(state)
  const out: DevLogApplied = { state: s, added: [], removed: [], relabeled: [] }
  for (const raw of entries) {
    const expectedSeq = s.head.seq + 1
    const e = parseDevLogEntry(raw)
    if (!e) throw new DevLogError('BAD_ENTRY', expectedSeq)
    if (e.acct !== s.acct) throw new DevLogError('WRONG_ACCOUNT', e.seq)
    if (e.seq !== expectedSeq) throw new DevLogError('OUT_OF_ORDER', e.seq)
    if (e.prev !== s.head.hash) throw new DevLogError('BROKEN_CHAIN', e.seq)
    let signed = false
    try { signed = ed25519.verify(b64d(e.sig), devLogMessage(e), b64d(e.signer)) } catch { signed = false }
    if (!signed) throw new DevLogError('BAD_SIGNATURE', e.seq)

    if (e.op === 'add') {
      if (e.signer !== e.pub) throw new DevLogError('NOT_SELF_SIGNED', e.seq)
      if (s.removed.includes(e.pub)) throw new DevLogError('KEY_REMOVED', e.seq)
      const current = s.active[e.pub]
      if (current) {
        if (current.kind !== e.kind || current.machineId !== e.machineId) throw new DevLogError('KIND_CHANGED', e.seq)
        if (current.label === e.label) throw new DevLogError('NO_CHANGE', e.seq)
        const relabeled = { ...current, label: e.label }
        s.active[e.pub] = relabeled
        out.relabeled.push(relabeled)
      } else {
        if (e.kind === 'machine' && Object.values(s.active).some(m => m.kind === 'machine' && m.machineId === e.machineId)) {
          throw new DevLogError('MACHINE_TAKEN', e.seq)
        }
        if (Object.keys(s.active).length >= DEVLOG_MAX_ACTIVE) throw new DevLogError('TOO_MANY', e.seq)
        const member: DevLogMember = { pub: e.pub, kind: e.kind, machineId: e.machineId, label: e.label, addedAt: e.at, seq: e.seq }
        s.active[e.pub] = member
        out.added.push(member)
      }
    } else {
      if (!s.active[e.signer]) throw new DevLogError('SIGNER_NOT_ACTIVE', e.seq)
      const gone = s.active[e.pub]
      if (!gone) throw new DevLogError('NOT_ACTIVE', e.seq)
      delete s.active[e.pub]
      s.removed.push(e.pub)
      out.removed.push(gone)
    }
    const hash = devLogHash(e)
    s.hashes.push(hash)
    s.head = { seq: e.seq, hash }
  }
  return out
}

/** The hash this state holds for [seq]; null when it does not reach that far. */
export function devLogHashAt(state: DevLogState, seq: number): string | null {
  if (seq === 0) return ZERO_HASH
  return seq >= 1 && seq <= state.hashes.length ? state.hashes[seq - 1] : null
}

/**
 * How another device's head relates to ours: the same log, one of us ahead of the other on the same
 * log, or a FORK — two different entries at one position, which only a lying backend produces.
 */
export function compareDevLogHead(state: DevLogState, theirs: DevLogHead): 'same' | 'behind' | 'ahead' | 'fork' {
  if (theirs.seq > state.head.seq) return 'behind'
  const ours = devLogHashAt(state, theirs.seq)
  if (ours !== theirs.hash) return 'fork'
  return theirs.seq === state.head.seq ? 'same' : 'ahead'
}

/** The next entry to append on top of [state], unsigned. */
export function nextDevLogEntry(
  state: DevLogState,
  fields: Pick<DevLogEntry, 'op' | 'pub' | 'kind' | 'machineId' | 'label' | 'signer'>,
  at: number,
): UnsignedDevLogEntry {
  return { v: DEVLOG_VERSION, acct: state.acct, seq: state.head.seq + 1, prev: state.head.hash, at, ...fields }
}
