/**
 * Presence / remote-usage daily tracking — write path for `UserDailyPresence`,
 * `UserDailyRemoteUsage`, `UserDailyDevicePresence`, `MachineDailyPresence` and
 * `AgentDailyPresence` (prisma/schema.prisma). Separate model family and separate module from the
 * opt-in `Analytics*` telemetry in analyticsIngest.ts: these signals are derived directly from the
 * device-ws/adapter-ws relays (src/lib/deviceWs.ts, src/lib/adapterWs.ts) plus the p2p_offer tap on
 * web-ws (src/lib/webWs.ts), not from a collector upload.
 *
 * Unlike analyticsIngest.ts, none of these rows need last-write-wins ordering (there's no
 * client-supplied revision to defend against), so each touch is a plain atomic `upsert` on the
 * day's unique key — no separate create-then-swallow-P2002 step that could drop a concurrent
 * write's `lastSeenAt`/counter increment.
 *
 * All entry points are meant to be called fire-and-forget from the hot path (connection open,
 * heartbeat/ping, p2p_offer) — callers must not await them inline.
 *
 * `countryCode` on the device and machine touches is Cloudflare's `CF-IPCountry` read at the WS
 * upgrade (lib/clientGeo.ts). It is last-write-wins within the day and only ever SET, never cleared:
 * a touch without one (local dev, a relay not fronted by Cloudflare) leaves whatever the row has.
 * `touchUserOnlineDay` takes none on purpose — its socket belongs to the daemon, not the person
 * (see the model doc in schema.prisma); the person's country is `User.lastCountryCode`.
 */
import { prisma } from './prisma.js'
import { utcDayKey, utcDayStart } from '../types/analytics.js'

/** Options for the device/machine presence touches. */
export interface PresenceTouchOpts {
  isNewConnection: boolean
  /** ISO-2 from `CF-IPCountry` at the upgrade; omit when unknown (see module doc). */
  countryCode?: string
}

/**
 * Mark a user online, on `machineId`, for the UTC day containing `now`. The signal is the `harness`
 * daemon's `app_presence` frame over adapter-ws (src/lib/adapterWs.ts), sent about its own loopback
 * clients: `isNewConnection: true` when a desktop window just attached to the daemon (bumps
 * `connections`), `false` for the periodic ping while one stays attached (just touches `lastSeenAt`,
 * at most every USER_PRESENCE_WRITE_MS). Not the web-ws upgrade — the app never dials that itself.
 *
 * One row per (user, machine, day): a person with the app open on two computers gets two rows that
 * day, so "users online on day X" is a distinct count of `userId`, never a row count.
 *
 * `connections` counts app sessions OPENED on that day: a touch that is the first write of a new
 * UTC day but is not an open (a session spanning midnight) creates the row with `connections: 0`,
 * so summing the column across days never double-counts one long session. Same rule for every
 * `touch*OnlineDay` below.
 */
export async function touchUserOnlineDay(
  userId: string,
  machineId: string,
  now: Date,
  opts: { isNewConnection: boolean },
): Promise<void> {
  const dayUtc = utcDayStart(now)
  await prisma.userDailyPresence.upsert({
    where: { userId_machineId_dayUtc: { userId, machineId, dayUtc } },
    create: { userId, machineId, dayUtc, connections: opts.isNewConnection ? 1 : 0, firstSeenAt: now, lastSeenAt: now },
    update: {
      lastSeenAt: now,
      ...(opts.isNewConnection ? { connections: { increment: 1 } } : {}),
    },
  })
}

/**
 * Record that a user actually established a remote p2p connection (a `p2p_offer` frame passed
 * through the relay) to `machineId` on the UTC day containing `now`.
 */
export async function recordRemoteUsage(userId: string, machineId: string, now: Date): Promise<void> {
  const dayUtc = utcDayStart(now)
  await prisma.userDailyRemoteUsage.upsert({
    where: { userId_machineId_dayUtc: { userId, machineId, dayUtc } },
    create: { userId, machineId, dayUtc, sessions: 1, firstSeenAt: now, lastSeenAt: now },
    update: { lastSeenAt: now, sessions: { increment: 1 } },
  })
}

