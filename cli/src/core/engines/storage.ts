/** Captured storage reads; unavailable workers never turn an unknown background count into zero. */
import { errorKind } from '../../lib/log.js'
import type { BackgroundSession } from '../../lib/backgroundCommands.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { backgroundCount, STORAGE_BACKGROUND, STORAGE_BACKGROUND_WAIT_MS, STORAGE_CAPABILITIES,
  STORAGE_USER_ROW_SINCE, STORAGE_USER_ROW_WAIT_MS, storageTimeRange, storageSession, userRowAnswer,
  STORAGE_IN_FLIGHT, STORAGE_REPLY_BYTES, STORAGE_VERSION, STORAGE_EXPORT, STORAGE_EXPORT_WAIT_MS, STORAGE_ENGINES,
  STORAGE_LIFETIME, storageLifetime, exportReceipt, type ExportStage, type ExportReceipt, type ExportReservation,
  STORAGE_COMPARE, STORAGE_COMPARE_WAIT_MS, type SavedCheckpoint, type CheckpointReuse, type ExportResult,
  type StorageEngine, type StorageLifetime, type StorageSession, type ExportSource } from '../../engines/worker/storageProtocol.js'
import { createSnapshotTransport, type SnapshotTransportDeps } from './snapshotTransport.js'
import { boundedControl } from './controlTransport.js'

