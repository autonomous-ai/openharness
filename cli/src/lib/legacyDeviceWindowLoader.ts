/** Bounded first-use transport for supported old Desktop frames. Interpretation stays behind the lazy door. */
import { errorKind } from './log.js'
import type { createLegacyDeviceWindowState, LegacyDeviceWindowHooks } from './legacyDeviceWindowState.js'

type Owner = ReturnType<typeof createLegacyDeviceWindowState>
type Frame = { type: string; payload?: unknown }
type Pending = { rows: Array<{ connection: string; bytes: Buffer; tab: boolean }>; bytes: number; timer?: ReturnType<typeof setTimeout> }
const MAX_FRAMES = 128
const MAX_BYTES = 8 * 1024 * 1024
const LOAD_MS = 5000

export function createLegacyDeviceWindowLoader(deps: {
  hooks: LegacyDeviceWindowHooks
  live(connection: string): boolean
  pending(connection: string, value: boolean): void
  refused(connection: string, reason: string): void
  log?(line: string): void
  load?: () => Promise<{ createLegacyDeviceWindowState: typeof createLegacyDeviceWindowState }>
}) {
  const load = deps.load ?? (() => import('./legacyDeviceWindowState.js'))
  const log = deps.log ?? console.warn
  let owner: Owner | undefined, pending: Pending | undefined
  let attempts = 0, stopped = false
  const heldTabs = new Set<string>(), failedTabs = new Set<string>()
  const release = (connection: string): void => {
    failedTabs.delete(connection)
    if (heldTabs.delete(connection)) deps.pending(connection, false)
  }
  const refuse = (connection: string, reason: string): void => {
    if (!deps.live(connection)) return
    try { deps.refused(connection, reason) }
    catch (caughtFailure) { log(('[local-ws] LEGACY_DESK_REPLY_FAILED') + ' · ' + errorKind(caughtFailure)) }
  }
  const closed = (connection: string): void => {
    try { owner?.closed(connection) }
    catch (caughtFailure) { log(('[local-ws] LEGACY_DESK_CLOSE_FAILED') + ' · ' + errorKind(caughtFailure)); refuse(connection, 'LEGACY_DESK_CLOSE_FAILED') }
    finally { release(connection) }
  }
  const fail = (own: Pending, reason: string, extra?: string): void => {
    if (pending !== own) return
    pending = undefined
    clearTimeout(own.timer)
    const affected = new Set(own.rows.map(row => row.connection))
    for (const row of own.rows) if (row.tab && deps.live(row.connection)) failedTabs.add(row.connection)
    own.rows = []; own.bytes = 0
    if (extra !== undefined) affected.add(extra)
    log(`[local-ws] ${reason}`)
    for (const connection of affected) refuse(connection, reason)
  }
  const deliver = (connection: string, frame: Frame, bytes: number): void => {
    try {
      const accepted = owner!.receive(connection, frame.type, frame.payload as Record<string, unknown> | undefined, bytes)
      if (frame.type === 'app_swarms' && (accepted || !failedTabs.has(connection))) release(connection)
    } catch (caughtFailure) {
      if (frame.type === 'app_swarms') {
        failedTabs.add(connection)
        if (!heldTabs.has(connection)) { heldTabs.add(connection); deps.pending(connection, true) }
      }
      const kind = errorKind(caughtFailure)
      log(('[local-ws] LEGACY_DESK_DELIVERY_FAILED') + ' · ' + kind)
      // A new steady-state ceiling must not cause old clients to reconnect and resend indefinitely.
      if (kind !== 'LEGACY_DESK_STATE_LIMIT') refuse(connection, 'LEGACY_DESK_DELIVERY_FAILED')
    } finally {
      if (!deps.live(connection)) closed(connection)
    }
  }
  const begin = (): Pending => {
    const own: Pending = { rows: [], bytes: 0 }
    pending = own; attempts++
    own.timer = setTimeout(() => fail(own, 'LEGACY_DESK_LOAD_TIMEOUT'), LOAD_MS).unref()
    // Promise composition contains synchronous import-provider failures too; it never enters terminal's chain.
    void Promise.resolve().then(load).then(module => {
      if (stopped || pending !== own) return
      try { owner = module.createLegacyDeviceWindowState(deps.hooks) }
      catch { fail(own, 'LEGACY_DESK_LOAD_FAILED'); return }
      pending = undefined; clearTimeout(own.timer)
      const rows = own.rows; own.rows = []; own.bytes = 0
      for (const row of rows) {
        let frame: Frame
        try {
          const decoded: unknown = JSON.parse(row.bytes.toString('utf8'))
          if (!decoded || typeof decoded !== 'object' || typeof (decoded as Frame).type !== 'string') throw new Error('invalid frame')
          frame = decoded as Frame
        }
        catch (caughtFailure) {
          if (row.tab && deps.live(row.connection)) failedTabs.add(row.connection)
          log(('[local-ws] LEGACY_DESK_FRAME_INVALID') + ' · ' + errorKind(caughtFailure)); refuse(row.connection, 'LEGACY_DESK_FRAME_INVALID')
          if (!deps.live(row.connection)) release(row.connection)
          continue
        }
        deliver(row.connection, frame, row.bytes.byteLength)
      }
    }, () => fail(own, 'LEGACY_DESK_LOAD_FAILED'))
    return own
  }
  return {
    receive(connection: string, frame: Frame, bytes: Uint8Array): void {
      if (stopped) return
      if (owner) { deliver(connection, frame, bytes.byteLength); return }
      const tab = frame.type === 'app_swarms'
      if (tab && !heldTabs.has(connection)) { heldTabs.add(connection); deps.pending(connection, true) }
      if (!pending && attempts === 2) {
        if (tab) failedTabs.add(connection)
        refuse(connection, 'LEGACY_DESK_LOAD_FAILED'); return
      }
      const own = pending ?? begin()
      if (own.rows.length === MAX_FRAMES || bytes.byteLength > MAX_BYTES - own.bytes) {
        if (tab) failedTabs.add(connection)
        fail(own, 'LEGACY_DESK_LOAD_LIMIT', connection); return
      }
      own.rows.push({ connection, bytes: Buffer.from(bytes), tab }); own.bytes += bytes.byteLength
    },
    closed,
    snapshot() { return owner?.snapshot() },
    stop(): void {
      if (stopped) return
      stopped = true
      if (pending) { clearTimeout(pending.timer); pending.rows = []; pending.bytes = 0; pending = undefined }
      // Stopping interpretation does not prove a still-connected window has no open tabs.
      // Physical close remains responsible for releasing its cleanup hold.
    },
  }
}