/**
 * Mark a user's device online for the UTC day containing `now`, mirroring `touchUserOnlineDay`
 * for the device-ws relay (src/lib/deviceWs.ts) instead of web-ws.
 */
export async function touchDeviceOnlineDay(
  userId: string,
  deviceId: string,
  now: Date,
  opts: PresenceTouchOpts,
): Promise<void> {
  const dayUtc = utcDayStart(now)
  await prisma.userDailyDevicePresence.upsert({
    where: { userId_deviceId_dayUtc: { userId, deviceId, dayUtc } },
    create: { userId, deviceId, dayUtc, connections: opts.isNewConnection ? 1 : 0, firstSeenAt: now, lastSeenAt: now, ...(opts.countryCode ? { countryCode: opts.countryCode } : {}) },
    update: {
      lastSeenAt: now,
      ...(opts.isNewConnection ? { connections: { increment: 1 } } : {}),
      ...(opts.countryCode ? { countryCode: opts.countryCode } : {}),
    },
  })
}

/**
 * Mark a machine's `harness` daemon online for the UTC day containing `now`, mirroring
 * `touchUserOnlineDay` for the adapter-ws relay (src/lib/adapterWs.ts). `userId` is the owner at
 * connect time, denormalized so per-user rollups need no join through `machines`.
 */
export async function touchMachineOnlineDay(
  userId: string,
  machineId: string,
  now: Date,
  opts: PresenceTouchOpts,
): Promise<void> {
  const dayUtc = utcDayStart(now)
  await prisma.machineDailyPresence.upsert({
    where: { machineId_dayUtc: { machineId, dayUtc } },
    create: { machineId, userId, dayUtc, connections: opts.isNewConnection ? 1 : 0, firstSeenAt: now, lastSeenAt: now, ...(opts.countryCode ? { countryCode: opts.countryCode } : {}) },
    update: {
      lastSeenAt: now,
      ...(opts.isNewConnection ? { connections: { increment: 1 } } : {}),
      ...(opts.countryCode ? { countryCode: opts.countryCode } : {}),
    },
  })
}

/**
 * Count one `turn_started` the machine's daemon reported for `agentId` on the UTC day containing
 * `now`: bumps the machine row's `turnsStarted` and the (machine, agent) row. Both also touch
 * `lastSeenAt` — a turn is the strongest liveness signal there is. The two upserts are independent
 * atomic `$inc`s, deliberately not a transaction: a partial failure under-counts one row by one and
 * the caller's warn log says so, which beats a transaction retry loop on the relay's hot path.
 */
export async function recordTurnStarted(
  userId: string,
  machineId: string,
  agentId: string,
  now: Date,
): Promise<void> {
  const dayUtc = utcDayStart(now)
  await Promise.all([
    prisma.machineDailyPresence.upsert({
      where: { machineId_dayUtc: { machineId, dayUtc } },
      create: { machineId, userId, dayUtc, connections: 0, turnsStarted: 1, firstSeenAt: now, lastSeenAt: now },
      update: { lastSeenAt: now, turnsStarted: { increment: 1 } },
    }),
    prisma.agentDailyPresence.upsert({
      where: { machineId_agentId_dayUtc: { machineId, agentId, dayUtc } },
      create: { machineId, agentId, userId, dayUtc, turnsStarted: 1, firstSeenAt: now, lastSeenAt: now },
      update: { lastSeenAt: now, turnsStarted: { increment: 1 } },
    }),
  ])
}

/** Last SUCCESSFUL presence write for one open socket — `dayKey` null until the first one lands. */
export interface PresenceWriteState { dayKey: string | null; wroteAt: number }

/**
 * Whether a heartbeat on an open socket should write presence now: yes when nothing has been
 * written yet, when the UTC day rolled over since the last write (so the new day gets its row),
 * or when the last write is at least `minIntervalMs` old. Lets a caller ride an existing
 * high-frequency tick (15s node heartbeat) without writing Mongo at that rate.
 */
export function presenceWriteDue(last: PresenceWriteState, now: Date, minIntervalMs: number): boolean {
  if (last.dayKey === null) return true
  if (utcDayKey(now) !== last.dayKey) return true
  return now.getTime() - last.wroteAt >= minIntervalMs
}
