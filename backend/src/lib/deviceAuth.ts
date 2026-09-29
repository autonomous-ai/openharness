import { randomBytes, createHash } from 'crypto'
import { pub } from './bus.js'
import { logger } from '../utils/logger.js'
import type { HarnessTokens } from './harnessSession.js'

/**
 * Machine sign-in approved from a phone (RFC 8628-shaped): `harness login` and the desktop app's
 * sign-in show a QR; a phone already signed in scans it, sees which computer is asking, and approves.
 *
 *   machine → POST /api/device-auth/start   (no auth)  → { userCode, deviceCode }   userCode → the QR
 *   phone   → GET  /api/device-auth/lookup  (signed in) → what is asking, for the confirm screen
 *   phone   → POST /api/device-auth/approve (signed in) → the machine is bound, a DAEMON session minted
 *   machine → POST /api/device-auth/poll    (no auth)  → that session's tokens, handed over once
 *
 * The machine receives a Harness daemon session (lib/harnessSession.ts `createDaemonSession`): a
 * sign-in of its own, bound to the computer that asked, which `/api/adapter-ws` accepts for that
 * computer only. It never sees the phone's credential.
 *
 * The user code travels in the QR, not a person's typing, so it is long (128 bits) and dies in
 * [TTL_SEC]. The QR also carries the machine's E2EE pairing code and fingerprint, which never reach
 * this server: it can sign a machine in, but not join the machine's end-to-end link.
 *
 * Redis, not Mongo: every record here is dead within minutes and a crashed worker losing one costs
 * the user a rescan, not data.
 */

const TTL_SEC = 180            // a QR on a screen: long enough to find the phone, short enough to go stale
const POLL_MIN_INTERVAL_SEC = 2
const USER_CODE_LENGTH = 26    // 26 × 5 bits = 130 bits

// Crockford base32 minus I/L/O/U, so a code read off a screen by hand still normalises.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export type DeviceAuthState = 'pending' | 'approved' | 'denied'

/**
 * Who is asking. `machine`: a computer (`harness login`, the desktop app) — approval binds it to a
 * machine and mints a daemon session. `viewer`: a browser's sign-in page — approval mints a viewer
 * session, and the phone names one of its machines for the browser to E2EE-link through.
 */
export type DeviceAuthKind = 'machine' | 'viewer'

export interface DeviceAuthRecord {
  state: DeviceAuthState
  /** Absent on records from before viewers could ask: a machine. */
  kind?: DeviceAuthKind
  /** The asking computer; empty for a viewer. */
  computerId: string
  label: string
  /** The asking machine's E2EE identity fingerprint, for the phone to compare with its screen. */
  fingerprint?: string
  /** Where the request came from (Cloudflare country), for the phone's "requested from" line. */
  country?: string
  requestedAt?: number
  /** Set once approved: the machine bound to this computer, and the sign-in minted for it. */
  machineId?: string
  userId?: string
  session?: HarnessTokens
  /** A viewer's E2EE public key (base64), which the approving phone checks against the QR's
   *  fingerprint before it takes the browser into its trust group. */
  pub?: string
  /** A viewer's approval: the phone's trust-group roster, sealed under the QR's pairing code — which
   *  never reaches this server, so it can neither read nor alter what the browser is handed. */
  sealedRoster?: string
  error?: string
}

const codeKey = (userCode: string): string => `devauth:code:${userCode}`
const deviceKey = (deviceHash: string): string => `devauth:dev:${deviceHash}`
const claimKey = (deviceHash: string): string => `devauth:claim:${deviceHash}`

/** The device code is a bearer secret, so only its hash is stored — a Redis dump must not be a key store. */
const hash = (s: string): string => createHash('sha256').update(s).digest('hex')

/** 256 is a multiple of 32, so `byte % 32` is unbiased. */
function newUserCode(): string {
  const b = randomBytes(USER_CODE_LENGTH)
  return Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join('')
}

export interface StartResult {
  deviceCode: string
  userCode: string
  expiresInSec: number
  intervalSec: number
}

export async function startDeviceAuth(
  computerId: string,
  label: string,
  extra: { fingerprint?: string; country?: string; kind?: DeviceAuthKind; pub?: string } = {},
): Promise<StartResult> {
  const deviceCode = randomBytes(32).toString('hex')
  const userCode = newUserCode() // 130 bits: a collision is not a case worth code

  const record: DeviceAuthRecord = {
    state: 'pending',
    ...(extra.kind === 'viewer' ? { kind: 'viewer' as const } : {}),
    ...(extra.pub ? { pub: extra.pub } : {}),
    computerId,
    label,
    requestedAt: Date.now(),
    ...(extra.fingerprint ? { fingerprint: extra.fingerprint } : {}),
    ...(extra.country ? { country: extra.country } : {}),
  }
  const payload = JSON.stringify(record)
  await pub.set(deviceKey(hash(deviceCode)), payload, 'EX', TTL_SEC)
  // The user-facing code maps to the device record, so approving by code can find it.
  await pub.set(codeKey(userCode), hash(deviceCode), 'EX', TTL_SEC)
  return { deviceCode, userCode, expiresInSec: TTL_SEC, intervalSec: POLL_MIN_INTERVAL_SEC }
}

