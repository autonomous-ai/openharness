/**
 * E2EE persistence for the adapter: the computer's long-term identity keypair and the set of pinned
 * (paired) browser identities. Both live under ${ADAPTER_DATA_DIR}/e2e/, written immediately with
 * mode 0600 (pairs are rare — no debounce needed). The identity key is the root of trust; losing it
 * forces every browser to re-pair.
 */
import { mkdirSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { env } from '../../config/env.js'
import { atomicWriteJson, jsonArray, jsonObject, probeState, readState, requireState, type AtomicWriteOptions, type TrustFile } from '../secureState.js'
import { newIdentity, newPairId, b64e, b64d, fingerprint, type Identity, type PairRole } from './core.js'
import { stretchPassword } from './passwordPake.js'

const DIR = join(env.ADAPTER_DATA_DIR, 'e2e')
const IDENTITY_FILE = join(DIR, 'identity.json')
const PAIRED_FILE = join(DIR, 'paired.json')
const REMOTE_PASSWORD_FILE = join(DIR, 'remotePassword.json')

/** identity.json's content: a key pair of 32 bytes a side. Anything else is not this computer's identity. */
function parseIdentity(text: string): Identity {
  const raw = jsonObject(text)
  if (typeof raw.priv !== 'string' || typeof raw.pub !== 'string') throw new TypeError('not an identity')
  const identity = { priv: b64d(raw.priv), pub: b64d(raw.pub) }
  if (identity.priv.length !== 32 || identity.pub.length !== 32) throw new TypeError('not an identity')
  return identity
}

/** The trust files this store keeps, each with the parse it reads it with. */
export function e2eeStoreFiles(): TrustFile[] {
  return [
    { file: IDENTITY_FILE, parse: parseIdentity },
    { file: PAIRED_FILE, parse: jsonArray },
    { file: REMOTE_PASSWORD_FILE, parse: jsonObject },
  ]
}

/** This computer's identity public key (base64) as already on disk, or null. Unlike `E2eeStore.init()`
 *  it never creates a key and writes nothing, so a read-only command can show the fingerprint without
 *  minting an identity as a side effect. */
export function peekIdentityPub(): string | null {
  const identity = peekIdentity()
  return identity ? b64e(identity.pub) : null
}

/** This computer's identity keypair as already on disk, or null. Like `peekIdentityPub` it never creates one: a key
 *  made by a command that only needs to sign with the existing one would be on no device key log. Logs nothing: a
 *  read-only command says nothing of a file it does not change. */
export function peekIdentity(): Identity | null {
  const read = probeState(IDENTITY_FILE, parseIdentity)
  return read.state === 'ok' ? read.value : null
}

/** Whether an identity was retired here (`identity.json.removed-*`, left by signing this device out of
 *  the account), so "no identity" can be told apart from "never had one". */
export function identitySpent(): boolean {
  try { return readdirSync(DIR).some((f) => f.startsWith('identity.json.removed-')) } catch { return false }
}

// Remote-password lockout tuning (anti online-guessing for a reusable, human-memorable secret — see
// notePwFailure()/pwLockedUntil()). Distinct regime from the live pairing code's RATE_MAX=3/5min in
// manager.ts: that code is disposable and expires in 60s, so a handful of tries exhausts it quickly;
// this password is long-lived, so failures need a real, growing lockout instead.
const PW_FAIL_WINDOW_MS = 30 * 60 * 1000
const PW_FAIL_THRESHOLD = 5
const PW_LOCKOUT_BASE_MS = 5 * 60 * 1000 // 5 min
const PW_LOCKOUT_MAX_MS = 24 * 60 * 60 * 1000 // 24h, cap for the exponential backoff

interface RemotePasswordRecord {
  v: 1
  stretched: string // base64 — the 32-byte scrypt output, not the raw password
  setAt: number
  recentFailures: number[] // ms-epoch timestamps of recent failed attempts, trimmed to PW_FAIL_WINDOW_MS
  lockedUntil?: number
  lockoutCount?: number // consecutive lockouts since the password was last set — drives the backoff
}

export interface PairedClient {
  identityPub: string // base64 Ed25519 pubkey — the pin
  label: string       // UA-derived, for display
  pairedAt: number
  role: PairRole      // old records without this field are treated as web
  /** Set for a peer that joined over the remote password (or was learned from a trust-group sync): the
   *  joining machine's id when `kind` is 'machine', absent for a viewer app. Absent on older records. */
  machineId?: string
  kind?: PeerKind
  /** A machine of another account this machine is shared with (gateway/sharedTrust.ts): trusted like the
   *  account's own, but never a member of the trust group, and taken back when the sharing ends. */
  shared?: true
  /** With `shared`: the account (email) the machine is shared with. Its sessions are that account's guest
   *  (docs/plans/2026-10-19-guest-machine-sharing-plan.md). */
  sharedWith?: string
}

/** What a password-linked peer is: another harness machine (which also serves, so it can be dialed back)
 *  or a viewer app (mobile / viewer desktop — dial-out only). */
export type PeerKind = 'machine' | 'viewer'

/** Every file here is a trust file: written whole, never over one another account could write. */
function writeTrustFile(file: string, data: unknown, options?: AtomicWriteOptions): boolean {
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  return atomicWriteJson(file, data, 'trust', options)
}

/**
 * The identity on disk, or a new one. `harness login` and a booting daemon can both get here: the new key is
 * published only if no file is there yet, so exactly one is ever minted and the loser reads the winner's. A file that
 * cannot be read is never replaced (a new key would lose every pairing): `requireState` throws.
 */
function identityOnDisk(): Identity {
  for (;;) {
    const found = requireState(IDENTITY_FILE, parseIdentity)
    if (found) return found
    const id = newIdentity()
    if (writeTrustFile(IDENTITY_FILE, { priv: b64e(id.priv), pub: b64e(id.pub) }, { exclusive: true })) return id
    // Another process published its key first: the next read finds it.
  }
}

function pairedSet(entries: unknown[]): Map<string, PairedClient> {
  const paired = new Map<string, PairedClient>()
  for (const p of entries as Array<(PairedClient & { role?: PairRole }) | null>) {
    if (p?.identityPub) paired.set(p.identityPub, { ...p, role: p.role === 'device' ? 'device' : 'web' })
  }
  return paired
}

/** A record of another shape or version is no password, as it always was. */
function passwordRecord(raw: Record<string, unknown> | null): RemotePasswordRecord | null {
  if (raw?.v !== 1 || typeof raw.stretched !== 'string' || typeof raw.setAt !== 'number') return null
  return {
    v: 1,
    stretched: raw.stretched,
    setAt: raw.setAt,
    recentFailures: Array.isArray(raw.recentFailures) ? raw.recentFailures.filter((n): n is number => typeof n === 'number') : [],
    lockedUntil: typeof raw.lockedUntil === 'number' ? raw.lockedUntil : undefined,
    lockoutCount: typeof raw.lockoutCount === 'number' ? raw.lockoutCount : undefined,
  }
}

export class E2eeStore {
  private identity: Identity | null = null
  private paired = new Map<string, PairedClient>() // key = identityPub (base64)
  private remotePassword: RemotePasswordRecord | null = null
  // The file could not be read at the last load: what is held above is the fail-closed empty value, not the
  // file's, so a change reads it again first and is refused while it still cannot be read.
  private pairedUnreadable = false
  private remotePasswordUnreadable = false

  /** Load or create the computer identity keypair; load the paired set + remote-password state.
   *  Idempotent. */
  init(): Identity {
    if (this.identity) return this.identity
    this.identity = identityOnDisk()
    this.reloadPaired()
    const password = readState(REMOTE_PASSWORD_FILE, 'trust', jsonObject)
    this.remotePasswordUnreadable = password.state === 'unreadable'
    this.remotePassword = passwordRecord(password.state === 'ok' ? password.value : null)
    return this.identity
  }

  /** Read paired.json again, as it is on disk now (accountTrust.ts swaps it when the account changes). */
  reloadPaired(): void {
    const read = readState(PAIRED_FILE, 'trust', jsonArray)
    this.pairedUnreadable = read.state === 'unreadable'
    this.paired = pairedSet(read.state === 'ok' ? read.value : [])
  }

  private requirePaired(): void {
    if (!this.pairedUnreadable) return
    this.paired = pairedSet(requireState(PAIRED_FILE, jsonArray) ?? [])
    this.pairedUnreadable = false
  }

  private requireRemotePassword(): void {
    if (!this.remotePasswordUnreadable) return
    this.remotePassword = passwordRecord(requireState(REMOTE_PASSWORD_FILE, jsonObject))
    this.remotePasswordUnreadable = false
  }

  getIdentity(): Identity {
    return this.identity ?? this.init()
  }

  /** The computer identity's human fingerprint (shown on both CLI and browser to compare). */
  fingerprint(): string {
    return fingerprint(this.getIdentity().pub)
  }

  isPaired(identityPubB64: string): boolean {
    return this.paired.has(identityPubB64)
  }

  pairedRole(identityPubB64: string): PairRole | null {
    return this.paired.get(identityPubB64)?.role ?? null
  }

  pairedLabel(identityPubB64: string): string | null {
    return this.paired.get(identityPubB64)?.label ?? null
  }

  pairedPeer(identityPubB64: string): PairedClient | null {
    return this.paired.get(identityPubB64) ?? null
  }

  addPaired(identityPubB64: string, label: string, at: number, role: PairRole = 'web', peer?: { machineId?: string; kind?: PeerKind; shared?: boolean; sharedWith?: string }): void {
    this.requirePaired()
    this.paired.set(identityPubB64, {
      identityPub: identityPubB64, label, pairedAt: at, role,
      ...(peer?.machineId ? { machineId: peer.machineId } : {}),
      ...(peer?.kind ? { kind: peer.kind } : {}),
      ...(peer?.shared ? { shared: true as const } : {}),
      ...(peer?.shared && peer.sharedWith ? { sharedWith: peer.sharedWith } : {}),
    })
    writeTrustFile(PAIRED_FILE, [...this.paired.values()])
  }

  removePaired(identityPubB64: string): void {
    this.requirePaired()
    if (this.paired.delete(identityPubB64)) writeTrustFile(PAIRED_FILE, [...this.paired.values()])
  }

  /** Revoke ALL paired browsers. Returns the number removed. */
  clear(): number {
    this.requirePaired()
    const n = this.paired.size
    if (n) { this.paired.clear(); writeTrustFile(PAIRED_FILE, []) }
    return n
  }

  list(): PairedClient[] {
    return [...this.paired.values()]
  }
  count(): number {
    return this.paired.size
  }

  // ── persistent remote password (machine-to-machine `harness link connect`) ───────────────────────
  // A separate trust primitive from the ones above: not a pairing (paired.json) and not the live 6-char
  // CPace code — see passwordPake.ts for why this needs its own domain-separated CPace generator, and
  // manager.ts's onPwPairIntent/onPwPake for the state machine that consumes remotePasswordVerifier()/
  // notePwFailure()/notePwSuccess() below.

  /** Stretch + persist a new remote password (0600, same convention as identity.json/paired.json).
   *  Rotating the password always clears any existing lockout — a fresh secret invalidates whatever
   *  guessing history applied to the old one. */
  async setRemotePassword(machineId: string, password: string): Promise<{ fingerprint: string }> {
    this.requireRemotePassword()
    const stretched = await stretchPassword(password, machineId)
    const record: RemotePasswordRecord = { v: 1, stretched: b64e(stretched), setAt: Date.now(), recentFailures: [] }
    this.remotePassword = record
    writeTrustFile(REMOTE_PASSWORD_FILE, record)
    return { fingerprint: fingerprint(stretched) }
  }

  /** Remove the remote password. Until a new one is set, `harness link connect` against this machine
   *  always fails with NO_REMOTE_PASSWORD (checked before any crypto runs). */
  clearRemotePassword(): void {
    this.requireRemotePassword()
    this.remotePassword = null
    try { rmSync(REMOTE_PASSWORD_FILE, { force: true }) } catch { /* already gone */ }
  }

  hasRemotePassword(): boolean {
    return this.remotePassword !== null
  }

  /** The raw stretched verifier bytes, fed into passwordPake.ts's pwCpaceGenerator(); null if unset. */
  remotePasswordVerifier(): Uint8Array | null {
    return this.remotePassword ? b64d(this.remotePassword.stretched) : null
  }

  remotePasswordFingerprint(): string | null {
    return this.remotePassword ? fingerprint(b64d(this.remotePassword.stretched)) : null
  }

  remotePasswordSetAt(): number | null {
    return this.remotePassword ? this.remotePassword.setAt : null
  }

  /** Record a failed password-PAKE attempt (anti online-guessing — the password is reusable and
   *  human-memorable, unlike the disposable high-entropy live pairing code, so it needs a real,
   *  growing lockout rather than the code's fixed RATE_MAX/RATE_WINDOW). Failures older than
   *  PW_FAIL_WINDOW_MS don't count. Crossing PW_FAIL_THRESHOLD within the window locks out for an
   *  exponentially growing period (5m, 10m, 20m, ... capped at 24h), tracked by `lockoutCount` so
   *  repeated lockouts (not just repeated failures) escalate the wait. No-op if no password is set —
   *  there is nothing to guess. */
  notePwFailure(): { lockedUntil: number | null } {
    this.requireRemotePassword()
    const record = this.remotePassword
    if (!record) return { lockedUntil: null }
    const now = Date.now()
    // The backoff escalates across lockouts only while they keep coming: a quiet day since the last one
    // ended starts it over, so no one is held at the 24h ceiling for good.
    if (record.lockedUntil && now - record.lockedUntil > PW_LOCKOUT_MAX_MS) record.lockoutCount = 0
    record.recentFailures = [...record.recentFailures.filter((t) => now - t < PW_FAIL_WINDOW_MS), now]
    if (record.recentFailures.length >= PW_FAIL_THRESHOLD) {
      const count = (record.lockoutCount ?? 0) + 1
      record.lockoutCount = count
      record.lockedUntil = now + Math.min(PW_LOCKOUT_BASE_MS * 2 ** (count - 1), PW_LOCKOUT_MAX_MS)
      record.recentFailures = [] // fresh window once locked — it takes another full THRESHOLD after unlock
    }
    writeTrustFile(REMOTE_PASSWORD_FILE, record)
    return { lockedUntil: record.lockedUntil ?? null }
  }

  /** A successful pairing proves the password is known to its owner's machines: the failures and the
   *  lockout escalation that came before it no longer describe anyone's guessing, so both start over. */
  notePwSuccess(): void {
    this.requireRemotePassword()
    const record = this.remotePassword
    if (!record || (record.recentFailures.length === 0 && !record.lockoutCount)) return
    record.recentFailures = []
    record.lockoutCount = 0
    writeTrustFile(REMOTE_PASSWORD_FILE, record)
  }

  /** Current lockout, or null if unset/expired. An expired `lockedUntil` is treated as not-locked
   *  without rewriting the file — the next real failure (if any) will naturally recompute it. */
  pwLockedUntil(): number | null {
    const until = this.remotePassword?.lockedUntil
    if (!until || until <= Date.now()) return null
    return until
  }
}
