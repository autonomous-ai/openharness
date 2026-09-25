/**
 * E2EE persistence for the adapter: the computer's long-term identity keypair and the set of pinned
 * (paired) browser identities. Both live under ${ADAPTER_DATA_DIR}/e2e/, written immediately with
 * mode 0600 (pairs are rare — no debounce needed). The identity key is the root of trust; losing it
 * forces every browser to re-pair.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { env } from '../../config/env.js'
import { newIdentity, newPairId, b64e, b64d, fingerprint, type Identity, type PairRole } from './core.js'
import { stretchPassword } from './passwordPake.js'

const DIR = join(env.ADAPTER_DATA_DIR, 'e2e')
const IDENTITY_FILE = join(DIR, 'identity.json')
const PAIRED_FILE = join(DIR, 'paired.json')
const REMOTE_PASSWORD_FILE = join(DIR, 'remotePassword.json')

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
}
function writeSecure(file: string, data: unknown): void {
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 })
}

export class E2eeStore {
  private identity: Identity | null = null
  private paired = new Map<string, PairedClient>() // key = identityPub (base64)
  private remotePassword: RemotePasswordRecord | null = null

  /** Load or create the computer identity keypair; load the paired set + remote-password state.
   *  Idempotent. */
  init(): Identity {
    if (this.identity) return this.identity
    try {
      const raw = JSON.parse(readFileSync(IDENTITY_FILE, 'utf-8')) as { priv: string; pub: string }
      this.identity = { priv: b64d(raw.priv), pub: b64d(raw.pub) }
    } catch {
      const id = newIdentity()
      writeSecure(IDENTITY_FILE, { priv: b64e(id.priv), pub: b64e(id.pub) })
      this.identity = id
    }
    try {
      const arr = JSON.parse(readFileSync(PAIRED_FILE, 'utf-8')) as Array<PairedClient & { role?: PairRole }>
      for (const p of arr) {
        if (p?.identityPub) this.paired.set(p.identityPub, { ...p, role: p.role === 'device' ? 'device' : 'web' })
      }
    } catch { /* none yet */ }
    try {
      const raw = JSON.parse(readFileSync(REMOTE_PASSWORD_FILE, 'utf-8')) as Partial<RemotePasswordRecord>
      if (raw?.v === 1 && typeof raw.stretched === 'string' && typeof raw.setAt === 'number') {
        this.remotePassword = {
          v: 1,
          stretched: raw.stretched,
          setAt: raw.setAt,
          recentFailures: Array.isArray(raw.recentFailures) ? raw.recentFailures.filter((n) => typeof n === 'number') : [],
          lockedUntil: typeof raw.lockedUntil === 'number' ? raw.lockedUntil : undefined,
          lockoutCount: typeof raw.lockoutCount === 'number' ? raw.lockoutCount : undefined,
        }
      }
    } catch { /* none yet */ }
    return this.identity
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

  addPaired(identityPubB64: string, label: string, at: number, role: PairRole = 'web'): void {
    this.paired.set(identityPubB64, { identityPub: identityPubB64, label, pairedAt: at, role })
    writeSecure(PAIRED_FILE, [...this.paired.values()])
  }

  removePaired(identityPubB64: string): void {
    if (this.paired.delete(identityPubB64)) writeSecure(PAIRED_FILE, [...this.paired.values()])
  }

  /** Revoke ALL paired browsers. Returns the number removed. */
  clear(): number {
    const n = this.paired.size
    if (n) { this.paired.clear(); writeSecure(PAIRED_FILE, []) }
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
    const stretched = await stretchPassword(password, machineId)
    const record: RemotePasswordRecord = { v: 1, stretched: b64e(stretched), setAt: Date.now(), recentFailures: [] }
    this.remotePassword = record
    writeSecure(REMOTE_PASSWORD_FILE, record)
    return { fingerprint: fingerprint(stretched) }
  }

  /** Remove the remote password. Until a new one is set, `harness link connect` against this machine
   *  always fails with NO_REMOTE_PASSWORD (checked before any crypto runs). */
  clearRemotePassword(): void {
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
    writeSecure(REMOTE_PASSWORD_FILE, record)
    return { lockedUntil: record.lockedUntil ?? null }
  }

  /** A successful pairing proves the password is known to its owner's machines: the failures and the
   *  lockout escalation that came before it no longer describe anyone's guessing, so both start over. */
  notePwSuccess(): void {
    const record = this.remotePassword
    if (!record || (record.recentFailures.length === 0 && !record.lockoutCount)) return
    record.recentFailures = []
    record.lockoutCount = 0
    writeSecure(REMOTE_PASSWORD_FILE, record)
  }

  /** Current lockout, or null if unset/expired. An expired `lockedUntil` is treated as not-locked
   *  without rewriting the file — the next real failure (if any) will naturally recompute it. */
  pwLockedUntil(): number | null {
    const until = this.remotePassword?.lockedUntil
    if (!until || until <= Date.now()) return null
    return until
  }
}
