import { prisma } from './prisma.js'
import { pub, publishDeviceKeysChanged, publishDown } from './bus.js'
import { logger } from '../utils/logger.js'
import {
  applyDevLogEntries, DevLogError, emptyDevLogState, parseDevLogEntry,
  type DevLogEntry, type DevLogHead, type DevLogState,
} from './deviceLogCore.js'

/**
 * The account's device key log, as the backend keeps it (the format and every rule are
 * lib/deviceLogCore.ts). This side stores and serves it, and refuses an entry that breaks a rule, so a
 * device never has to throw a bad one away — but no device takes the backend's word for anything: each
 * verifies the whole chain itself, and gossips the head with the others.
 *
 * Who may append what is decided by the CHANNEL, on top of the signatures:
 *  - a machine appends over its own adapter socket, and only about ITSELF (`kind: 'machine'`, its own
 *    machineId) — so no device can register a key under another machine's id;
 *  - a viewer app appends over REST, only `kind: 'viewer'` entries, and signs removals with a viewer key.
 */

/** A page is enough for any real account (256 active keys at most); a device asks again from its head. */
const PAGE = 500

export type DeviceKeyAppendError =
  | { status: 409; code: 'STALE_HEAD'; head: DevLogHead }
  | { status: 400; code: string }
  | { status: 403; code: 'WRONG_CHANNEL' }

export type DeviceKeyAppendResult = { ok: true; head: DevLogHead } | ({ ok: false } & DeviceKeyAppendError)

/** Who is appending: a machine over its adapter socket, or a viewer over REST. */
export type DeviceKeyChannel =
  | { kind: 'machine'; machineId: string }
  | { kind: 'viewer'; harnessSessionId?: string }

export async function readDeviceKeyLog(userId: string, since: number): Promise<{ acct: string; head: DevLogHead; entries: unknown[] }> {
  const [rows, last] = await Promise.all([
    prisma.deviceKeyLogEntry.findMany({ where: { userId, seq: { gt: since } }, orderBy: { seq: 'asc' }, take: PAGE }),
    prisma.deviceKeyLogEntry.findFirst({ where: { userId }, orderBy: { seq: 'desc' }, select: { seq: true, hash: true } }),
  ])
  const head = last ?? emptyDevLogState(userId).head
  return { acct: userId, head: { seq: head.seq, hash: head.hash }, entries: rows.map(r => JSON.parse(r.entry) as unknown) }
}

/** The whole log, verified. It is small and read only when something is appended. */
async function currentState(userId: string): Promise<{ state: DevLogState; sessions: Map<string, string> }> {
  const rows = await prisma.deviceKeyLogEntry.findMany({ where: { userId }, orderBy: { seq: 'asc' } })
  const { state } = applyDevLogEntries(emptyDevLogState(userId), rows.map(r => JSON.parse(r.entry) as unknown))
  const sessions = new Map<string, string>()
  for (const r of rows) {
    const e = JSON.parse(r.entry) as DevLogEntry
    if (r.sessionId && e.op === 'add') sessions.set(e.pub, r.sessionId)
  }
  return { state, sessions }
}

function channelAllows(entry: DevLogEntry, state: DevLogState, channel: DeviceKeyChannel): boolean {
  const signer = state.active[entry.signer]
  if (channel.kind === 'machine') {
    // A machine speaks only as itself: its own key, under its own id.
    if (entry.op === 'add') return entry.kind === 'machine' && entry.machineId === channel.machineId
    return signer?.kind === 'machine' && signer.machineId === channel.machineId
  }
  if (entry.op === 'add') return entry.kind === 'viewer'
  return signer?.kind === 'viewer'
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002'
}