/** Look up a pending request by the code the human typed. */
export async function findByUserCode(userCode: string): Promise<{ deviceHash: string; record: DeviceAuthRecord } | null> {
  const normalized = normalizeUserCode(userCode)
  const deviceHash = await pub.get(codeKey(normalized))
  if (!deviceHash) return null
  const raw = await pub.get(deviceKey(deviceHash))
  if (!raw) return null
  try { return { deviceHash, record: JSON.parse(raw) as DeviceAuthRecord } } catch { return null }
}

export async function resolveDeviceAuth(
  deviceHash: string,
  update: Partial<DeviceAuthRecord>,
): Promise<void> {
  const raw = await pub.get(deviceKey(deviceHash))
  if (!raw) return
  let record: DeviceAuthRecord
  try { record = JSON.parse(raw) as DeviceAuthRecord } catch { return }
  const next = { ...record, ...update }
  // Keep the remaining TTL rather than extending it: approval does not entitle the app to another
  // ten minutes of polling.
  const ttl = await pub.ttl(deviceKey(deviceHash))
  await pub.set(deviceKey(deviceHash), JSON.stringify(next), 'EX', ttl > 0 ? ttl : 60)
}

/**
 * Take exclusive ownership of a pending request before acting on it.
 *
 * `findByUserCode` + "is it still pending?" is check-then-act, and approving is NOT idempotent: it can
 * create a machine. Two approvals racing the same code therefore both saw `pending`, both found no
 * machine bound to the computer, and both created one — two machines, one computer, a millisecond
 * apart. React's StrictMode double-invoking an effect is enough to trigger it, and so is a double-click.
 *
 * `SET NX` is the whole lock: the first caller gets it, everyone else is told the code is spent. It
 * inherits the request's remaining TTL, so a crashed approval cannot wedge a code for longer than the
 * code itself lives.
 */
export async function claimDeviceAuth(deviceHash: string): Promise<boolean> {
  const ttl = await pub.ttl(deviceKey(deviceHash))
  const res = await pub.set(claimKey(deviceHash), '1', 'EX', ttl > 0 ? ttl : 60, 'NX')
  return res === 'OK'
}

/** Hand the claim back when an approval fails, so the user can fix the problem and retry the code. */
export async function releaseDeviceAuthClaim(deviceHash: string): Promise<void> {
  try { await pub.del(claimKey(deviceHash)) } catch (err) { logger.error('[devauth] claim release failed', err) }
}

/**
 * Poll. A settled read is DESTRUCTIVE — the session is handed over exactly once, so a leaked device
 * code cannot be replayed later to fetch the same sign-in again.
 */
export async function pollDeviceAuth(deviceCode: string): Promise<DeviceAuthRecord | null> {
  const dh = hash(deviceCode)
  const raw = await pub.get(deviceKey(dh))
  if (!raw) return null
  let record: DeviceAuthRecord
  try { record = JSON.parse(raw) as DeviceAuthRecord } catch { return null }
  if (record.state === 'approved' || record.state === 'denied') {
    try { await pub.del(deviceKey(dh), claimKey(dh)) } catch (err) { logger.error('[devauth] cleanup failed', err) }
  }
  return record
}

/**
 * One wire form for a computer id, whoever sent it: the CLI persists a dashed uuid
 * (`~/.harness/computer-id`) while the Mac app already hashes to 32 hex. Lowercased and de-dashed so
 * the SAME computer is the same string in Mongo regardless of which client asked — the reuse lookup
 * in machineService.resolveOrCreateForComputer is an equality match and would otherwise miss.
 * Returns null when it is not a plausible id (the caller answers 400).
 */
export function normalizeComputerId(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/-/g, '')
  return /^[a-f0-9]{16,64}$/.test(v) ? v : null
}

/** Uppercase, strip separators, fold look-alikes — the user is copying this off a screen. */
export function normalizeUserCode(code: string): string {
  return code.toUpperCase().replace(/[\s\-_·]/g, '')
    .replace(/I/g, '1').replace(/L/g, '1').replace(/O/g, '0').replace(/U/g, 'V')
}
