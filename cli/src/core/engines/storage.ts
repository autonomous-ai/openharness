/** Captured storage reads; unavailable workers never turn an unknown background count into zero. */
import { errorKind } from '../../lib/log.js'
import type { BackgroundSession } from '../../lib/backgroundCommands.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { backgroundCount, STORAGE_BACKGROUND, STORAGE_BACKGROUND_WAIT_MS, STORAGE_CAPABILITIES,
  STORAGE_IN_FLIGHT, STORAGE_REPLY_BYTES, STORAGE_VERSION, STORAGE_EXPORT, STORAGE_EXPORT_WAIT_MS, STORAGE_ENGINES,
  STORAGE_LIFETIME, storageLifetime, exportReceipt, type ExportStage, type ExportReceipt, type ExportOwnership,
  type StorageEngine, type StorageLifetime, type StorageSession, type ExportSource } from '../../engines/worker/storageProtocol.js'
import { createSnapshotTransport, type SnapshotTransportDeps } from './snapshotTransport.js'
import { boundedControl } from './controlTransport.js'

export interface EngineStorageDeps extends SnapshotTransportDeps {
  isolated: boolean
  serviceProcess?(service: string, pid: number, waitMs: number): Promise<boolean>
  ready?(engine: string, waitMs: number): Promise<void>
  inline?(session: StorageSession): Promise<number | null>
  inlineExport?(engine: StorageEngine, session: StorageSession, stage: ExportStage, source: ExportSource, current: () => boolean): Promise<ExportReceipt>
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
  return {
    connected: (service: string) => { transport.connected(service); exports.connected(service) },
    disconnected: (service: string) => { transport.disconnected(service); exports.disconnected(service) },
    async exportDatabase(session: RegisteredSession, stage: ExportStage, ownership: ExportOwnership, source: ExportSource): Promise<ExportReceipt> {
      if (!STORAGE_ENGINES.includes(session.engine as StorageEngine) || !session.sessionId) throw new Error('checkpoint engine unsupported')
      const captured: StorageSession = { sessionId: session.sessionId, hermesHome: session.hermesHome,
        openclawStateDir: session.openclawStateDir, pid: session.processIdentity?.pid ?? 0 }
      let active = true
      const deadline = ownership.deadline
      const current = () => active && performance.now() < deadline
      try {
        const receipt = await boundedControl(admitted(async () => {
          if (!current()) throw new Error('checkpoint unavailable')
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
          await ownership.writer(lifetime?.pid ?? process.pid)
          if (!current()) throw new Error('checkpoint unavailable')
          const exported = deps.isolated
            ? await exports.read(session.engine, STORAGE_EXPORT, { session: captured, stage, source, lifetime }, exportReceipt) as ExportReceipt
            : await deps.inlineExport?.(session.engine as StorageEngine, captured, stage, source, current)
          if (!current() || !exportReceipt(exported)) throw new Error('checkpoint unavailable')
          await ownership.settled()
          if (!current()) throw new Error('checkpoint unavailable')
          return exported
        }), Math.max(0, Math.ceil(deadline - performance.now())), () => new Error('checkpoint unavailable'))
        if (!current() || !exportReceipt(receipt)) throw new Error('checkpoint unavailable')
        return receipt
      } finally { active = false }
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