export async function appendDeviceKey(userId: string, raw: unknown, channel: DeviceKeyChannel): Promise<DeviceKeyAppendResult> {
  const entry = parseDevLogEntry(raw)
  if (!entry) return { ok: false, status: 400, code: 'BAD_ENTRY' }
  if (entry.acct !== userId) return { ok: false, status: 400, code: 'WRONG_ACCOUNT' }
  const { state, sessions } = await currentState(userId)
  if (entry.seq !== state.head.seq + 1 || entry.prev !== state.head.hash) {
    return { ok: false, status: 409, code: 'STALE_HEAD', head: state.head }
  }
  if (!channelAllows(entry, state, channel)) return { ok: false, status: 403, code: 'WRONG_CHANNEL' }
  let applied
  try {
    applied = applyDevLogEntries(state, [entry])
  } catch (err) {
    if (err instanceof DevLogError) return { ok: false, status: 400, code: err.code }
    throw err
  }
  const head = applied.state.head
  try {
    await prisma.deviceKeyLogEntry.create({
      data: {
        userId, seq: entry.seq, hash: head.hash, entry: JSON.stringify(entry),
        sessionId: entry.op === 'add' && channel.kind === 'viewer' ? channel.harnessSessionId ?? null : null,
      },
    })
  } catch (err) {
    // Another device appended at this head first.
    if (isUniqueViolation(err)) {
      const { state: now } = await currentState(userId)
      return { ok: false, status: 409, code: 'STALE_HEAD', head: now.head }
    }
    throw err
  }
  await publishDeviceKeysChanged(userId, head).catch(() => { /* best effort: devices also re-read on their own */ })
  touchDeviceKey(userId, entry.signer)
  for (const gone of applied.removed) await signOut(userId, gone.kind, gone.machineId, gone.pub, sessions.get(gone.pub))
  logger.info('device key log appended', { userId, seq: entry.seq, op: entry.op, kind: entry.kind })
  return { ok: true, head }
}

/**
 * A removed key is banned from the log for good, which is what keeps it out. Signing the device out is
 * on top of that, where the backend can: a machine is told to drop its sign-in (the same frame a deleted
 * machine gets), a phone signed in by a QR loses its session. An Autonomous sign-in is not ours to end.
 */
async function signOut(userId: string, kind: string, machineId: string, pubKey: string, sessionId: string | undefined): Promise<void> {
  try {
    if (kind === 'machine' && machineId) {
      // Named, so the machine knows its KEY is gone (not just its sign-in) and signs in again with a new
      // one; a daemon that predates the log reads only the type, as for a deleted machine.
      await publishDown(machineId, { connId: '', frame: { type: 'machine_revoked', payload: { reason: 'device_removed', pub: pubKey } } })
    } else if (sessionId) {
      await prisma.harnessSession.updateMany({ where: { id: sessionId, userId, OR: [{ revokedAt: null }, { revokedAt: { isSet: false } }] }, data: { revokedAt: new Date() } })
    }
  } catch (err) {
    logger.warn('device key removal sign-out failed', { userId, kind, error: String(err) })
  }
}

// ── when each key was last seen ────────────────────────────────────────────────────────────────────
// A viewer app whose browser data was cleared never signs its own removal: its key stays active in
// the log, unused, forever. The Devices list offers to remove the ones not seen in a long while, and
// this is what "seen" means: the key opened an E2EE session (`e2e_hello` carries it in the clear, on
// its way to a machine). Only a hint for that list — nothing trusts or distrusts a key by it — so a
// client claiming someone else's key here can at most keep that one off the suggestion.

const SEEN_TTL_SEC = 400 * 24 * 60 * 60
/** One write per key per this long, per process: a phone opens a session per machine it shows. */
const SEEN_WRITE_EVERY_MS = 60 * 60 * 1000
const SEEN_MEMORY_MAX = 10_000
const seenWritten = new Map<string, number>()
const seenKey = (userId: string): string => `devkeys:seen:${userId}`
const PUB_RE = /^[A-Za-z0-9+/]{43}=$/

export function touchDeviceKey(userId: string, pubKey: unknown, now = Date.now()): void {
  if (typeof pubKey !== 'string' || !PUB_RE.test(pubKey)) return
  const memo = `${userId}:${pubKey}`
  const last = seenWritten.get(memo)
  if (last !== undefined && now - last < SEEN_WRITE_EVERY_MS) return
  if (seenWritten.size >= SEEN_MEMORY_MAX) seenWritten.clear()
  seenWritten.set(memo, now)
  void pub.multi().hset(seenKey(userId), pubKey, String(now)).expire(seenKey(userId), SEEN_TTL_SEC).exec()
    .catch(() => { seenWritten.delete(memo) })
}

/** When each of the account's keys was last seen, by pub (ms). Empty when nothing was recorded. */
export async function deviceKeysSeen(userId: string): Promise<Record<string, number>> {
  const raw = await pub.hgetall(seenKey(userId))
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw ?? {})) {
    const n = Number(v)
    if (PUB_RE.test(k) && Number.isSafeInteger(n) && n > 0) out[k] = n
  }
  return out
}
