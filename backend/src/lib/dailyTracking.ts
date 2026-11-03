/** Relay signals contribute daily fleet totals and, while sharing is on, a person's 10-day activity
 * mark (lib/productUsage.ts markActivity). Operational live presence stays in Redis.
 * No machine, agent or device history is written here: the one machine fact kept is the overwritten
 * `machines.lastSeenAt`. Older row types remain readable during their bounded expiry window; their
 * historical metrics must not be mixed with these totals.
 */
import { utcDayKey } from '../types/analytics.js'
import { releaseBucket } from '../types/productHealthContract.js'
import { markActivity, recordRelayUsage, type RelayUsageMetric } from './productUsage.js'
import { prisma } from './prisma.js'

export interface PresenceTouchOpts { isNewConnection: boolean; countryCode?: string }

export async function touchUserOnlineDay(userId: string, _machineId: string, now: Date, opts: { isNewConnection: boolean }): Promise<void> {
  // The person is active today whether this is an open or a ping; only opens add a relay total.
  void markActivity(userId, now, { surface: 'desktop' }).catch(() => {})
  if (opts.isNewConnection) await recordRelayUsage(userId, now, 'relay_desktop_opens')
}
export async function recordRemoteUsage(userId: string, _machineId: string, now: Date): Promise<void> {
  await recordRelayUsage(userId, now, 'relay_remote_sessions')
}
export async function touchDeviceOnlineDay(userId: string, _deviceId: string, now: Date, opts: PresenceTouchOpts): Promise<void> {
  if (opts.isNewConnection) await recordRelayUsage(userId, now, 'relay_device_connections')
}
/** Stamps the machine's own `lastSeenAt` on every call — the caller floors heartbeats — and counts a connect.
 *  Both writes start together, so a failed total never costs the stamp; either failure rejects, so the
 *  caller's floor does not advance and its next heartbeat retries. */
export async function touchMachineOnlineDay(userId: string, machineId: string, now: Date, opts: PresenceTouchOpts): Promise<void> {
  await Promise.all([
    prisma.machine.update({ where: { machineId }, data: { lastSeenAt: now } }),
    opts.isNewConnection ? recordRelayUsage(userId, now, 'relay_machine_connections') : undefined,
  ])
}
export async function recordTurnStarted(userId: string, _machineId: string, _agentId: string, now: Date): Promise<void> {
  void markActivity(userId, now, { worked: true }).catch(() => {})
  await recordRelayUsage(userId, now, 'relay_turns_started')
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

/** Relay surfaces with separate connection totals, never distinct-person counts. */
export type ClientSurface = 'tui' | 'harness-os' | 'harness-os-pi' | 'mobile' | 'web'
export const CLIENT_SURFACES: ReadonlySet<string> = new Set<ClientSurface>(['tui', 'harness-os', 'harness-os-pi', 'mobile', 'web'])
/** Known terminal surfaces retain their platform distinction in fleet connection totals. */
export const TUI_SURFACES: ReadonlySet<string> = new Set<ClientSurface>(['tui', 'harness-os', 'harness-os-pi'])

/** What the phone says of the build that opened a socket (`?release=` and `?debug=1`, webWs.ts). */
export interface ClientBuild { release?: string | null; debug?: boolean }

/** What a phone open adds beside `relay_mobile_opens`, which still counts every one of them: a debug or
 *  simulator build's open under `relay_mobile_debug_opens`, any other under its release's margin, the way
 *  phone reports split by release (`breakdown:release:phone:<release>:`). The release is the public
 *  x.y.z only; an older app that sends none, or anything else, is `unknown`. The two never overlap, so a
 *  simulator left open cannot pass for a release. */
export function mobileOpenMetrics(build: ClientBuild = {}): RelayUsageMetric[] {
  return [build.debug === true ? 'relay_mobile_debug_opens'
    : `breakdown:release:phone:${releaseBucket(build.release)}:relay_mobile_opens`]
}

/** Keep old protocol entry points while reducing only new connection events into fleet totals. */
export async function touchClientOnlineDay(
  userId: string, surface: ClientSurface, now: Date, opts: { isNewConnection: boolean; build?: ClientBuild },
): Promise<void> {
  void markActivity(userId, now, { surface }).catch(() => {})
  if (!opts.isNewConnection) return
  if (surface === 'mobile') await recordRelayUsage(userId, now, 'relay_mobile_opens', mobileOpenMetrics(opts.build))
  else await recordRelayUsage(userId, now, `relay_${surface}_opens`)
}

/**
 * The legacy protocol's cadence: `open` counts an event at most once per `openFloorMs`, so a reconnect
 * storm is not a hundred sessions. `ping` is still throttled but its callback no longer stores history.
 * `write` gets `isNewConnection`; failures go to `onError` — callers never await this.
 */
export function presenceTracker(
  write: (now: Date, isNewConnection: boolean) => Promise<void>,
  onError: (kind: 'open' | 'ping', err: unknown) => void,
  { pingFloorMs, openFloorMs }: { pingFloorMs: number; openFloorMs: number },
): (kind: 'open' | 'ping') => void {
  const last: PresenceWriteState = { dayKey: null, wroteAt: 0 }
  let inFlight = false
  let lastOpenAt = 0
  return (kind) => {
    const now = new Date()
    if (kind === 'ping' && (inFlight || !presenceWriteDue(last, now, pingFloorMs))) return
    if (kind === 'open') {
      if (now.getTime() - lastOpenAt < openFloorMs) return
      lastOpenAt = now.getTime()
    }
    inFlight = true
    write(now, kind === 'open')
      .then(() => { last.dayKey = utcDayKey(now); last.wroteAt = now.getTime() })
      .catch((err) => onError(kind, err))
      .finally(() => { inFlight = false })
  }
}
