/** Captured storage reads; unavailable workers never turn an unknown background count into zero. */
import type { BackgroundSession } from '../../lib/backgroundCommands.js'
import { backgroundCount, STORAGE_BACKGROUND, STORAGE_BACKGROUND_WAIT_MS, STORAGE_CAPABILITIES,
  STORAGE_IN_FLIGHT, STORAGE_REPLY_BYTES, STORAGE_VERSION, type StorageSession } from '../../engines/worker/storageProtocol.js'
import { createSnapshotTransport, type SnapshotTransportDeps } from './snapshotTransport.js'
import { boundedControl } from './controlTransport.js'

export interface EngineStorageDeps extends SnapshotTransportDeps {
  isolated: boolean
  inline?(session: StorageSession): Promise<number | null>
}
export function createEngineStorage(deps: EngineStorageDeps) {
  const transport = createSnapshotTransport(deps, { version: STORAGE_VERSION, capabilities: STORAGE_CAPABILITIES,
    capability: 'storage', inFlight: STORAGE_IN_FLIGHT, queued: 0, waitMs: STORAGE_BACKGROUND_WAIT_MS, replyBytes: STORAGE_REPLY_BYTES })
  return {
    connected: transport.connected,
    disconnected: transport.disconnected,
    async background(session: BackgroundSession): Promise<number | null> {
      if (session.engine !== 'hermes' || !session.sessionId) return null
      const captured: StorageSession = { sessionId: session.sessionId, hermesHome: session.hermesHome }
      try {
        if (!deps.isolated) return await boundedControl(Promise.resolve().then(() => deps.inline?.(captured) ?? null),
          STORAGE_BACKGROUND_WAIT_MS, () => new Error('storage unavailable'))
        return await transport.read('hermes', STORAGE_BACKGROUND, { session: captured }, backgroundCount) as number | null
      } catch { console.error('[engine-others] STORAGE_BACKGROUND_UNAVAILABLE'); return null }
    },
  }
}