export interface EngineStorageDeps extends SnapshotTransportDeps {
  isolated: boolean
  serviceProcess?(service: string, pid: number, waitMs: number): Promise<boolean>
  ready?(engine: string, waitMs: number): Promise<void>
  inline?(session: StorageSession): Promise<number | null>
  inlineUserRowSince?(session: StorageSession, since: number, until: number): Promise<boolean | null>
  inlineExport?(engine: StorageEngine, session: StorageSession, stage: ExportStage, source: ExportSource, current: () => boolean): Promise<ExportReceipt>
  inlineCompare?(engine: StorageEngine, session: StorageSession, checkpoint: SavedCheckpoint, source: ExportSource, current: () => boolean): Promise<boolean | null>
}
export function createEngineStorage(deps: EngineStorageDeps) {
  let pending = 0
  const admitted = async <T>(work: () => Promise<T>): Promise<T> => {
    if (pending >= STORAGE_IN_FLIGHT) throw new Error('storage busy')
    pending++
    try { return await work() } finally { pending-- }
  }
  const transport = createSnapshotTransport(deps, { version: STORAGE_VERSION, capabilities: STORAGE_CAPABILITIES,
    capability: 'storage', inFlight: STORAGE_IN_FLIGHT, queued: 0, waitMs: STORAGE_BACKGROUND_WAIT_MS, replyBytes: STORAGE_REPLY_BYTES })
  const exports = createSnapshotTransport(deps, { version: STORAGE_VERSION, capabilities: STORAGE_CAPABILITIES,
    capability: 'storage', inFlight: STORAGE_IN_FLIGHT, queued: 0, waitMs: STORAGE_EXPORT_WAIT_MS, replyBytes: STORAGE_REPLY_BYTES })
  const userRows = createSnapshotTransport(deps, { version: STORAGE_VERSION, capabilities: STORAGE_CAPABILITIES,
    capability: 'storage', inFlight: STORAGE_IN_FLIGHT, queued: 0, waitMs: STORAGE_USER_ROW_WAIT_MS, replyBytes: STORAGE_REPLY_BYTES })
  const comparisons = createSnapshotTransport(deps, { version: STORAGE_VERSION, capabilities: STORAGE_CAPABILITIES,
    capability: 'storageCompare', inFlight: STORAGE_IN_FLIGHT, queued: 0, waitMs: STORAGE_COMPARE_WAIT_MS, replyBytes: STORAGE_REPLY_BYTES })
  return {
    connected: (service: string) => { transport.connected(service); exports.connected(service); userRows.connected(service); comparisons.connected(service) },
    disconnected: (service: string) => { transport.disconnected(service); exports.disconnected(service); userRows.disconnected(service); comparisons.disconnected(service) },
    async exportDatabase(session: RegisteredSession, source: ExportSource, reservation: ExportReservation, reuse?: CheckpointReuse): Promise<ExportResult> {
      if (!STORAGE_ENGINES.includes(session.engine as StorageEngine) || !session.sessionId) throw new Error('checkpoint engine unsupported')
      const captured: StorageSession = { sessionId: session.sessionId, hermesHome: session.hermesHome,
        openclawStateDir: session.openclawStateDir, pid: session.processIdentity?.pid ?? 0 }
      let active = true
      const deadline = reservation.deadline
      const current = () => active && performance.now() < deadline
      try {
        const receipt = await boundedControl(admitted(async () => {
          if (!current()) throw new Error('checkpoint unavailable')
          if (reuse) {
            let equal: boolean | null = null
            try {
              equal = deps.isolated
                ? await comparisons.read(session.engine, STORAGE_COMPARE, { session: captured, checkpoint: reuse.checkpoint, source }, userRowAnswer) as boolean | null
                : await boundedControl(Promise.resolve(deps.inlineCompare?.(session.engine as StorageEngine, captured, reuse.checkpoint, source, current) ?? null),
                  Math.max(0, Math.min(STORAGE_COMPARE_WAIT_MS, deadline - performance.now())), () => new Error('checkpoint comparison unavailable'))
            } catch (error) { console.error('[engine-others] STORAGE_COMPARE_UNAVAILABLE · ' + errorKind(error)) }
            if (!current()) throw new Error('checkpoint unavailable')
            // This callback verifies native authority separately from saved-file availability.
            if (equal === true && reuse.current()) return { unchanged: true as const }
          }
          let lifetime: StorageLifetime | undefined
          if (deps.isolated) {
            try { lifetime = await exports.read(session.engine, STORAGE_LIFETIME, {}, storageLifetime) as StorageLifetime }
            catch (error) {
              const code = (error as { code?: unknown } | null)?.code
              if (!deps.ready || (code !== 'ENGINE_UNAVAILABLE' && code !== 'ENGINE_STALE_REPLY')) throw error
              if (!current()) throw new Error('checkpoint unavailable')
              // A replacement may be starting after the engine exits. No writer has been assigned yet:
              // only this lifetime observation may repeat, within the stage's original deadline.
              await deps.ready(session.engine, Math.ceil(deadline - performance.now()))
              if (!current()) throw new Error('checkpoint unavailable')
              lifetime = await exports.read(session.engine, STORAGE_LIFETIME, {}, storageLifetime) as StorageLifetime
            }
            if (!current() || !await deps.serviceProcess?.('engine-others', lifetime.pid, Math.ceil(deadline - performance.now()))) throw new Error('checkpoint writer unavailable')
          }
          if (!current()) throw new Error('checkpoint unavailable')
          const ownership = await reservation.acquire(lifetime?.pid ?? process.pid)
          if (!current()) throw new Error('checkpoint unavailable')
          const exported = deps.isolated
            ? await exports.read(session.engine, STORAGE_EXPORT, { session: captured, stage: ownership.stage, source, lifetime }, exportReceipt) as ExportReceipt
            : await deps.inlineExport?.(session.engine as StorageEngine, captured, ownership.stage, source, current)
          if (!current() || !exportReceipt(exported)) throw new Error('checkpoint unavailable')
          await ownership.settled()
          if (!current()) throw new Error('checkpoint unavailable')
          return exported
        }), Math.max(0, Math.ceil(deadline - performance.now())), () => new Error('checkpoint unavailable'))
        if (!current() || (!('unchanged' in receipt) && !exportReceipt(receipt))) throw new Error('checkpoint unavailable')
        return receipt
      } finally { active = false }
    },
    async userRowSince(session: StorageSession, since: number, until = Number.MAX_SAFE_INTEGER): Promise<boolean | null> {
      if (!storageSession(session) || !storageTimeRange(since, until)) return null
      const captured: StorageSession = { ...session }
      try {
        const answer = deps.isolated
          ? await admitted(async () => await userRows.read('openclaw', STORAGE_USER_ROW_SINCE, { session: captured, since, until }, userRowAnswer))
          : await boundedControl(admitted(async () => deps.inlineUserRowSince?.(captured, since, until) ?? null),
            STORAGE_USER_ROW_WAIT_MS, () => new Error('storage unavailable'))
        return userRowAnswer(answer) ? answer : null
      } catch (error) { console.error('[engine-others] STORAGE_USER_ROW_UNAVAILABLE · ' + errorKind(error)); return null }
    },
    async background(session: BackgroundSession): Promise<number | null> {
      if (session.engine !== 'hermes' || !session.sessionId) return null
      const captured: StorageSession = { sessionId: session.sessionId, hermesHome: session.hermesHome }
      try {
        if (!deps.isolated) return await boundedControl(admitted(async () => deps.inline?.(captured) ?? null),
          STORAGE_BACKGROUND_WAIT_MS, () => new Error('storage unavailable'))
        return await admitted(async () => await transport.read('hermes', STORAGE_BACKGROUND, { session: captured }, backgroundCount) as number | null)
      } catch (caughtFailure) { console.error(('[engine-others] STORAGE_BACKGROUND_UNAVAILABLE') + ' · ' + errorKind(caughtFailure)); return null }
    },
  }
}
